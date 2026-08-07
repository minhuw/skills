import { randomUUID } from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { decideJudge, decideReview } from "../skills/fire/scripts/round-policy.mjs";
import { compiledAssignmentEntry } from "../skills/fire/scripts/assignment-bundle.mjs";
import {
	buildGraph,
	projectStatuses,
	snapshotPlanFromGraph,
} from "../skills/plans/scripts/herder-plans.mjs";
import {
	recordRunConfiguration,
	recordUsageRecord,
} from "../skills/plans/scripts/execution-store.mjs";
import { GitDriver, gitValue, runCommand, type GateResult } from "./git-driver.ts";
import {
	MANAGER_PROTOCOL_VERSION,
	canonicalEventPayload,
	normalizeUsage,
	parseWorkerResult,
	sha256,
	type DispatchResult,
	type HostName,
	type ManagerAction,
	type ManagerReply,
	type ResolvedProfile,
	type TerminalEvent,
	type WorkerResult,
	type WorkerRole,
} from "./protocol.ts";
import { RunStore, type StoredAction, type StoredPlan, type StoredPlanSpec, type StoredRun } from "./run-store.ts";
import { lifecycleStatus, phaseForRole, readyPhaseForRole, roleForPhase, summarizeRun } from "./workflow.ts";

const RUNTIME_ROOT = path.dirname(fileURLToPath(import.meta.url));
const PLUGIN_ROOT = path.resolve(RUNTIME_ROOT, "..");
const PROFILE_REGISTRY = path.join(PLUGIN_ROOT, "agent-profiles/scripts/profile-registry.mjs");
const HELPER_ROOT = path.join(PLUGIN_ROOT, "skills/fire/scripts");

interface StartInput {
	mode: "fire" | "resume";
	repositoryRoot: string;
	planDirectory: string;
	planName?: string;
	host: HostName;
	profile?: string;
	maxParallel?: number;
	dashboardUrl?: string;
}

interface EventInput {
	eventId: string;
	kind: "dispatch_results" | "terminals" | "user_input";
	dispatchResults?: DispatchResult[];
	terminals?: TerminalEvent[];
	userInput?: string;
}

function validateStartInput(input: StartInput): void {
	if (!input || !["fire", "resume"].includes(input.mode)) throw new Error("Start mode must be fire or resume");
	if (!input.repositoryRoot || !input.planDirectory) throw new Error("Start requires repositoryRoot and planDirectory");
	if (!["codex", "claude", "pi"].includes(input.host)) throw new Error("Start host must be codex, claude, or pi");
	if (input.maxParallel !== undefined && (!Number.isSafeInteger(input.maxParallel) || input.maxParallel < 1 || input.maxParallel > 32)) {
		throw new Error("maxParallel must be 1 through 32");
	}
}

function validateEventInput(input: EventInput): void {
	if (!input || typeof input.eventId !== "string" || input.eventId.length === 0 || input.eventId.length > 200 || /[\r\n\0]/.test(input.eventId)) {
		throw new Error("Manager eventId must be a non-empty single-line identifier of at most 200 characters");
	}
	if (!["dispatch_results", "terminals", "user_input"].includes(input.kind)) throw new Error(`Unknown manager event kind: ${String(input.kind)}`);
	if (input.kind === "dispatch_results") {
		if (!Array.isArray(input.dispatchResults)) throw new Error("dispatch_results requires an array");
		const seen = new Set<string>();
		for (const result of input.dispatchResults) {
			if (!result || typeof result.actionId !== "string" || typeof result.accepted !== "boolean") throw new Error("Invalid dispatch result");
			if (seen.has(result.actionId)) throw new Error(`Duplicate dispatch result for ${result.actionId}`);
			seen.add(result.actionId);
			if (result.accepted && (typeof result.hostHandle !== "string" || result.hostHandle.length === 0)) throw new Error(`Accepted action ${result.actionId} has no host handle`);
		}
	}
	if (input.kind === "terminals") {
		if (!Array.isArray(input.terminals)) throw new Error("terminals requires an array");
		const seen = new Set<string>();
		for (const terminal of input.terminals) {
			if (!terminal || typeof terminal.actionId !== "string" || terminal.actionId.length === 0) throw new Error("Invalid terminal event");
			if (seen.has(terminal.actionId)) throw new Error(`Duplicate terminal event for ${terminal.actionId}`);
			seen.add(terminal.actionId);
		}
	}
	if (input.kind === "user_input" && (typeof input.userInput !== "string" || input.userInput.trim().length === 0)) {
		throw new Error("user_input requires non-empty text");
	}
}

function resolveProfile(host: HostName, requested?: string): ResolvedProfile {
	const args = [PROFILE_REGISTRY, "resolve", "--host", host, "--pretty"];
	if (requested) args.splice(args.length - 1, 0, "--profile", requested);
	const result = runCommand(process.execPath, args);
	return JSON.parse(result.stdout) as ResolvedProfile;
}

function boundProfile(run: StoredRun, store: RunStore): ResolvedProfile {
	const binding = store.getProfileBinding();
	if (!binding || binding.profile !== run.profileName || binding.profileSha256 !== run.profileSha256 || binding.host !== run.host) {
		throw new Error("SQLite profile binding does not match the manager run");
	}
	return {
		schema_version: 1,
		profile: binding.profile,
		profile_sha256: binding.profileSha256,
		host: binding.host,
		orchestrator: { model: "bound-by-host", effort: "bound-by-host" },
		roles: binding.roles,
	};
}

function safeName(value: string): string {
	return value.toLowerCase().replace(/[^a-z0-9_]+/g, "_").replace(/^_+|_+$/g, "").slice(0, 80);
}

function activeActions(store: RunStore, runId: string): StoredAction[] {
	return store.getActions(runId, ["proposed", "dispatched"]);
}

function assignedPlanIds(store: RunStore, runId: string): Set<string> {
	return new Set(activeActions(store, runId).map((action) => action.planId));
}

function workerMode(plan: StoredPlan, role: WorkerRole): ManagerAction["workerMode"] {
	if (plan.planId === "RUN") return "FINAL_AUDIT";
	if (role === "plan-implementer") return plan.round === 1 && plan.repair.length === 0 ? "INITIAL" : "GUIDED_REPAIR";
	if (role === "plan-reviewer") return plan.reviewPass === 0 ? "DISCOVERY" : "VERIFICATION";
	return "ADJUDICATE";
}

function attemptOrdinal(store: RunStore, runId: string, planId: string, role: string): number {
	return store.getActions(runId).filter((action) => action.planId === planId && action.role === role).length + 1;
}

function requiredRole(profile: ResolvedProfile, role: WorkerRole) {
	const mapping = profile.roles[role];
	if (!mapping) throw new Error(`Profile ${profile.profile} has no ${role} mapping`);
	return mapping;
}

function assignmentPrompt(input: {
	run: StoredRun;
	plan: StoredPlan;
	action: StoredAction;
	changedPaths: string[];
}): string {
	const { run, plan, action } = input;
	const repair = plan.repair.length ? plan.repair.join("\n") : "none";
	const findings = plan.findings.length ? plan.findings.join("\n") : "none";
	const gates = plan.gates.length ? JSON.stringify(plan.gates) : "none";
	return [
		"HERDER_MANAGER_WORKER_V1",
		`RUN_ID: ${run.runId}`,
		`ACTION_ID: ${action.actionId}`,
		`ATTEMPT_ID: ${action.attemptId}`,
		`ROLE: ${action.role}`,
		`ROLE_CONTRACT_PATH: ${path.join(PLUGIN_ROOT, "agents", `${action.role}.md`)}`,
		`PLAN: ${plan.planId}`,
		`GENERATION: generation-${plan.generation}`,
		`ROUND: ${plan.round}`,
		`MODE: ${action.workerMode}`,
		`REPOSITORY_WORKTREE: ${plan.worktree}`,
		`EXPECTED_BRANCH: ${plan.branch}`,
		`ASSIGNMENT_BUNDLE: ${plan.assignmentPath}`,
		`ASSIGNMENT_SHA256: ${plan.assignmentSha256}`,
		`GENERATION_BASE: ${plan.generationBase}`,
		`FROZEN_HEAD: ${plan.approvedHead ?? "none"}`,
		`FROZEN_TREE: ${plan.approvedTree ?? "none"}`,
		`CHANGED_PATHS: ${input.changedPaths.length ? input.changedPaths.join(", ") : "none"}`,
		`GATES: ${gates}`,
		"FINDING_LEDGER:",
		findings,
		"REPAIR_CONTRACT:",
		repair,
		...(run.host === "codex" ? [
			"CODEX_WORKTREE_MODE: The child session inherits the coordinator checkout as its process cwd. Do not read or edit there. Set every command workdir to REPOSITORY_WORKTREE, and give apply_patch an absolute path beneath REPOSITORY_WORKTREE.",
		] : []),
		...(plan.rebase ? [
			"ACTIVE_REBASE: exact preserved conflicted rebase verified by the Run Manager",
			`REBASE_ONTO: ${plan.rebase.onto}`,
			`CHECKPOINT_REF: ${plan.rebase.checkpointRef}`,
			"Resolve only the existing conflicts, stage the resolution, and complete it with git rebase --continue. Do not attach HEAD, move refs, abort, reset, clean, recreate the worktree, or rematerialize the assignment.",
		] : []),
		"",
		"Act only in the supplied worktree and return the exact envelope required by your installed role contract. Do not update plan lifecycle, integration, SQLite, refs, leases, or another worktree; the deterministic Herder Run Manager owns those operations.",
	].join("\n");
}

function resultOutcome(result: WorkerResult | null, terminal: TerminalEvent): string {
	if (terminal.interrupted) return "INTERRUPTED";
	if (!result) return "FAILED";
	if (result.kind === "implementer") return result.status;
	if (result.kind === "reviewer") return result.verdict;
	return result.decision;
}

function countBlocking(findings: string[]): number {
	return findings.filter((finding) => /\[BLOCKING\]/.test(finding) && /\[(?:P0|P1)\]/.test(finding)).length;
}

function runAssignmentPath(run: StoredRun): string {
	const relative = path.relative(run.repositoryRoot, run.planDirectory);
	return path.join(run.integrationWorktree, relative, ".herder", "run-assignment.json");
}

function persistLeaks(planDirectory: string, planId: string, leaks: string[]): void {
	if (leaks.length === 0) return;
	const leakDirectory = path.join(planDirectory, "leak");
	fs.mkdirSync(leakDirectory, { recursive: true, mode: 0o700 });
	if (fs.lstatSync(leakDirectory).isSymbolicLink()) throw new Error("Herder leak directory must not be a symlink");
	for (const [index, leak] of leaks.entries()) {
		const findingId = leak.match(/^\[([^\]]+)\]/)?.[1] || `leak-${index + 1}`;
		const title = leak.match(/(?:^|;)\s*title=([^;]+)/i)?.[1] || "deferred-finding";
		const slug = safeName(`${planId}-${findingId}-${title}`).toLowerCase() || `${planId}-leak-${index + 1}`;
		const destination = path.join(leakDirectory, `${slug}.md`);
		const body = `# Deferred finding ${findingId}\n\nSource plan: ${planId}\n\n${leak.trim()}\n`;
		if (fs.existsSync(destination)) {
			if (fs.readFileSync(destination, "utf8") !== body) throw new Error(`Leak record changed for ${destination}`);
			continue;
		}
		fs.writeFileSync(destination, body, { encoding: "utf8", mode: 0o600, flag: "wx" });
	}
}

export class HerderRunManager {
	readonly planDirectory: string;
	readonly store: RunStore;

	constructor(planDirectory: string) {
		this.planDirectory = fs.realpathSync(planDirectory);
		this.store = new RunStore(this.planDirectory);
	}

	close(): void {
		this.store.close();
	}

	private driver(run: StoredRun): GitDriver {
		return new GitDriver({
			repoRoot: run.repositoryRoot,
			planDirectory: run.planDirectory,
			planName: run.planName,
			helperRoot: HELPER_ROOT,
			worktreeRoot: path.dirname(run.integrationWorktree),
		});
	}

	private updatePlan(plan: StoredPlan, changes: Partial<Omit<StoredPlan, "runId" | "planId" | "updatedAt">>): StoredPlan {
		return this.store.putPlan({ ...plan, ...changes });
	}

	private specs(run: StoredRun): StoredPlanSpec[] {
		const specs = this.store.getPlanSpecs(run.runId);
		if (specs.length === 0) throw new Error("Run has no compiled plan specification; start a fresh run with the current Herder version");
		return specs;
	}

	private spec(run: StoredRun, planId: string): StoredPlanSpec {
		const spec = this.specs(run).find((candidate) => candidate.planId === planId);
		if (!spec) throw new Error(`Run specification has no plan ${planId}`);
		return spec;
	}

	private projectLifecycle(run: StoredRun): void {
		const plans = this.store.getPlans(run.runId);
		const runtime = new Map(plans.map((plan) => [plan.planId, plan]));
		projectStatuses(this.planDirectory, this.specs(run).map((spec) => {
			const plan = runtime.get(spec.planId) ?? null;
			const status = lifecycleStatus(spec, plan);
			const detail = plan?.phase === "BLOCKED" || plan?.phase === "NEEDS_INPUT"
				? plan.repair[0] || spec.initialStatusDetail
				: status === spec.initialStatus ? spec.initialStatusDetail : "";
			return { id: spec.planId, status, detail };
		}));
	}

	async start(input: StartInput): Promise<ManagerReply> {
		validateStartInput(input);
		const existing = this.store.getRun();
		if (existing) {
			if (input.mode === "fire") throw new Error(`Run ${existing.runId} already exists; use resume`);
			return this.resume(input);
		}
		if (input.mode === "resume") throw new Error("No deterministic Herder run is recorded; start a fresh run");
		const profile = resolveProfile(input.host, input.profile);
		const planName = input.planName || path.basename(this.planDirectory);
		const driver = new GitDriver({
			repoRoot: input.repositoryRoot,
			planDirectory: this.planDirectory,
			planName,
			helperRoot: HELPER_ROOT,
			host: input.host,
		});
		const graph = buildGraph(this.planDirectory);
		if (!graph.shapeReady) throw new Error("Herder plan graph is not shape-ready");
		if (graph.plans.length === 0) throw new Error("Herder plan graph is empty");
		const adopted = graph.plans.filter((plan: { status: string }) => ["IN PROGRESS", "DONE"].includes(plan.status));
		if (adopted.length > 0) {
			throw new Error(`Fresh deterministic runs cannot adopt prior execution state: ${adopted.map((plan: { id: string; status: string }) => `${plan.id}=${plan.status}`).join(", ")}`);
		}
		const unsupported = graph.plans.filter((plan: { status: string }) => !["TODO", "BLOCKED", "REJECTED"].includes(plan.status));
		if (unsupported.length > 0) throw new Error(`Unsupported initial lifecycle state: ${unsupported.map((plan: { id: string; status: string }) => `${plan.id}=${plan.status}`).join(", ")}`);
		const checkoutStateToken = await driver.captureCheckout();
		const baseCommit = gitValue(driver.repoRoot, "rev-parse", "HEAD");
		const namespace = driver.inspectNamespace("fire");
		if (!namespace.ok) throw new Error(`Herder namespace is unavailable: ${namespace.reason}`);
		recordRunConfiguration(this.planDirectory, {
			profile: profile.profile,
			profileSha256: profile.profile_sha256,
			host: profile.host,
			roles: profile.roles,
		});
		const runId = randomUUID();
		const specs = graph.plans.map((plan, ordinal: number) => {
			const snapshot = snapshotPlanFromGraph(graph, plan.id);
			return {
				runId,
				planId: plan.id,
				ordinal,
				title: plan.title,
				priority: plan.priority,
				effort: plan.effort,
				kind: plan.kind,
				dependencies: plan.dependencies,
				initialStatus: plan.status as StoredPlanSpec["initialStatus"],
				initialStatusDetail: plan.statusDetail,
				gateCommands: driver.extractGateCommands(snapshot.planText),
				planFile: path.basename(plan.file),
				assignment: compiledAssignmentEntry(snapshot),
			} satisfies StoredPlanSpec;
		});
		this.store.transaction(() => {
			this.store.createRun({
				runId,
				repositoryRoot: driver.repoRoot,
				planDirectory: this.planDirectory,
				planName,
				host: input.host,
				profileName: profile.profile,
				profileSha256: profile.profile_sha256,
				maxParallel: input.maxParallel ?? 5,
				status: "initializing",
				checkoutStateToken,
				baseCommit,
				integrationBranch: driver.integrationBranch,
				integrationWorktree: driver.integrationWorktree,
				dashboardUrl: input.dashboardUrl ?? null,
			});
			this.store.putPlanSpecs(specs);
		});
		try {
			driver.initializeFreshNamespace(baseCommit, specs.map((spec) => spec.assignment));
			this.store.updateRun({ status: "running", terminalDetail: null });
		} catch (error) {
			this.store.updateRun({ terminalDetail: `Initialization incomplete: ${(error as Error).message}` });
			throw error;
		}
		return this.reconcile(profile);
	}

	async resume(input: StartInput): Promise<ManagerReply> {
		const run = this.store.getRun();
		if (!run) throw new Error("No deterministic Herder run exists");
		if (fs.realpathSync(input.repositoryRoot) !== run.repositoryRoot) throw new Error("Resume repository does not match the recorded run");
		if (input.host !== run.host) throw new Error(`Resume host must remain ${run.host}`);
		if (input.planName && input.planName !== run.planName) throw new Error(`Resume plan name must remain ${run.planName}`);
		this.specs(run);
		const profile = resolveProfile(run.host, input.profile || run.profileName);
		if (profile.profile_sha256 !== run.profileSha256 || profile.profile !== run.profileName) {
			throw new Error(`Recorded profile ${run.profileName} no longer matches its immutable binding`);
		}
		if (input.maxParallel !== undefined && input.maxParallel !== run.maxParallel) {
			throw new Error(`Resume must preserve max parallel ${run.maxParallel}; received ${input.maxParallel}`);
		}
		const driver = this.driver(run);
		await driver.verifyCheckout(run.checkoutStateToken);
		if (run.status === "initializing") {
			driver.initializeFreshNamespace(run.baseCommit, this.specs(run).map((spec) => spec.assignment));
			this.store.updateRun({ status: "running", terminalDetail: null });
		} else {
			const namespace = driver.inspectNamespace("resume");
			if (!namespace.ok) throw new Error(`Cannot resume ambiguous Herder namespace: ${namespace.reason}`);
		}
		if (["failed", "stopped", "paused"].includes(run.status)) this.store.updateRun({ status: "running", terminalDetail: null });
		return this.reconcile(profile);
	}

	async event(input: EventInput): Promise<ManagerReply> {
		validateEventInput(input);
		const run = this.store.getRun();
		if (!run) throw new Error("No deterministic Herder run exists");
		const canonical = canonicalEventPayload(input);
		const previous = this.store.readEvent(input.eventId);
		if (previous) {
			if (previous.payloadSha256 !== canonical.sha256) throw new Error(`Event ${input.eventId} was replayed with different payload`);
			return this.reply();
		}
		const profile = boundProfile(run, this.store);
		let schedule = true;
		if (input.kind === "dispatch_results") schedule = !(await this.applyDispatchResults(input.dispatchResults ?? []));
		else if (input.kind === "terminals") await this.applyTerminals(input.terminals ?? []);
		else this.applyUserInput(input.userInput!, input.eventId);
		const reply = await this.reconcile(profile, { schedule });
		this.store.recordEvent(run.runId, input.eventId, input.kind, input);
		return reply;
	}

	private async applyDispatchResults(results: DispatchResult[]): Promise<boolean> {
		const run = this.store.getRun()!;
		let capacityRejected = false;
		for (const result of results) {
			const action = this.store.getAction(result.actionId);
			if (!action || action.runId !== run.runId) throw new Error(`Unknown dispatch action ${result.actionId}`);
			if (result.accepted) {
				if (!result.hostHandle) throw new Error(`Accepted action ${result.actionId} has no host handle`);
				this.store.markDispatched(result.actionId, result.hostHandle);
				continue;
			}
			this.store.markCancelled(result.actionId, { error: result.error || "dispatch rejected" });
			const plan = this.store.getPlan(run.runId, action.planId);
			if (plan) this.driver(run).release(plan.worktree, action.leaseReason);
			if (!/capacity|limit|slot|concurr/i.test(result.error || "")) {
				this.store.updateRun({ status: "paused", terminalDetail: `Dispatch rejected for ${action.agentType}: ${result.error || "unknown host error"}` });
			} else if (plan) {
				capacityRejected = true;
				this.updatePlan(plan, { phase: readyPhaseForRole(action.role) });
			}
		}
		if (capacityRejected && this.store.getActions(run.runId, ["dispatched"]).length === 0) {
			this.store.updateRun({ status: "paused", terminalDetail: "Host worker capacity is unavailable; resume when a child slot is free." });
		}
		return capacityRejected;
	}

	private async applyTerminals(terminals: TerminalEvent[]): Promise<void> {
		const run = this.store.getRun()!;
		const driver = this.driver(run);
		for (const terminal of [...terminals].sort((left, right) => left.actionId.localeCompare(right.actionId))) {
			const action = this.store.getAction(terminal.actionId);
			if (!action || action.runId !== run.runId) throw new Error(`Unknown terminal action ${terminal.actionId}`);
			if (action.state === "terminal") continue;
			if (action.state !== "dispatched") throw new Error(`Action ${terminal.actionId} is not dispatched`);
			if (terminal.hostHandle && action.hostHandle && terminal.hostHandle !== action.hostHandle) {
				throw new Error(`Terminal handle mismatch for ${terminal.actionId}`);
			}
			const plan = this.store.getPlan(run.runId, action.planId);
			if (!plan) throw new Error(`Action ${action.actionId} has no plan runtime record`);
			await driver.verifyCheckout(run.checkoutStateToken);
			const alreadyApplied = plan.phase !== phaseForRole(action.role as WorkerRole);
			const lease = driver.leaseReason(plan.worktree);
			if (lease !== action.leaseReason && !(alreadyApplied && lease === null)) throw new Error(`Lease mismatch for ${action.actionId}`);
			let parsed: WorkerResult | null = null;
			let parseError: string | null = null;
			if (!terminal.interrupted && terminal.response) {
				try { parsed = parseWorkerResult(action.role as WorkerRole, terminal.response); }
				catch (error) { parseError = (error as Error).message; }
			}
			const usage = normalizeUsage(parsed, terminal);
			if (!alreadyApplied) {
				if (terminal.interrupted) {
					const detail = terminal.error || "Worker transport was interrupted";
					if (action.role === "plan-implementer") this.retryImplementerTransport(run, plan, action, detail);
					else this.retryTransportOrPause(run, plan, action, detail);
				} else if (!parsed) {
					const detail = `Worker result was malformed: ${parseError || terminal.error || "missing response"}`;
					if (action.role === "plan-implementer") this.retryImplementerTransport(run, plan, action, detail);
					else this.retryTransportOrPause(run, plan, action, detail);
				} else if (parsed.kind === "implementer") {
					await this.finishImplementer(run, plan, parsed);
				} else if (parsed.kind === "reviewer") {
					await this.finishReviewer(run, plan, parsed);
				} else {
					await this.finishJudge(run, plan, parsed);
				}
			}
			recordUsageRecord(this.planDirectory, {
				plan: plan.planId,
				role: action.role,
				attempt: action.attemptId,
				model: action.model,
				effort: action.effort,
				outcome: resultOutcome(parsed, terminal),
				inputTokens: usage.inputTokens ?? "unknown",
				cachedInputTokens: usage.cachedInputTokens ?? "unknown",
				outputTokens: usage.outputTokens ?? "unknown",
				reasoningTokens: usage.reasoningTokens ?? "unknown",
				source: usage.source,
				round: action.round,
				generation: `generation-${action.generation}`,
				harness: run.host,
				serviceTier: action.serviceTier || undefined,
				startedAt: usage.startedAt,
				finishedAt: usage.finishedAt,
				durationMs: usage.durationMs,
			});
			driver.release(plan.worktree, action.leaseReason);
			this.store.markTerminal(action.actionId, parsed ?? { interrupted: terminal.interrupted, error: parseError || terminal.error });
			await driver.verifyCheckout(run.checkoutStateToken);
		}
	}

	private retryImplementerTransport(run: StoredRun, plan: StoredPlan, action: StoredAction, detail: string): void {
		const driver = this.driver(run);
		const mutationMayHaveOccurred = driver.worktreeHead(plan.worktree) !== plan.generationBase || Boolean(driver.worktreeStatus(plan.worktree));
		if (!mutationMayHaveOccurred) {
			this.retryTransportOrPause(run, plan, action, detail);
			return;
		}
		if (plan.round >= 6) {
				this.updatePlan(plan, { phase: "BLOCKED", repair: [detail] });
		} else this.updatePlan(plan, { phase: "READY_IMPLEMENTER", round: plan.round + 1, repair: [detail] });
	}

	private retryTransportOrPause(run: StoredRun, plan: StoredPlan, action: StoredAction, detail: string): void {
		const equivalentAttempts = this.store.getActions(run.runId).filter((candidate) =>
			candidate.planId === action.planId
			&& candidate.generation === action.generation
			&& candidate.round === action.round
			&& candidate.role === action.role
		).length;
		if (equivalentAttempts < 3) {
			this.updatePlan(plan, { phase: readyPhaseForRole(action.role), repair: [detail] });
			return;
		}
		const terminalDetail = `${action.role} transport failed ${equivalentAttempts} times for ${action.planId} generation ${action.generation} round ${action.round}: ${detail}`;
		this.updatePlan(plan, { phase: "NEEDS_INPUT", repair: [terminalDetail] });
		this.store.updateRun({ status: "needs_input", terminalDetail });
	}

	private async finishImplementer(run: StoredRun, plan: StoredPlan, result: Extract<WorkerResult, { kind: "implementer" }>): Promise<void> {
		const driver = this.driver(run);
		let failure: string | null = null;
		if (result.status !== "COMPLETE") failure = result.stoppedBecause || result.notes || `Implementer returned ${result.status}`;
		if (!failure) {
			try { driver.verifyAssignment(plan.worktree, plan.assignmentPath, plan.assignmentSha256); }
			catch (error) { failure = `Assignment or branch verification failed: ${(error as Error).message}`; }
		}
		if (!failure) {
			const status = driver.worktreeStatus(plan.worktree);
			if (status) failure = `Implementer left a dirty worktree: ${status.split(/\r?\n/).slice(0, 5).join("; ")}`;
		}
		const head = driver.worktreeHead(plan.worktree);
		const reviewBase = plan.rebase?.onto ?? plan.generationBase;
		if (!failure && head === reviewBase) failure = "Implementer produced no commit";
		const changedPaths = failure ? [] : driver.changedPaths(plan.worktree, reviewBase);
		if (!failure && changedPaths.length === 0) failure = "Implementer produced no changed paths";
		let gates: GateResult[] = [];
		if (!failure) {
			gates = driver.runGates(plan.planId, plan.worktree, this.spec(run, plan.planId).gateCommands);
			const failed = gates.find((gate) => !gate.ok);
			if (failed) failure = `Required gate failed: ${failed.command} (log ${failed.logPath})`;
		}
		if (failure) {
			if (plan.round >= 6) {
				this.updatePlan(plan, { phase: "BLOCKED", repair: [failure], gates });
			} else {
				this.updatePlan(plan, { phase: "READY_IMPLEMENTER", round: plan.round + 1, repair: [failure], gates });
			}
			return;
		}
		this.store.putPlan({
			...plan,
			phase: "READY_REVIEWER",
			gates,
			generationBase: reviewBase,
			approvedBase: reviewBase,
			approvedHead: head,
			approvedTree: driver.worktreeTree(plan.worktree),
			repair: result.discoveredPaths,
			rebase: null,
		});
	}

	private async finishReviewer(run: StoredRun, plan: StoredPlan, result: Extract<WorkerResult, { kind: "reviewer" }>): Promise<void> {
		const driver = this.driver(run);
		if (driver.worktreeHead(plan.worktree) !== plan.approvedHead || driver.worktreeTree(plan.worktree) !== plan.approvedTree || driver.worktreeStatus(plan.worktree)) {
			throw new Error(`Reviewer mutated frozen plan ${plan.planId}`);
		}
		const blockers = countBlocking(result.findings);
		const verdict = result.verdict === "REVISE" && blockers === 0 && result.scope === "PASS" ? "APPROVE" : result.verdict;
		if (plan.planId === "RUN") {
			if (verdict === "APPROVE" && result.scope === "PASS" && blockers === 0) {
				this.updatePlan(plan, { phase: "FINAL_APPROVED", reviewPass: plan.reviewPass + 1, findings: result.findings });
			} else {
				const detail = result.rationale || result.findings[0] || "Final cross-plan audit did not approve";
				this.updatePlan(plan, { phase: "NEEDS_INPUT", reviewPass: plan.reviewPass + 1, findings: result.findings, repair: [detail] });
				this.store.updateRun({ status: "needs_input", terminalDetail: detail });
			}
			return;
		}
		const decision = decideReview({ round: plan.round, verdict, scope: result.scope, openBlockers: blockers });
		const reviewed = { ...plan, reviewPass: plan.reviewPass + 1, findings: result.findings };
		if (decision.action === "READY_TO_INTEGRATE") {
			this.updatePlan(reviewed, { phase: "READY_TO_INTEGRATE", repair: [] });
		} else if (decision.action === "REPAIR_DIRECT") {
			this.updatePlan(reviewed, { phase: "READY_IMPLEMENTER", round: decision.nextRound!, repair: result.fixGuidance });
		} else if (decision.action === "JUDGE") {
			this.updatePlan(reviewed, { phase: "READY_JUDGE", repair: result.fixGuidance });
		} else {
			this.updatePlan(reviewed, { phase: "BLOCKED" });
		}
	}

	private async finishJudge(run: StoredRun, plan: StoredPlan, result: Extract<WorkerResult, { kind: "judge" }>): Promise<void> {
		const driver = this.driver(run);
		if (driver.worktreeHead(plan.worktree) !== plan.approvedHead || driver.worktreeTree(plan.worktree) !== plan.approvedTree || driver.worktreeStatus(plan.worktree)) {
			throw new Error(`Judge mutated frozen plan ${plan.planId}`);
		}
		persistLeaks(this.planDirectory, plan.planId, result.leaks);
		const decision = decideJudge({ round: plan.round, decision: result.decision });
		if (decision.action === "READY_TO_INTEGRATE") {
			this.updatePlan(plan, { phase: "READY_TO_INTEGRATE", findings: result.findings, repair: [] });
		} else if (decision.action === "REPAIR_GUIDED") {
			this.updatePlan(plan, { phase: "READY_IMPLEMENTER", round: decision.nextRound!, findings: result.findings, repair: result.repairContracts });
		} else if (decision.action === "NEEDS_INPUT") {
			this.updatePlan(plan, { phase: "NEEDS_INPUT", findings: result.findings, repair: result.question ? [result.question] : [] });
			this.store.updateRun({ status: "needs_input", terminalDetail: result.question || result.rationale });
		} else {
			this.updatePlan(plan, { phase: "BLOCKED", findings: result.findings });
		}
	}

	private applyUserInput(value: string, eventId: string): void {
		const run = this.store.getRun()!;
		const marker = `USER_INPUT [${eventId}]: ${value}`;
		if (run.status !== "needs_input") {
			if (this.store.getPlans(run.runId).some((plan) => plan.repair.includes(marker))) return;
			throw new Error("Run is not waiting for user input");
		}
		const plan = this.store.getPlans(run.runId).find((candidate) => candidate.phase === "NEEDS_INPUT");
		if (!plan) throw new Error("No plan is waiting for user input");
		this.updatePlan(plan, {
			phase: plan.planId === "RUN" ? "READY_REVIEWER" : "READY_JUDGE",
			repair: [...plan.repair, marker],
		});
		this.store.updateRun({ status: "running", terminalDetail: null });
	}

	private async reconcile(profile: ResolvedProfile, options: { schedule?: boolean } = {}): Promise<ManagerReply> {
		let run = this.store.getRun();
		if (!run) throw new Error("No deterministic Herder run exists");
		if (run.status !== "running") return this.reply();
		const driver = this.driver(run);
		await driver.verifyCheckout(run.checkoutStateToken);

		for (const plan of this.store.getPlans(run.runId).filter((candidate) => candidate.phase === "READY_TO_INTEGRATE").sort((a, b) => a.planId.localeCompare(b.planId))) {
			if (!plan.approvedBase || !plan.approvedHead) throw new Error(`Plan ${plan.planId} has no approved integration surface`);
			const integration = driver.integrate({
				planId: plan.planId,
				branch: plan.branch,
				worktree: plan.worktree,
				approvedBase: plan.approvedBase,
				approvedHead: plan.approvedHead,
				generation: plan.generation,
				checkpointOrdinal: plan.reviewPass || 1,
				gateCommands: this.spec(run, plan.planId).gateCommands,
			});
			if (integration.status === "conflict") {
				if (plan.round >= 6) {
					this.updatePlan(plan, { phase: "BLOCKED" });
				} else {
					if (!integration.checkpointRef || !integration.checkpoint || !integration.onto || !integration.detachedHead) {
						throw new Error(`Restack conflict for ${plan.planId} lacks sealed recovery evidence`);
					}
					this.updatePlan(plan, {
						phase: "READY_IMPLEMENTER",
						round: plan.round + 1,
						repair: [`Preserved conflicted rebase: checkpoint=${integration.checkpointRef}; onto=${integration.onto}; detached=${integration.detachedHead}`],
						rebase: {
							checkpointRef: integration.checkpointRef,
							checkpoint: integration.checkpoint,
							onto: integration.onto,
							detachedHead: integration.detachedHead,
						},
					});
				}
				break;
			}
			this.updatePlan(plan, { phase: "DONE", approvedHead: integration.head!, approvedTree: gitValue(plan.worktree, "rev-parse", "HEAD^{tree}"), rebase: null });
		}

		run = this.store.getRun()!;
		if (run.status !== "running") return this.reply();
		const current = this.store.getPlans(run.runId);
		const overview = summarizeRun(this.specs(run), current);
		if (overview.complete && activeActions(this.store, run.runId).length === 0) {
			const finalPlan = current.find((plan) => plan.planId === "RUN");
			if (finalPlan?.phase === "FINAL_APPROVED") {
				this.store.updateRun({ status: "complete", terminalDetail: "All plans integrated and final audit approved." });
				return this.reply();
			}
			if (!finalPlan) {
				const finalGates = this.specs(run).flatMap((spec) => driver.runGates(spec.planId, run.integrationWorktree, spec.gateCommands));
				const failedGate = finalGates.find((gate) => !gate.ok);
				if (failedGate) {
					this.store.updateRun({ status: "failed", terminalDetail: `Final integration gate failed: ${failedGate.command} (log ${failedGate.logPath})` });
					return this.reply();
				}
				const assignmentPath = runAssignmentPath(run);
				const bytes = fs.readFileSync(assignmentPath);
				const assignment = JSON.parse(bytes.toString("utf8")) as { snapshotSha256: string; assignment: { generationBase: string } };
				this.store.putPlan({
					runId: run.runId,
					planId: "RUN",
					generation: 1,
					round: 1,
					phase: "READY_REVIEWER",
					branch: run.integrationBranch,
					worktree: run.integrationWorktree,
					assignmentPath,
					assignmentSha256: sha256(bytes),
					snapshotSha256: assignment.snapshotSha256,
					generationBase: assignment.assignment.generationBase,
					reviewPass: 0,
					findings: [],
					repair: [],
					gates: finalGates,
					approvedBase: run.baseCommit,
					approvedHead: driver.branchHead(run.integrationBranch),
					approvedTree: gitValue(run.integrationWorktree, "rev-parse", "HEAD^{tree}"),
					rebase: null,
				});
			}
		}

		if (options.schedule !== false) await this.schedule(profile);
		const settled = summarizeRun(this.specs(run), this.store.getPlans(run.runId));
		if (activeActions(this.store, run.runId).length === 0 && settled.blocked.length > 0 && settled.ready.length === 0) {
			this.store.updateRun({ status: "failed", terminalDetail: `Blocked plans require recovery: ${settled.blocked.join(", ")}` });
		}
		await driver.verifyCheckout(run.checkoutStateToken);
		this.projectLifecycle(run);
		return this.reply();
	}

	private async schedule(profile: ResolvedProfile): Promise<void> {
		const run = this.store.getRun()!;
		const driver = this.driver(run);
		let occupied = activeActions(this.store, run.runId).length;
		const owned = assignedPlanIds(this.store, run.runId);
		const plans = this.store.getPlans(run.runId);
		for (const plan of plans.sort((a, b) => a.planId.localeCompare(b.planId))) {
			if (occupied >= run.maxParallel) break;
			if (owned.has(plan.planId)) continue;
			const role = roleForPhase(plan.phase);
			if (!role) continue;
			this.createAction(run, plan, role, profile, driver);
			occupied += 1;
			owned.add(plan.planId);
		}

		if (occupied >= run.maxParallel) return;
		const overview = summarizeRun(this.specs(run), this.store.getPlans(run.runId));
		for (const spec of overview.ready) {
			if (occupied >= run.maxParallel) break;
			const planId = spec.planId;
			if (this.store.getPlan(run.runId, planId)) continue;
			const execution = driver.ensurePlanWorktree(planId, spec.assignment);
			const plan = this.store.putPlan({
				runId: run.runId,
				planId,
				generation: 1,
				round: 1,
				phase: "READY_IMPLEMENTER",
				branch: execution.branch,
				worktree: execution.worktree,
				assignmentPath: execution.assignment.bundlePath,
				assignmentSha256: execution.assignment.bundleSha256,
				snapshotSha256: execution.assignment.snapshotSha256,
				generationBase: execution.assignment.generationBase,
				reviewPass: 0,
				findings: [],
				repair: [],
				gates: [],
				approvedBase: null,
				approvedHead: null,
				approvedTree: null,
				rebase: null,
			});
			this.createAction(run, plan, "plan-implementer", profile, driver);
			occupied += 1;
		}
	}

	private createAction(run: StoredRun, plan: StoredPlan, role: WorkerRole, profile: ResolvedProfile, driver: GitDriver): StoredAction {
		const mapping = requiredRole(profile, role);
		const ordinal = attemptOrdinal(this.store, run.runId, plan.planId, role);
		const attemptId = `${plan.planId}-g${plan.generation}-r${plan.round}-${role.replace("plan-", "")}-${ordinal}`;
		const actionId = `${run.runId}:${attemptId}`;
		const taskName = safeName(`herder-${plan.planId}-${role.replace("plan-", "")}-r${plan.round}-${ordinal}`);
		const leaseReason = `plan-herder:${run.planName}:${plan.planId}:${role}:${attemptId}:${taskName}`;
		if (plan.rebase && role !== "plan-implementer") throw new Error(`Only an Implementer may own active rebase recovery for ${plan.planId}`);
		if (!plan.rebase) driver.verifyAssignment(plan.worktree, plan.assignmentPath, plan.assignmentSha256);
		driver.lease(plan.worktree, leaseReason);
		if (plan.rebase) {
			try {
				const rebase = driver.verifyActiveRebase({
					worktree: plan.worktree,
					branch: plan.branch,
					bundlePath: plan.assignmentPath,
					bundleSha256: plan.assignmentSha256,
					leaseReason,
					rebase: plan.rebase,
				});
				plan = this.updatePlan(plan, { rebase });
			} catch (error) {
				driver.release(plan.worktree, leaseReason);
				throw error;
			}
		}
		const mode = workerMode(plan, role);
		const action: ManagerAction = {
			actionId,
			attemptId,
			runId: run.runId,
			planId: plan.planId,
			generation: plan.generation,
			round: plan.round,
			role,
			agentType: mapping.agent_type,
			model: mapping.model,
			effort: mapping.effort,
			...(mapping.service_tier ? { serviceTier: mapping.service_tier } : {}),
			workerMode: mode,
			taskName,
			worktree: plan.worktree,
			branch: plan.branch,
			assignmentPath: plan.assignmentPath,
			assignmentSha256: plan.assignmentSha256,
			leaseReason,
			prompt: "",
		};
		let stored!: StoredAction;
		this.store.transaction(() => {
			stored = this.store.putAction(action);
			this.updatePlan(plan, { phase: phaseForRole(role) });
		});
		return stored;
	}

	private managerAction(run: StoredRun, stored: StoredAction): ManagerAction {
		const plan = this.store.getPlan(run.runId, stored.planId);
		if (!plan) throw new Error(`Action ${stored.actionId} has no plan runtime`);
		const changedPaths = plan.planId === "RUN" || plan.rebase ? [] : this.driver(run).changedPaths(plan.worktree, plan.generationBase);
		const action: ManagerAction = {
			actionId: stored.actionId,
			attemptId: stored.attemptId,
			runId: stored.runId,
			planId: stored.planId,
			generation: stored.generation,
			round: stored.round,
			role: stored.role as WorkerRole,
			agentType: stored.agentType,
			model: stored.model,
			effort: stored.effort,
			...(stored.serviceTier ? { serviceTier: stored.serviceTier } : {}),
			workerMode: stored.workerMode as ManagerAction["workerMode"],
			taskName: stored.taskName,
			worktree: plan.worktree,
			branch: plan.branch,
			assignmentPath: plan.assignmentPath,
			assignmentSha256: plan.assignmentSha256,
			leaseReason: stored.leaseReason,
			prompt: "",
		};
		action.prompt = assignmentPrompt({ run, plan, action: stored, changedPaths });
		return action;
	}

	reply(): ManagerReply {
		const run = this.store.getRun();
		if (!run) return {
			protocolVersion: MANAGER_PROTOCOL_VERSION,
			runId: "",
			status: "idle",
			maxParallel: 0,
			planDirectory: this.planDirectory,
			actions: [],
			active: [],
			summary: { total: 0, done: 0, rejected: 0, inProgress: 0, available: 0 },
			message: "No Herder run has started.",
		};
		const overview = summarizeRun(this.specs(run), this.store.getPlans(run.runId));
		const proposed = this.store.getActions(run.runId, ["proposed"]);
		const active = this.store.getActions(run.runId, ["proposed", "dispatched"]);
		const questionPlan = this.store.getPlans(run.runId).find((plan) => plan.phase === "NEEDS_INPUT");
		return {
			protocolVersion: MANAGER_PROTOCOL_VERSION,
			runId: run.runId,
			status: run.status,
			maxParallel: run.maxParallel,
			planDirectory: run.planDirectory,
			...(run.dashboardUrl ? { dashboardUrl: run.dashboardUrl } : {}),
			actions: proposed.map((action) => this.managerAction(run, action)),
			active: active.map((action) => ({
				actionId: action.actionId,
				planId: action.planId,
				role: action.role,
				...(action.hostHandle ? { hostHandle: action.hostHandle } : {}),
			})),
			summary: {
				total: overview.total,
				done: overview.done,
				rejected: overview.rejected,
				inProgress: overview.inProgress,
				available: Math.max(0, run.maxParallel - active.length),
			},
			message: run.terminalDetail || `${overview.done}/${overview.total} plans done; ${active.length} worker actions active.`,
			...(questionPlan?.repair[0] ? { question: questionPlan.repair[0] } : {}),
		};
	}

	stop(): ManagerReply {
		const run = this.store.getRun();
		if (!run) return this.reply();
		this.store.updateRun({ status: "stopped", terminalDetail: "Stop requested; repository and worker evidence preserved." });
		return this.reply();
	}
}

export type { EventInput, StartInput };

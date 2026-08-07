import type { DatabaseSync } from "node:sqlite";
import {
	executionDatabasePath,
	openExecutionDatabase,
	withExecutionTransaction,
} from "../skills/plans/scripts/execution-store.mjs";
import { canonicalEventPayload, type ManagerAction, type PlanPhase, type RunStatus } from "./protocol.ts";

type Database = DatabaseSync;

export interface StoredRun {
	runId: string;
	repositoryRoot: string;
	planDirectory: string;
	planName: string;
	host: "codex" | "claude" | "pi";
	profileName: string;
	profileSha256: string;
	maxParallel: number;
	status: RunStatus;
	checkoutStateToken: string;
	baseCommit: string;
	integrationBranch: string;
	integrationWorktree: string;
	dashboardUrl: string | null;
	terminalDetail: string | null;
	createdAt: string;
	updatedAt: string;
}

export interface StoredPlan {
	runId: string;
	planId: string;
	generation: number;
	round: number;
	phase: PlanPhase;
	branch: string;
	worktree: string;
	assignmentPath: string;
	assignmentSha256: string;
	snapshotSha256: string;
	generationBase: string;
	reviewPass: number;
	findings: string[];
	repair: string[];
	gates: unknown[];
	approvedBase: string | null;
	approvedHead: string | null;
	approvedTree: string | null;
	rebase: {
		checkpointRef: string;
		checkpoint: string;
		onto: string;
		detachedHead: string;
		rebaseStateSha256?: string;
	} | null;
	updatedAt: string;
}

export interface StoredPlanSpec {
	runId: string;
	planId: string;
	ordinal: number;
	title: string;
	priority: string;
	effort: string;
	kind: string;
	dependencies: string[];
	initialStatus: "TODO" | "DONE" | "BLOCKED" | "REJECTED";
	initialStatusDetail: string;
	gateCommands: string[];
	planFile: string;
	assignment: {
		snapshotSha256: string;
		snapshotInputs: Array<{ kind: string; name: string; sha256: string }>;
		plan: {
			id: string;
			title: string;
			kind: string;
			parentObjective: string | null;
			dependencies: string[];
			inScopePaths: string[];
		};
		planText: string;
	};
}

export interface StoredAction {
	actionId: string;
	runId: string;
	planId: string;
	generation: number;
	round: number;
	role: string;
	attemptId: string;
	state: "proposed" | "dispatched" | "terminal" | "cancelled";
	agentType: string;
	model: string;
	effort: string;
	serviceTier: string | null;
	workerMode: string;
	taskName: string;
	leaseReason: string;
	hostHandle: string | null;
	result: unknown;
	createdAt: string;
	updatedAt: string;
}

export interface StoredService {
	instanceId: string;
	pid: number;
	port: number;
	authToken: string;
	dashboardUrl: string;
	forwardedUrl: string | null;
	startedAt: string;
}

export interface StoredProfileBinding {
	profile: string;
	profileSha256: string;
	host: StoredRun["host"];
	roles: Record<string, { agent_type: string; model: string; effort: string; service_tier?: string }>;
}

function parseJson<T>(value: string | null | undefined, fallback: T): T {
	if (!value) return fallback;
	return JSON.parse(value) as T;
}

function rowToRun(row: Record<string, unknown> | undefined): StoredRun | null {
	if (!row) return null;
	return {
		runId: String(row.run_id),
		repositoryRoot: String(row.repository_root),
		planDirectory: String(row.plan_directory),
		planName: String(row.plan_name),
		host: row.host as StoredRun["host"],
		profileName: String(row.profile_name),
		profileSha256: String(row.profile_sha256),
		maxParallel: Number(row.max_parallel),
		status: row.status as RunStatus,
		checkoutStateToken: String(row.checkout_state_token),
		baseCommit: String(row.base_commit),
		integrationBranch: String(row.integration_branch),
		integrationWorktree: String(row.integration_worktree),
		dashboardUrl: row.dashboard_url === null ? null : String(row.dashboard_url),
		terminalDetail: row.terminal_detail === null ? null : String(row.terminal_detail),
		createdAt: String(row.created_at),
		updatedAt: String(row.updated_at),
	};
}

function rowToPlan(row: Record<string, unknown>): StoredPlan {
	return {
		runId: String(row.run_id),
		planId: String(row.plan_id),
		generation: Number(row.generation),
		round: Number(row.round_number),
		phase: String(row.phase) as PlanPhase,
		branch: String(row.branch),
		worktree: String(row.worktree),
		assignmentPath: String(row.assignment_path),
		assignmentSha256: String(row.assignment_sha256),
		snapshotSha256: String(row.snapshot_sha256),
		generationBase: String(row.generation_base),
		reviewPass: Number(row.review_pass),
		findings: parseJson<string[]>(String(row.findings_json), []),
		repair: parseJson<string[]>(String(row.repair_json), []),
		gates: parseJson<unknown[]>(String(row.gate_json), []),
		approvedBase: row.approved_base === null ? null : String(row.approved_base),
		approvedHead: row.approved_head === null ? null : String(row.approved_head),
		approvedTree: row.approved_tree === null ? null : String(row.approved_tree),
		rebase: parseJson<StoredPlan["rebase"]>(row.rebase_json === null ? null : String(row.rebase_json), null),
		updatedAt: String(row.updated_at),
	};
}

function rowToPlanSpec(row: Record<string, unknown>): StoredPlanSpec {
	return {
		runId: String(row.run_id),
		planId: String(row.plan_id),
		ordinal: Number(row.ordinal),
		title: String(row.title),
		priority: String(row.priority),
		effort: String(row.effort),
		kind: String(row.kind),
		dependencies: parseJson(String(row.dependencies_json), []),
		initialStatus: String(row.initial_status) as StoredPlanSpec["initialStatus"],
		initialStatusDetail: String(row.initial_status_detail),
		gateCommands: parseJson(String(row.gate_commands_json), []),
		planFile: String(row.plan_file),
		assignment: JSON.parse(String(row.assignment_json)) as StoredPlanSpec["assignment"],
	};
}

function rowToAction(row: Record<string, unknown>): StoredAction {
	return {
		actionId: String(row.action_id),
		runId: String(row.run_id),
		planId: String(row.plan_id),
		generation: Number(row.generation),
		round: Number(row.round_number),
		role: String(row.role),
		attemptId: String(row.attempt_id),
		state: row.state as StoredAction["state"],
		agentType: String(row.agent_type),
		model: String(row.model),
		effort: String(row.effort),
		serviceTier: row.service_tier === null ? null : String(row.service_tier),
		workerMode: String(row.worker_mode),
		taskName: String(row.task_name),
		leaseReason: String(row.lease_reason),
		hostHandle: row.host_handle === null ? null : String(row.host_handle),
		result: parseJson<unknown>(row.result_json === null ? null : String(row.result_json), null),
		createdAt: String(row.created_at),
		updatedAt: String(row.updated_at),
	};
}

export class RunStore {
	readonly databasePath: string;
	readonly database: Database;

	constructor(planDirectory: string, options: { readOnly?: boolean } = {}) {
		this.databasePath = executionDatabasePath(planDirectory);
		const database = openExecutionDatabase(planDirectory, { create: !options.readOnly, readOnly: options.readOnly });
		if (!database) throw new Error(`Herder execution database is not initialized: ${this.databasePath}`);
		this.database = database;
	}

	close(): void {
		this.database.close();
	}

	transaction<T>(operation: () => T): T {
		return withExecutionTransaction(this.database, operation);
	}

	getRun(): StoredRun | null {
		return rowToRun(this.database.prepare("SELECT * FROM manager_runs ORDER BY created_at DESC LIMIT 1").get() as Record<string, unknown> | undefined);
	}

	getProfileBinding(): StoredProfileBinding | null {
		const row = this.database.prepare("SELECT profile_name, profile_sha256, host, roles_json FROM run_configuration WHERE singleton = 1").get() as Record<string, unknown> | undefined;
		if (!row) return null;
		return {
			profile: String(row.profile_name),
			profileSha256: String(row.profile_sha256),
			host: row.host as StoredRun["host"],
			roles: JSON.parse(String(row.roles_json)) as StoredProfileBinding["roles"],
		};
	}

	getPlanSpecs(runId: string): StoredPlanSpec[] {
		return (this.database.prepare("SELECT * FROM manager_plan_specs WHERE run_id = ? ORDER BY ordinal, plan_id").all(runId) as Record<string, unknown>[]).map(rowToPlanSpec);
	}

	putPlanSpecs(specs: StoredPlanSpec[]): void {
		const statement = this.database.prepare(`
			INSERT INTO manager_plan_specs (
				run_id, plan_id, ordinal, title, priority, effort, kind, dependencies_json,
				initial_status, initial_status_detail, gate_commands_json, plan_file, assignment_json
			) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
			ON CONFLICT(run_id, plan_id) DO UPDATE SET
				ordinal = excluded.ordinal,
				title = excluded.title,
				priority = excluded.priority,
				effort = excluded.effort,
				kind = excluded.kind,
				dependencies_json = excluded.dependencies_json,
				initial_status = excluded.initial_status,
				initial_status_detail = excluded.initial_status_detail,
				gate_commands_json = excluded.gate_commands_json,
				plan_file = excluded.plan_file,
				assignment_json = excluded.assignment_json
		`);
		for (const input of specs) {
			statement.run(
				input.runId, input.planId, input.ordinal, input.title, input.priority, input.effort,
				input.kind, JSON.stringify(input.dependencies), input.initialStatus, input.initialStatusDetail,
				JSON.stringify(input.gateCommands), input.planFile, JSON.stringify(input.assignment),
			);
		}
	}

	createRun(input: Omit<StoredRun, "createdAt" | "updatedAt" | "dashboardUrl" | "terminalDetail"> & { dashboardUrl?: string | null }): StoredRun {
		const existing = this.getRun();
		if (existing) throw new Error(`Herder run ${existing.runId} already exists for ${existing.planDirectory}; use resume`);
		const now = new Date().toISOString();
		this.database.prepare(`
				INSERT INTO manager_runs (
					run_id, repository_root, plan_directory, plan_name, host,
					profile_name, profile_sha256, max_parallel, status, checkout_state_token,
					base_commit, integration_branch, integration_worktree, dashboard_url,
					terminal_detail, created_at, updated_at
				) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, NULL, ?, ?)
			`).run(
				input.runId, input.repositoryRoot, input.planDirectory, input.planName, input.host,
			input.profileName, input.profileSha256, input.maxParallel, input.status, input.checkoutStateToken,
			input.baseCommit, input.integrationBranch, input.integrationWorktree, input.dashboardUrl ?? null,
			now, now,
		);
		return this.getRun()!;
	}

	updateRun(input: { status?: RunStatus; dashboardUrl?: string | null; terminalDetail?: string | null }): StoredRun {
		const run = this.getRun();
		if (!run) throw new Error("No Herder manager run exists");
		const status = input.status ?? run.status;
		const dashboardUrl = input.dashboardUrl === undefined ? run.dashboardUrl : input.dashboardUrl;
		const terminalDetail = input.terminalDetail === undefined ? run.terminalDetail : input.terminalDetail;
		this.database.prepare("UPDATE manager_runs SET status = ?, dashboard_url = ?, terminal_detail = ?, updated_at = ? WHERE run_id = ?")
			.run(status, dashboardUrl, terminalDetail, new Date().toISOString(), run.runId);
		return this.getRun()!;
	}

	getPlans(runId: string): StoredPlan[] {
		return (this.database.prepare("SELECT * FROM manager_plans WHERE run_id = ? ORDER BY plan_id").all(runId) as Record<string, unknown>[]).map(rowToPlan);
	}

	getPlan(runId: string, planId: string): StoredPlan | null {
		const row = this.database.prepare("SELECT * FROM manager_plans WHERE run_id = ? AND plan_id = ?").get(runId, planId) as Record<string, unknown> | undefined;
		return row ? rowToPlan(row) : null;
	}

	putPlan(input: Omit<StoredPlan, "updatedAt"> | StoredPlan): StoredPlan {
		const now = new Date().toISOString();
		this.database.prepare(`
			INSERT INTO manager_plans (
				run_id, plan_id, generation, round_number, phase, branch, worktree,
				assignment_path, assignment_sha256, snapshot_sha256, generation_base,
				review_pass, findings_json, repair_json, gate_json,
				approved_base, approved_head, approved_tree, rebase_json, updated_at
			) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
			ON CONFLICT(run_id, plan_id) DO UPDATE SET
				generation = excluded.generation,
				round_number = excluded.round_number,
				phase = excluded.phase,
				branch = excluded.branch,
				worktree = excluded.worktree,
				assignment_path = excluded.assignment_path,
				assignment_sha256 = excluded.assignment_sha256,
				snapshot_sha256 = excluded.snapshot_sha256,
				generation_base = excluded.generation_base,
				review_pass = excluded.review_pass,
				findings_json = excluded.findings_json,
				repair_json = excluded.repair_json,
				gate_json = excluded.gate_json,
				approved_base = excluded.approved_base,
				approved_head = excluded.approved_head,
				approved_tree = excluded.approved_tree,
				rebase_json = excluded.rebase_json,
				updated_at = excluded.updated_at
		`).run(
			input.runId, input.planId, input.generation, input.round, input.phase, input.branch, input.worktree,
			input.assignmentPath, input.assignmentSha256, input.snapshotSha256, input.generationBase,
			input.reviewPass, JSON.stringify(input.findings), JSON.stringify(input.repair), JSON.stringify(input.gates),
			input.approvedBase, input.approvedHead, input.approvedTree, JSON.stringify(input.rebase), now,
		);
		return this.getPlan(input.runId, input.planId)!;
	}

	getActions(runId: string, states?: StoredAction["state"][]): StoredAction[] {
		const rows = states?.length
			? this.database.prepare(`SELECT * FROM manager_actions WHERE run_id = ? AND state IN (${states.map(() => "?").join(",")}) ORDER BY created_at, action_id`).all(runId, ...states)
			: this.database.prepare("SELECT * FROM manager_actions WHERE run_id = ? ORDER BY created_at, action_id").all(runId);
		return (rows as Record<string, unknown>[]).map(rowToAction);
	}

	getAction(actionId: string): StoredAction | null {
		const row = this.database.prepare("SELECT * FROM manager_actions WHERE action_id = ?").get(actionId) as Record<string, unknown> | undefined;
		return row ? rowToAction(row) : null;
	}

	putAction(action: ManagerAction): StoredAction {
		const existing = this.getAction(action.actionId);
		if (existing) return existing;
		const now = new Date().toISOString();
		this.database.prepare(`
			INSERT INTO manager_actions (
				action_id, run_id, plan_id, generation, round_number, role, attempt_id,
				state, agent_type, model, effort, service_tier, worker_mode, task_name,
				lease_reason, host_handle, result_json, created_at, updated_at
			) VALUES (?, ?, ?, ?, ?, ?, ?, 'proposed', ?, ?, ?, ?, ?, ?, ?, NULL, NULL, ?, ?)
		`).run(
			action.actionId, action.runId, action.planId, action.generation, action.round, action.role, action.attemptId,
			action.agentType, action.model, action.effort, action.serviceTier ?? null, action.workerMode,
			action.taskName, action.leaseReason, now, now,
		);
		return this.getAction(action.actionId)!;
	}

	markDispatched(actionId: string, hostHandle: string): StoredAction {
		const action = this.getAction(actionId);
		if (!action) throw new Error(`Unknown Herder action ${actionId}`);
		if (action.state === "dispatched" && action.hostHandle === hostHandle) return action;
		if (action.state !== "proposed") throw new Error(`Action ${actionId} cannot dispatch from ${action.state}`);
		this.database.prepare("UPDATE manager_actions SET state = 'dispatched', host_handle = ?, updated_at = ? WHERE action_id = ?")
			.run(hostHandle, new Date().toISOString(), actionId);
		return this.getAction(actionId)!;
	}

	markCancelled(actionId: string, result: unknown): StoredAction {
		const action = this.getAction(actionId);
		if (!action) throw new Error(`Unknown Herder action ${actionId}`);
		if (action.state === "cancelled") return action;
		if (action.state !== "proposed") throw new Error(`Action ${actionId} cannot cancel from ${action.state}`);
		this.database.prepare("UPDATE manager_actions SET state = 'cancelled', result_json = ?, updated_at = ? WHERE action_id = ?")
			.run(JSON.stringify(result), new Date().toISOString(), actionId);
		return this.getAction(actionId)!;
	}

	markTerminal(actionId: string, result: unknown): StoredAction {
		const action = this.getAction(actionId);
		if (!action) throw new Error(`Unknown Herder action ${actionId}`);
		if (action.state === "terminal") return action;
		if (action.state !== "dispatched") throw new Error(`Action ${actionId} cannot finish from ${action.state}`);
		this.database.prepare("UPDATE manager_actions SET state = 'terminal', result_json = ?, updated_at = ? WHERE action_id = ?")
			.run(JSON.stringify(result), new Date().toISOString(), actionId);
		return this.getAction(actionId)!;
	}

	readEvent(eventId: string): { payloadSha256: string } | null {
		const row = this.database.prepare("SELECT payload_sha256 FROM manager_events WHERE event_id = ?").get(eventId) as Record<string, unknown> | undefined;
		return row ? { payloadSha256: String(row.payload_sha256) } : null;
	}

	recordEvent(runId: string, eventId: string, kind: string, payload: unknown): void {
		const canonical = canonicalEventPayload(payload);
		const existing = this.readEvent(eventId);
		if (existing) {
			if (existing.payloadSha256 !== canonical.sha256) throw new Error(`Event ${eventId} was replayed with different payload`);
			return;
		}
		this.database.prepare(`
				INSERT INTO manager_events (event_id, run_id, kind, payload_sha256, created_at)
				VALUES (?, ?, ?, ?, ?)
			`).run(eventId, runId, kind, canonical.sha256, new Date().toISOString());
	}

	getService(): StoredService | null {
		const row = this.database.prepare("SELECT * FROM manager_service WHERE singleton = 1").get() as Record<string, unknown> | undefined;
		if (!row) return null;
		return {
			instanceId: String(row.instance_id),
			pid: Number(row.pid),
			port: Number(row.port),
			authToken: String(row.auth_token),
			dashboardUrl: String(row.dashboard_url),
			forwardedUrl: row.forwarded_url === null ? null : String(row.forwarded_url),
			startedAt: String(row.started_at),
		};
	}

	putService(service: StoredService): void {
		this.database.prepare(`
				INSERT INTO manager_service (
					singleton, instance_id, pid, port, auth_token, dashboard_url,
					forwarded_url, started_at
				) VALUES (1, ?, ?, ?, ?, ?, ?, ?)
			ON CONFLICT(singleton) DO UPDATE SET
				instance_id = excluded.instance_id,
				pid = excluded.pid,
				port = excluded.port,
				auth_token = excluded.auth_token,
				dashboard_url = excluded.dashboard_url,
					forwarded_url = excluded.forwarded_url,
					started_at = excluded.started_at
			`).run(
				service.instanceId, service.pid, service.port, service.authToken, service.dashboardUrl,
				service.forwardedUrl, service.startedAt,
			);
	}
}

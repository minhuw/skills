import { randomUUID } from "node:crypto";
import { existsSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import type { ExtensionAPI, ExtensionContext } from "@earendil-works/pi-coding-agent";
import { Text } from "@earendil-works/pi-tui";
import { Type } from "typebox";
import { ensureService, requestService } from "../../plugins/herder/runtime/client.ts";
import type { ManagerReply, TerminalEvent } from "../../plugins/herder/runtime/protocol.ts";
import { parseFireArguments, parsePlanDirArguments, type FireOptions } from "./lib/arguments.ts";
import { completionFailed, completionText, completionUsage } from "./lib/worker-result.ts";
import {
	activeModelMatches,
	loadPiProfile,
	unavailableProfileModels,
	type ResolvedPiProfile,
} from "./lib/profile.ts";
import {
	SUBAGENT_ASYNC_COMPLETE_EVENT,
	SubagentRpcClient,
	asyncRunIdentity,
} from "./lib/rpc.ts";
import { HERDER_STATE_ENTRY, restoreLastRun, type HerderRunState } from "./lib/state.ts";
import { resolvePlanDirectory } from "./lib/paths.ts";
import {
	PI_SUBAGENTS_INSTALL_COMMAND,
	assertPiSubagentsRuntime,
	validateHerderRoleAgents,
} from "./lib/runtime-preflight.ts";

const EXTENSION_ROOT = path.dirname(fileURLToPath(import.meta.url));
const PACKAGE_ROOT = path.resolve(EXTENSION_ROOT, "../..");
const PROFILE_CATALOG = path.join(PACKAGE_ROOT, "plugins/herder/agent-profiles/profiles.json");
const PI_AGENT_ROOT = path.join(EXTENSION_ROOT, "agents");
interface PlanSummary {
	counts?: { total?: number; done?: number; rejected?: number; actionable?: number };
	inProgress?: number;
	blocked?: number;
}

interface RpcData {
	text?: string;
	details?: unknown;
	result?: unknown;
	output?: unknown;
}

interface WorkerBinding {
	actionId: string;
	childRunId: string;
	managerRunId: string;
	planDir: string;
}

function message(error: unknown): string {
	return error instanceof Error ? error.message : String(error);
}

function activeModelLabel(ctx: ExtensionContext): string {
	return ctx.model ? `${ctx.model.provider}/${ctx.model.id}` : "none";
}

function summaryLine(summary: PlanSummary | undefined): string | undefined {
	if (!summary?.counts || typeof summary.counts.total !== "number") return undefined;
	return `${summary.counts.done ?? 0}/${summary.counts.total} done · ${summary.inProgress ?? 0} in progress · ${summary.counts.rejected ?? 0} rejected`;
}

function stateLine(state: HerderRunState): string {
	return `${state.status.toUpperCase()} · ${state.profile} · max ${state.maxParallel} · ${path.basename(state.planDir)}`;
}

function unwrapReply(value: Record<string, unknown>): ManagerReply {
	const reply = value.reply;
	if (!reply || typeof reply !== "object" || Array.isArray(reply)) throw new Error("Herder service returned no manager reply.");
	return reply as unknown as ManagerReply;
}

function completionRunId(payload: unknown): string | undefined {
	const record = payload && typeof payload === "object" && !Array.isArray(payload) ? payload as Record<string, unknown> : {};
	const details = record.details && typeof record.details === "object" && !Array.isArray(record.details) ? record.details as Record<string, unknown> : {};
	return [record.runId, record.id, details.asyncId, details.runId].find((value): value is string => typeof value === "string" && value.length > 0);
}

function toolResult(text: string, isError = false) {
	return { content: [{ type: "text" as const, text }], ...(isError ? { isError: true } : {}), details: {} };
}

export default function registerHerderPi(pi: ExtensionAPI): void {
	const rpc = new SubagentRpcClient(pi.events);
	const workers = new Map<string, WorkerBinding>();
	let currentState: HerderRunState | undefined;
	let lastContext: ExtensionContext | undefined;
	let lastSummary: PlanSummary | undefined;
	let dispatching = false;

	const persist = (state: HerderRunState) => {
		currentState = state;
		pi.appendEntry(HERDER_STATE_ENTRY, state);
	};

	const render = (ctx = lastContext) => {
		if (!ctx?.hasUI) return;
		if (!currentState) {
			ctx.ui.setStatus("herder", undefined);
			ctx.ui.setWidget("herder", undefined);
			return;
		}
		ctx.ui.setStatus("herder", `Herder ${currentState.status}`);
		ctx.ui.setWidget("herder", [stateLine(currentState), summaryLine(lastSummary), currentState.dashboardUrl].filter((line): line is string => Boolean(line)), { placement: "belowEditor" });
	};

	const repositoryRoot = async (ctx: ExtensionContext): Promise<string> => {
		const result = await pi.exec("git", ["-C", ctx.cwd, "rev-parse", "--show-toplevel"], { timeout: 5_000 });
		if (result.code !== 0 || !result.stdout.trim()) throw new Error("Herder requires a Git worktree.");
		return path.resolve(result.stdout.trim());
	};

	const resolveProfile = async (ctx: ExtensionContext, requested?: string): Promise<ResolvedPiProfile> => {
		const profile = await loadPiProfile(PROFILE_CATALOG, requested);
		const unavailable = unavailableProfileModels(profile, ctx.modelRegistry.getAvailable());
		if (unavailable.length) throw new Error(`Profile ${profile.profile} cannot start because Pi has no available model matching: ${unavailable.join(", ")}.`);
		if (!activeModelMatches(profile, ctx.model) || ctx.thinkingLevel !== profile.orchestrator.effort) {
			throw new Error(`Profile ${profile.profile} requires root ${profile.orchestrator.model}:${profile.orchestrator.effort}; current Pi model is ${activeModelLabel(ctx)}:${ctx.thinkingLevel || "unknown"}.`);
		}
		return profile;
	};

	const preflight = async (ctx: ExtensionContext, profile: ResolvedPiProfile) => {
		let ping: unknown;
		try { ping = await rpc.call("ping"); }
		catch (error) {
			throw new Error(`Herder requires the separately installed pi-subagents runtime. Run \`${PI_SUBAGENTS_INSTALL_COMMAND}\`, restart Pi, and try again. ${message(error)}`);
		}
		assertPiSubagentsRuntime(ping);
		await validateHerderRoleAgents(PI_AGENT_ROOT, profile, ctx.modelRegistry.getAvailable());
	};

	const updateFromReply = (reply: ManagerReply, profile?: string, mode?: "fire" | "resume") => {
		if (reply.status === "idle") {
			currentState = undefined;
			lastSummary = undefined;
			render();
			return;
		}
		const previous = currentState;
		const now = Date.now();
		persist({
			version: 1,
			mode: mode ?? previous?.mode ?? "resume",
			status: reply.status,
			runId: reply.runId,
			repoRoot: previous?.repoRoot ?? "",
			planDir: reply.planDirectory,
			profile: profile ?? previous?.profile ?? "unknown",
			maxParallel: reply.maxParallel,
			dashboardEnabled: true,
			startedAt: previous?.startedAt ?? now,
			updatedAt: now,
			...(reply.dashboardUrl ? { dashboardUrl: reply.dashboardUrl } : {}),
		});
		lastSummary = {
			counts: { total: reply.summary.total, done: reply.summary.done, rejected: reply.summary.rejected },
			inProgress: reply.summary.inProgress,
		};
		for (const active of reply.active) {
			if (!active.hostHandle) continue;
			workers.set(active.hostHandle, { actionId: active.actionId, childRunId: active.hostHandle, managerRunId: reply.runId, planDir: reply.planDirectory });
		}
		render();
	};

	const postEvent = async (planDir: string, input: unknown): Promise<ManagerReply> => {
		const service = await ensureService(planDir);
		return unwrapReply(await requestService(service, "/v1/event", input));
	};

	const dispatchReply = async (initial: ManagerReply): Promise<ManagerReply> => {
		let reply = initial;
		if (dispatching) return reply;
		dispatching = true;
		try {
			while (reply.actions.length > 0 && reply.status === "running") {
				const results = [];
				for (const action of reply.actions) {
					try {
						const data = await rpc.call("spawn", {
							agent: action.agentType,
							task: action.prompt,
							cwd: action.worktree,
							context: "fresh",
							model: action.model,
							thinking: action.effort,
							acceptance: false,
							async: true,
							artifacts: false,
							mission: false,
						});
						const identity = asyncRunIdentity(data);
						workers.set(identity.runId, { actionId: action.actionId, childRunId: identity.runId, managerRunId: reply.runId, planDir: reply.planDirectory });
						results.push({ actionId: action.actionId, accepted: true, hostHandle: identity.runId });
					} catch (error) {
						results.push({ actionId: action.actionId, accepted: false, error: message(error) });
					}
				}
				reply = await postEvent(reply.planDirectory, { eventId: randomUUID(), kind: "dispatch_results", dispatchResults: results });
				updateFromReply(reply);
			}
			return reply;
		} finally {
			dispatching = false;
		}
	};

	const launch = async (options: FireOptions, ctx: ExtensionContext): Promise<string> => {
		if (!ctx.isProjectTrusted()) throw new Error("Trust this project before starting Herder.");
		const repoRoot = await repositoryRoot(ctx);
		const planDir = resolvePlanDirectory(repoRoot, options.planDir);
		if (!existsSync(path.join(planDir, "README.md"))) throw new Error(`Herder plan index is missing: ${path.join(planDir, "README.md")}`);
		const profile = await resolveProfile(ctx, options.profile || (options.mode === "resume" ? currentState?.profile : undefined));
		await preflight(ctx, profile);
		const service = await ensureService(planDir, { dashboardPort: options.dashboardPort });
		const reply = unwrapReply(await requestService(service, "/v1/start", {
			mode: options.mode,
			repositoryRoot: repoRoot,
			planDirectory: planDir,
			host: "pi",
			profile: profile.profile,
			...(options.maxParallel === undefined ? {} : { maxParallel: options.maxParallel }),
			dashboardUrl: service.dashboardUrl,
		}));
		if (reply.status === "idle") throw new Error("Herder manager did not create a run.");
		const now = Date.now();
		persist({
			version: 1,
			mode: options.mode,
			status: reply.status,
			runId: reply.runId,
			repoRoot,
			planDir,
			profile: profile.profile,
			maxParallel: reply.maxParallel,
			dashboardEnabled: true,
			startedAt: now,
			updatedAt: now,
			...(reply.dashboardUrl ? { dashboardUrl: reply.dashboardUrl } : {}),
		});
		await dispatchReply(reply);
		return `Herder ${options.mode} started with deterministic manager ${reply.runId}, profile ${profile.profile}, and max parallel ${reply.maxParallel}. Dashboard: ${reply.dashboardUrl || service.forwardedUrl || service.dashboardUrl}`;
	};

	const status = async (planDirInput: string | undefined, ctx: ExtensionContext): Promise<string> => {
		const repoRoot = await repositoryRoot(ctx);
		const planDir = planDirInput
			? resolvePlanDirectory(repoRoot, planDirInput)
			: currentState?.planDir ?? resolvePlanDirectory(repoRoot, "herder-plans");
		const service = await ensureService(planDir);
		const reply = unwrapReply(await requestService(service, "/v1/status"));
		updateFromReply(reply);
		render(ctx);
		return `${reply.status.toUpperCase()} · ${reply.message}${reply.dashboardUrl ? `\nDashboard: ${reply.dashboardUrl}` : ""}`;
	};

	const dashboard = async (planDirInput: string | undefined, ctx: ExtensionContext): Promise<string> => {
		const repoRoot = await repositoryRoot(ctx);
		const planDir = planDirInput
			? resolvePlanDirectory(repoRoot, planDirInput)
			: currentState?.planDir ?? resolvePlanDirectory(repoRoot, "herder-plans");
		const service = await ensureService(planDir);
		return `Herder dashboard: ${service.forwardedUrl || service.dashboardUrl}`;
	};

	const stop = async (): Promise<string> => {
		if (!currentState) return "No active Herder run.";
		const service = await ensureService(currentState.planDir);
		let reply = unwrapReply(await requestService(service, "/v1/stop", {}));
		const interrupted: TerminalEvent[] = [];
		for (const worker of workers.values()) {
			await rpc.call("stop", { id: worker.childRunId }).catch(() => {});
			interrupted.push({
				actionId: worker.actionId,
				hostHandle: worker.childRunId,
				interrupted: true,
				error: "Pi user requested Herder stop",
			});
		}
		workers.clear();
		if (interrupted.length > 0) {
			reply = await postEvent(currentState.planDir, { eventId: randomUUID(), kind: "terminals", terminals: interrupted });
		}
		updateFromReply(reply);
		return `Stop requested for Herder run ${reply.runId}. Repository state was preserved.`;
	};

	const command = (handler: (args: string, ctx: ExtensionContext) => Promise<string>) => async (args: string, ctx: ExtensionContext) => {
		lastContext = ctx;
		try { ctx.ui.notify(await handler(args, ctx), "info"); }
		catch (error) { ctx.ui.notify(message(error), "error"); }
	};

	pi.registerCommand("herder-fire", { description: "Start a deterministic background Herder run.", handler: command((args, ctx) => launch(parseFireArguments(args, "fire"), ctx)) });
	pi.registerCommand("herder-resume", { description: "Resume a deterministic Herder run.", handler: command((args, ctx) => launch(parseFireArguments(args, "resume"), ctx)) });
	pi.registerCommand("herder-status", { description: "Show Herder manager and plan status.", handler: command((args, ctx) => status(parsePlanDirArguments(args).planDir, ctx)) });
	pi.registerCommand("herder-dashboard", { description: "Open the manager-hosted Herder dashboard.", handler: command((args, ctx) => dashboard(parsePlanDirArguments(args).planDir, ctx)) });
	pi.registerCommand("herder-stop", {
		description: "Stop active Herder workers and preserve repository state.",
		handler: async (_args, ctx) => {
			lastContext = ctx;
			if (ctx.hasUI && !(await ctx.ui.confirm("Stop Herder?", "Active workers will stop; repository state remains preserved."))) return;
			try { ctx.ui.notify(await stop(), "info"); } catch (error) { ctx.ui.notify(message(error), "error"); }
		},
	});

	pi.registerTool({
		name: "herder",
		label: "Herder",
		description: "Start, resume, inspect, or open the dashboard for a deterministic Herder plan run.",
		parameters: Type.Object({
			action: Type.Union([Type.Literal("fire"), Type.Literal("resume"), Type.Literal("status"), Type.Literal("dashboard")]),
			planDir: Type.Optional(Type.String()),
			profile: Type.Optional(Type.String()),
			maxParallel: Type.Optional(Type.Integer({ minimum: 1, maximum: 32 })),
		}),
		async execute(_id, params, _signal, _onUpdate, ctx) {
			lastContext = ctx;
			try {
				if (params.action === "status") return toolResult(await status(params.planDir, ctx));
				if (params.action === "dashboard") return toolResult(await dashboard(params.planDir, ctx));
				return toolResult(await launch({ mode: params.action, planDir: params.planDir || "herder-plans", ...(params.profile ? { profile: params.profile } : {}), ...(params.maxParallel === undefined && params.action === "resume" ? {} : { maxParallel: params.maxParallel ?? 5 }), dashboardPort: 0 }, ctx));
			} catch (error) { return toolResult(message(error), true); }
		},
	});

	pi.registerEntryRenderer<HerderRunState>(HERDER_STATE_ENTRY, (entry, _options, theme) => {
		const state = entry.data;
		if (!state) return new Text(theme.fg("warning", "Herder state unavailable"), 0, 0);
		return new Text(theme.fg(state.status === "running" ? "accent" : state.status === "complete" ? "success" : "warning", `Herder ${stateLine(state)}`), 0, 0);
	});

	pi.events.on(SUBAGENT_ASYNC_COMPLETE_EVENT, (payload) => {
		void (async () => {
			const childRunId = completionRunId(payload);
			if (!childRunId) return;
			const binding = workers.get(childRunId);
			if (!binding) return;
			let response = completionText(payload);
			if (!response) {
				try { response = completionText(await rpc.call<RpcData>("status", { id: childRunId })); } catch {}
			}
			const usage = completionUsage(payload);
			const terminal: TerminalEvent = {
				actionId: binding.actionId,
				hostHandle: childRunId,
				...(response ? { response } : {}),
				...(usage ? { usage } : {}),
				...(!response || completionFailed(payload) ? { interrupted: true, error: "pi-subagents worker ended without a usable terminal envelope" } : {}),
			};
			workers.delete(childRunId);
			const reply = await postEvent(binding.planDir, { eventId: randomUUID(), kind: "terminals", terminals: [terminal] });
			updateFromReply(reply);
			await dispatchReply(reply);
		})().catch((error) => lastContext?.ui.notify(`Herder completion handling failed: ${message(error)}`, "error"));
	});

	pi.on("session_start", async (_event, ctx) => {
		lastContext = ctx;
		currentState = restoreLastRun(ctx.sessionManager.getEntries());
		if (currentState) {
			try {
				const service = await ensureService(currentState.planDir);
				const reply = unwrapReply(await requestService(service, "/v1/status"));
				updateFromReply(reply);
				await dispatchReply(reply);
			} catch (error) {
				ctx.ui.notify(`Herder manager recovery failed: ${message(error)}`, "warning");
			}
		}
		render(ctx);
	});

	pi.on("session_shutdown", async () => {
		lastContext = undefined;
	});
}

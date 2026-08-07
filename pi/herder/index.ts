import { existsSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import type { ExtensionAPI, ExtensionContext } from "@earendil-works/pi-coding-agent";
import { Text } from "@earendil-works/pi-tui";
import { Type } from "typebox";
import { parseFireArguments, parsePlanDirArguments, type FireOptions } from "./lib/arguments.ts";
import { buildControllerTask, controllerWorkflowScript } from "./lib/controller-task.ts";
import {
	HERDER_ROLES,
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
const PROFILE_REGISTRY = path.join(PACKAGE_ROOT, "plugins/herder/agent-profiles/scripts/profile-registry.mjs");
const PLAN_MANAGER = path.join(PACKAGE_ROOT, "plugins/herder/skills/plans/scripts/herder-plans.mjs");
const FIRE_ROOT = path.join(PACKAGE_ROOT, "plugins/herder/skills/fire");
const CANONICAL_PROTOCOL = path.join(FIRE_ROOT, "references/orchestration-protocol.md");
const PI_PROTOCOL = path.join(EXTENSION_ROOT, "pi-orchestration.md");
const PI_AGENT_ROOT = path.join(EXTENSION_ROOT, "agents");
const DASHBOARD_MODULE = path.join(PACKAGE_ROOT, "plugins/herder/skills/dashboard/scripts/herder-dashboard.mjs");
const DASHBOARD_HOST_MODULE = path.join(PACKAGE_ROOT, "plugins/herder/skills/dashboard/scripts/dashboard-host.mjs");
const ROLE_CONTRACT_PATHS = Object.fromEntries(HERDER_ROLES.map((role) => [
	role,
	path.join(PACKAGE_ROOT, "plugins/herder/agents", `${role}.md`),
]));

interface PlanSummary {
	counts?: { total?: number; done?: number; rejected?: number; actionable?: number };
	inProgress?: string[];
	blocked?: string[];
	ready?: string[];
	complete?: boolean;
}

interface DashboardHandle {
	url: string;
	close(): Promise<void>;
	allowHost(value: string): void;
}

interface RpcData {
	text?: string;
	details?: unknown;
	fleet?: { totalActive?: number };
}

function text(value: unknown): string {
	return value instanceof Error ? value.message : String(value);
}

function activeModelLabel(ctx: ExtensionContext): string {
	if (!ctx.model) return "none";
	return `${ctx.model.provider}/${ctx.model.id}`;
}

function terminalState(payload: unknown): HerderRunState["status"] {
	const record = payload && typeof payload === "object" && !Array.isArray(payload) ? payload as Record<string, unknown> : {};
	if (record.stopped === true || record.state === "stopped") return "stopped";
	if (record.success === false || ["failed", "paused"].includes(String(record.state))) return "failed";
	return "complete";
}

function completionRunId(payload: unknown): string | undefined {
	const record = payload && typeof payload === "object" && !Array.isArray(payload) ? payload as Record<string, unknown> : {};
	return [record.runId, record.id].find((value): value is string => typeof value === "string" && value.length > 0);
}

function summaryLine(summary: PlanSummary | undefined): string | undefined {
	const counts = summary?.counts;
	if (!counts || typeof counts.total !== "number") return undefined;
	const done = counts.done ?? 0;
	const rejected = counts.rejected ?? 0;
	const active = summary?.inProgress?.length ?? 0;
	const blocked = summary?.blocked?.length ?? 0;
	return `${done}/${counts.total} done · ${active} in progress · ${rejected} rejected · ${blocked} blocked`;
}

function stateLine(state: HerderRunState): string {
	return `${state.status.toUpperCase()} · ${state.profile} · max ${state.maxParallel} · ${path.basename(state.planDir)}`;
}

function toolResult(message: string, isError = false) {
	return {
		content: [{ type: "text" as const, text: message }],
		...(isError ? { isError: true } : {}),
		details: {},
	};
}

export default function registerHerderPi(pi: ExtensionAPI): void {
	const rpc = new SubagentRpcClient(pi.events);
	let currentState: HerderRunState | undefined;
	let lastContext: ExtensionContext | undefined;
	let lastSummary: PlanSummary | undefined;
	let pollTimer: ReturnType<typeof setInterval> | undefined;
	let pollBusy = false;
	let dashboard: DashboardHandle | undefined;
	let dashboardPlanDir: string | undefined;

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
		const lines = [stateLine(currentState), summaryLine(lastSummary), currentState.dashboardUrl].filter((line): line is string => Boolean(line));
		ctx.ui.setWidget("herder", lines, { placement: "belowEditor" });
	};

	const queryPlanSummary = async (): Promise<PlanSummary | undefined> => {
		if (!currentState) return undefined;
		const result = await pi.exec(process.execPath, [PLAN_MANAGER, "status", currentState.planDir], { timeout: 10_000 });
		if (result.code !== 0) return undefined;
		try {
			return JSON.parse(result.stdout) as PlanSummary;
		} catch {
			return undefined;
		}
	};

	const poll = async () => {
		if (pollBusy || !currentState) return;
		pollBusy = true;
		try {
			lastSummary = await queryPlanSummary();
			render();
		} finally {
			pollBusy = false;
		}
	};

	const stopPolling = () => {
		if (pollTimer) clearInterval(pollTimer);
		pollTimer = undefined;
	};

	const startPolling = () => {
		stopPolling();
		void poll();
		if (currentState?.status === "running") pollTimer = setInterval(() => void poll(), 5_000);
	};

	const repositoryRoot = async (ctx: ExtensionContext): Promise<string> => {
		const result = await pi.exec("git", ["-C", ctx.cwd, "rev-parse", "--show-toplevel"], { timeout: 5_000 });
		if (result.code !== 0 || !result.stdout.trim()) throw new Error("Herder requires a Git worktree.");
		return path.resolve(result.stdout.trim());
	};

	const startDashboard = async (planDir: string, port: number): Promise<string> => {
		if (dashboard && dashboardPlanDir === planDir) return dashboard.url;
		if (dashboard) await dashboard.close();
		dashboard = undefined;
		dashboardPlanDir = undefined;
		const dashboardApi = await import(DASHBOARD_MODULE) as {
			createDashboardServer(input: { planDir: string; port: number }): Promise<DashboardHandle>;
		};
		dashboard = await dashboardApi.createDashboardServer({ planDir, port });
		dashboardPlanDir = planDir;
		try {
			const hostApi = await import(DASHBOARD_HOST_MODULE) as {
				enableDashboardHostAccess(input: { url: string; allowHost(value: string): void }): Promise<unknown>;
			};
			await hostApi.enableDashboardHostAccess({ url: dashboard.url, allowHost: dashboard.allowHost });
		} catch {
			// The loopback dashboard remains useful when host forwarding is unavailable.
		}
		return dashboard.url;
	};

	const resolveProfile = async (ctx: ExtensionContext, requested?: string): Promise<ResolvedPiProfile> => {
		const profile = await loadPiProfile(PROFILE_CATALOG, requested);
		const available = ctx.modelRegistry.getAvailable();
		const unavailable = unavailableProfileModels(profile, available);
		if (unavailable.length > 0) throw new Error(`Profile ${profile.profile} cannot start because Pi has no available model matching: ${unavailable.join(", ")}.`);
		if (!activeModelMatches(profile, ctx.model)) {
			throw new Error(`Profile ${profile.profile} requires root model ${profile.orchestrator.model}:${profile.orchestrator.effort}; current Pi model is ${activeModelLabel(ctx)}:${ctx.thinkingLevel || "unknown"}.`);
		}
		if (ctx.thinkingLevel !== profile.orchestrator.effort) {
			throw new Error(`Profile ${profile.profile} requires root thinking ${profile.orchestrator.effort}; current Pi thinking is ${ctx.thinkingLevel || "unknown"}.`);
		}
		return profile;
	};

	const preflight = async (ctx: ExtensionContext, profile: ResolvedPiProfile) => {
		const availableModels = ctx.modelRegistry.getAvailable();
		let ping: unknown;
		try {
			ping = await rpc.call("ping");
		} catch (error) {
			throw new Error(`Herder requires the separately installed pi-subagents runtime. Run \`${PI_SUBAGENTS_INSTALL_COMMAND}\`, restart Pi, and try again. ${text(error)}`);
		}
		assertPiSubagentsRuntime(ping);
		await validateHerderRoleAgents(PI_AGENT_ROOT, profile, availableModels);
	};

	const makeTask = (options: FireOptions, repoRoot: string, planDir: string, profile: ResolvedPiProfile) => buildControllerTask({
		mode: options.mode,
		repoRoot,
		planDir,
		maxParallel: options.maxParallel,
		profile,
		piProtocolPath: PI_PROTOCOL,
		canonicalProtocolPath: CANONICAL_PROTOCOL,
		planManagerPath: PLAN_MANAGER,
		profileRegistryPath: PROFILE_REGISTRY,
		helperRoot: path.join(FIRE_ROOT, "scripts"),
		roleContractPaths: ROLE_CONTRACT_PATHS,
	});

	const launch = async (options: FireOptions, ctx: ExtensionContext): Promise<string> => {
		if (!ctx.isProjectTrusted()) throw new Error("Trust this project before starting Herder.");
		const repoRoot = await repositoryRoot(ctx);
		const planDir = resolvePlanDirectory(repoRoot, options.planDir);
		if (!existsSync(path.join(planDir, "README.md"))) throw new Error(`Herder plan index is missing: ${path.join(planDir, "README.md")}`);

		if (currentState?.status === "running" && options.mode === "fire") {
			throw new Error(`Herder run ${currentState.runId} is already active for ${currentState.planDir}.`);
		}
		const requestedProfile = options.profile || (options.mode === "resume" ? currentState?.profile : undefined);
		const profile = await resolveProfile(ctx, requestedProfile);
		await preflight(ctx, profile);
		const task = makeTask(options, repoRoot, planDir, profile);

		let data: unknown;
		if (options.mode === "resume" && currentState && currentState.planDir === planDir && currentState.profile === profile.profile) {
			data = await rpc.call("resume", { id: currentState.runId, index: 0, message: task });
		} else {
			data = await rpc.call("spawn", {
				workflowScript: controllerWorkflowScript({
					agent: profile.roles["plan-accountant"].agent_type,
					task,
					cwd: repoRoot,
					model: profile.roles["plan-accountant"].model,
					thinking: profile.roles["plan-accountant"].effort,
				}),
				cwd: repoRoot,
				async: true,
				artifacts: true,
			});
		}
		const identity = asyncRunIdentity(data);
		const now = Date.now();
		const state: HerderRunState = {
			version: 1,
			mode: options.mode,
			status: "running",
			runId: identity.runId,
			...(identity.asyncDir ? { asyncDir: identity.asyncDir } : {}),
			repoRoot,
			planDir,
			profile: profile.profile,
			maxParallel: options.maxParallel,
			dashboardEnabled: options.dashboard,
			startedAt: now,
			updatedAt: now,
		};
		persist(state);
		if (options.dashboard) {
			try {
				const dashboardUrl = await startDashboard(planDir, options.dashboardPort);
				persist({ ...state, dashboardUrl, updatedAt: Date.now() });
			} catch (error) {
				ctx.ui.notify(`Herder started, but the dashboard did not: ${text(error)}`, "warning");
			}
		}
		startPolling();
		render(ctx);
		const tierWarning = Object.values(profile.roles).some((role) => role.service_tier)
			? " Pi does not expose a per-child service-tier override; catalog tiers are recorded but not asserted as applied."
			: "";
		return `Herder ${options.mode} started as pi-subagents run ${identity.runId} with profile ${profile.profile} and max parallel ${options.maxParallel}.${currentState?.dashboardUrl ? ` Dashboard: ${currentState.dashboardUrl}.` : ""}${tierWarning}`;
	};

	const status = async (planDirInput: string, ctx: ExtensionContext): Promise<string> => {
		lastContext = ctx;
		if (!currentState) {
			const repoRoot = await repositoryRoot(ctx);
			const planDir = resolvePlanDirectory(repoRoot, planDirInput);
			const result = await pi.exec(process.execPath, [PLAN_MANAGER, "status", planDir], { timeout: 10_000 });
			if (result.code !== 0) throw new Error(result.stderr.trim() || "Herder status failed.");
			const summary = JSON.parse(result.stdout) as PlanSummary;
			return summaryLine(summary) || "Herder plan state is available.";
		}
		lastSummary = await queryPlanSummary();
		let rpcStatus = "";
		try {
			const data = await rpc.call<RpcData>("status", { id: currentState.runId });
			rpcStatus = data.text ? `\n${data.text.slice(0, 1_500)}` : "";
		} catch (error) {
			rpcStatus = `\npi-subagents status unavailable: ${text(error)}`;
		}
		render(ctx);
		return [stateLine(currentState), summaryLine(lastSummary), currentState.dashboardUrl, rpcStatus].filter(Boolean).join("\n");
	};

	const dashboardCommand = async (planDirInput: string, ctx: ExtensionContext): Promise<string> => {
		const repoRoot = await repositoryRoot(ctx);
		const planDir = resolvePlanDirectory(repoRoot, planDirInput);
		const url = await startDashboard(planDir, 0);
		if (currentState && currentState.planDir === planDir) persist({ ...currentState, dashboardEnabled: true, dashboardUrl: url, updatedAt: Date.now() });
		render(ctx);
		return `Herder dashboard: ${url}`;
	};

	const stop = async (ctx: ExtensionContext): Promise<string> => {
		if (!currentState || currentState.status !== "running") return "No active Herder run.";
		await rpc.call("stop", { id: currentState.runId });
		persist({ ...currentState, status: "stopped", updatedAt: Date.now() });
		stopPolling();
		render(ctx);
		return `Stop requested for Herder run ${currentState.runId}. Repository state was preserved.`;
	};

	const runCommand = (handler: (args: string, ctx: ExtensionContext) => Promise<string>) => async (args: string, ctx: ExtensionContext) => {
		lastContext = ctx;
		try {
			ctx.ui.notify(await handler(args, ctx), "info");
		} catch (error) {
			ctx.ui.notify(text(error), "error");
		}
	};

	pi.registerCommand("herder-fire", {
		description: "Start a native background Herder run.",
		handler: runCommand((args, ctx) => launch(parseFireArguments(args, "fire"), ctx)),
	});
	pi.registerCommand("herder-resume", {
		description: "Resume a preserved native Herder run.",
		handler: runCommand((args, ctx) => launch(parseFireArguments(args, "resume"), ctx)),
	});
	pi.registerCommand("herder-status", {
		description: "Show native Herder and plan status.",
		handler: runCommand((args, ctx) => status(parsePlanDirArguments(args).planDir, ctx)),
	});
	pi.registerCommand("herder-dashboard", {
		description: "Open the read-only Herder dashboard on an available port.",
		handler: runCommand((args, ctx) => dashboardCommand(parsePlanDirArguments(args).planDir, ctx)),
	});
	pi.registerCommand("herder-stop", {
		description: "Stop the active Herder controller and preserve repository state.",
		handler: async (_args, ctx) => {
			lastContext = ctx;
			if (ctx.hasUI && !(await ctx.ui.confirm("Stop Herder?", "The controller and active workers will be stopped; repository state will be preserved."))) return;
			try { ctx.ui.notify(await stop(ctx), "info"); } catch (error) { ctx.ui.notify(text(error), "error"); }
		},
	});

	pi.registerTool({
		name: "herder",
		label: "Herder",
		description: "Start, resume, inspect, or open the dashboard for a native Herder plan run. Long-running execution is delegated through pi-subagents and returns immediately.",
		parameters: Type.Object({
			action: Type.Union([Type.Literal("fire"), Type.Literal("resume"), Type.Literal("status"), Type.Literal("dashboard")]),
			planDir: Type.Optional(Type.String()),
			profile: Type.Optional(Type.String()),
			maxParallel: Type.Optional(Type.Integer({ minimum: 1, maximum: 32 })),
			dashboard: Type.Optional(Type.Boolean()),
		}),
		async execute(_id, params, _signal, _onUpdate, ctx) {
			lastContext = ctx;
			try {
				if (params.action === "status") return toolResult(await status(params.planDir || "herder-plans", ctx));
				if (params.action === "dashboard") return toolResult(await dashboardCommand(params.planDir || "herder-plans", ctx));
				const options: FireOptions = {
					mode: params.action,
					planDir: params.planDir || "herder-plans",
					...(params.profile ? { profile: params.profile } : {}),
					maxParallel: params.maxParallel || 5,
					dashboard: params.dashboard !== false,
					dashboardPort: 0,
				};
				return toolResult(await launch(options, ctx));
			} catch (error) {
				return toolResult(text(error), true);
			}
		},
	});

	pi.registerEntryRenderer<HerderRunState>(HERDER_STATE_ENTRY, (entry, _options, theme) => {
		const state = entry.data;
		if (!state) return new Text(theme.fg("warning", "Herder state unavailable"), 0, 0);
		return new Text(theme.fg(state.status === "running" ? "accent" : state.status === "complete" ? "success" : "warning", `Herder ${stateLine(state)}`), 0, 0);
	});

	pi.events.on(SUBAGENT_ASYNC_COMPLETE_EVENT, (payload) => {
		if (!currentState || completionRunId(payload) !== currentState.runId) return;
		persist({ ...currentState, status: terminalState(payload), updatedAt: Date.now() });
		stopPolling();
		void poll();
		render();
	});

	pi.on("session_start", async (_event, ctx) => {
		lastContext = ctx;
		currentState = restoreLastRun(ctx.sessionManager.getEntries());
		if (currentState?.dashboardUrl) currentState = { ...currentState, dashboardUrl: undefined };
		if (currentState?.status === "running" && currentState.dashboardEnabled) {
			try {
				const dashboardUrl = await startDashboard(currentState.planDir, 0);
				persist({ ...currentState, dashboardUrl, updatedAt: Date.now() });
			} catch (error) {
				ctx.ui.notify(`Herder dashboard did not restart: ${text(error)}`, "warning");
			}
		}
		render(ctx);
		if (currentState) startPolling();
	});

	pi.on("session_shutdown", async () => {
		stopPolling();
		if (dashboard) await dashboard.close().catch(() => {});
		dashboard = undefined;
		dashboardPlanDir = undefined;
		lastContext = undefined;
	});
}

import type { ResolvedPiProfile } from "./profile.ts";

export interface ControllerTaskInput {
	mode: "fire" | "resume";
	repoRoot: string;
	planDir: string;
	maxParallel: number;
	profile: ResolvedPiProfile;
	piProtocolPath: string;
	canonicalProtocolPath: string;
	planManagerPath: string;
	profileRegistryPath: string;
	helperRoot: string;
	roleContractPaths: Record<string, string>;
}

export function buildControllerTask(input: ControllerTaskInput): string {
	return [
		"HERDER_PI_CONTROLLER_V1",
		`MODE: ${input.mode.toUpperCase()}`,
		`REPOSITORY: ${input.repoRoot}`,
		`PLAN_DIRECTORY: ${input.planDir}`,
		`MAX_PARALLEL: ${input.maxParallel}`,
		`PI_PROTOCOL_PATH: ${input.piProtocolPath}`,
		`CANONICAL_PROTOCOL_PATH: ${input.canonicalProtocolPath}`,
		`PLAN_MANAGER_PATH: ${input.planManagerPath}`,
		`PROFILE_REGISTRY_PATH: ${input.profileRegistryPath}`,
		`HELPER_ROOT: ${input.helperRoot}`,
		`PROFILE: ${JSON.stringify(input.profile)}`,
		`ROLE_CONTRACT_PATHS: ${JSON.stringify(input.roleContractPaths)}`,
		"",
		"Read both protocol files completely before any mutation. Resolve and bind the exact profile for host pi. Then execute or resume the complete Herder run directly. Use one background pi-subagents workflow per worker, keep a rolling worker pool, and use subagent_wait for first-completion backfill. Do not return until terminal completion, a preserved irreducible need for user input, or a proven terminal failure.",
	].join("\n");
}

export function controllerWorkflowScript(input: {
	agent: string;
	task: string;
	cwd: string;
	model: string;
	thinking: string;
}): string {
	return `return runs.run("herder-controller", ${JSON.stringify({
		agent: input.agent,
		task: input.task,
		cwd: input.cwd,
		context: "fresh",
		model: input.model,
		thinking: input.thinking,
		acceptance: false,
		artifacts: true,
	})})`;
}

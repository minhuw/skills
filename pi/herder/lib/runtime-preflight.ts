import { readFile } from "node:fs/promises";
import path from "node:path";
import {
	HERDER_ROLES,
	modelMatches,
	modelSupportsEffort,
	type AvailableModel,
	type ResolvedPiProfile,
} from "./profile.ts";

export const PI_SUBAGENTS_INSTALL_COMMAND = "pi install npm:pi-subagents";
export const PI_SUBAGENTS_RPC_PROTOCOL_VERSION = 1;

interface RuntimePing {
	version?: unknown;
	methods?: unknown;
	capabilities?: {
		asyncSpawn?: unknown;
		resume?: unknown;
	};
}

const REQUIRED_RPC_METHODS = ["spawn", "status", "stop", "resume"] as const;

function frontmatter(contents: string): Map<string, string> {
	const match = /^---\r?\n([\s\S]*?)\r?\n---(?:\r?\n|$)/.exec(contents);
	if (!match) throw new Error("missing YAML frontmatter");
	const fields = new Map<string, string>();
	for (const line of match[1].split(/\r?\n/)) {
		const separator = line.indexOf(":");
		if (separator < 1) continue;
		fields.set(line.slice(0, separator).trim(), line.slice(separator + 1).trim());
	}
	return fields;
}

export function assertPiSubagentsRuntime(value: unknown): void {
	const ping = value && typeof value === "object" && !Array.isArray(value) ? value as RuntimePing : {};
	const methods = Array.isArray(ping.methods) ? ping.methods.filter((entry): entry is string => typeof entry === "string") : [];
	if (
		ping.version !== PI_SUBAGENTS_RPC_PROTOCOL_VERSION
		|| ping.capabilities?.asyncSpawn !== true
		|| ping.capabilities?.resume !== true
		|| REQUIRED_RPC_METHODS.some((method) => !methods.includes(method))
	) {
		throw new Error(`The installed pi-subagents runtime is incompatible with Herder. Update it with \`${PI_SUBAGENTS_INSTALL_COMMAND}\` and restart Pi.`);
	}
}

export async function validateHerderRoleAgents(
	agentRoot: string,
	profile: ResolvedPiProfile,
	availableModels: readonly AvailableModel[],
): Promise<void> {
	for (const role of HERDER_ROLES) {
		const mapping = profile.roles[role];
		const expectedAgent = `herder.${role}`;
		if (mapping.agent_type !== expectedAgent) {
			throw new Error(`Herder role ${role} must use package agent ${expectedAgent}, not ${mapping.agent_type}.`);
		}

		const candidate = availableModels.find((model) => modelMatches(mapping.model, model));
		if (!candidate || !modelSupportsEffort(candidate, mapping.effort)) {
			throw new Error(`Herder role ${expectedAgent} cannot start because ${mapping.model} does not support thinking ${mapping.effort}.`);
		}

		const file = path.join(agentRoot, `${role}.md`);
		let fields: Map<string, string>;
		try {
			fields = frontmatter(await readFile(file, "utf8"));
		} catch (error) {
			const detail = error instanceof Error ? error.message : String(error);
			throw new Error(`Herder package agent ${expectedAgent} is invalid at ${file}: ${detail}`);
		}
		if (fields.get("name") !== role || fields.get("package") !== "herder") {
			throw new Error(`Herder package agent ${expectedAgent} has mismatched name or package metadata at ${file}.`);
		}
	}
}

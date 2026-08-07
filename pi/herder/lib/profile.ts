import { createHash } from "node:crypto";
import { readFile } from "node:fs/promises";

export const HERDER_ROLES = [
	"plan-implementer",
	"plan-reviewer",
	"plan-judge",
] as const;

export type HerderRole = typeof HERDER_ROLES[number];

export const THINKING_EFFORTS = ["off", "minimal", "low", "medium", "high", "xhigh", "max"] as const;
export type ThinkingEffort = typeof THINKING_EFFORTS[number];

export interface RoleMapping {
	agent_type: string;
	model: string;
	effort: ThinkingEffort;
	service_tier?: "fast" | "standard";
}

export interface ResolvedPiProfile {
	profile: string;
	profile_sha256: string;
	host: "pi";
	defaulted: boolean;
	orchestrator: { model: string; effort: RoleMapping["effort"] };
	roles: Record<HerderRole, RoleMapping>;
}

interface CatalogProfile {
	name: string;
	description: string;
	hosts: string[];
	orchestrator: { model: string; effort: RoleMapping["effort"] };
	roles: Record<HerderRole, Omit<RoleMapping, "agent_type">>;
}

interface ProfileCatalog {
	schema_version: number;
	defaults: Record<string, string>;
	profiles: CatalogProfile[];
}

function stableJson(value: unknown): string {
	if (Array.isArray(value)) return `[${value.map(stableJson).join(",")}]`;
	if (value && typeof value === "object") {
		return `{${Object.keys(value as Record<string, unknown>).sort().map((key) => `${JSON.stringify(key)}:${stableJson((value as Record<string, unknown>)[key])}`).join(",")}}`;
	}
	return JSON.stringify(value);
}

function sha256(value: string): string {
	return createHash("sha256").update(value).digest("hex");
}

function validateCatalog(value: unknown): ProfileCatalog {
	if (!value || typeof value !== "object" || Array.isArray(value)) throw new Error("Herder profile catalog must be an object.");
	const catalog = value as ProfileCatalog;
	if (catalog.schema_version !== 1 || !catalog.defaults || !Array.isArray(catalog.profiles)) throw new Error("Unsupported Herder profile catalog.");
	if (typeof catalog.defaults.pi !== "string") throw new Error("Herder profile catalog has no Pi default.");
	for (const profile of catalog.profiles) {
		if (!profile || typeof profile.name !== "string" || !Array.isArray(profile.hosts)) {
			throw new Error("Every Herder profile must have a valid name and hosts list.");
		}
		if (!profile.orchestrator?.model || !profile.orchestrator.effort) throw new Error(`Profile ${profile.name} has no orchestrator mapping.`);
		if (HERDER_ROLES.some((role) => !profile.roles?.[role]?.model || !profile.roles[role].effort)) {
			throw new Error(`Profile ${profile.name} has an incomplete role mapping.`);
		}
	}
	return catalog;
}

export async function loadPiProfile(catalogPath: string, requested?: string): Promise<ResolvedPiProfile> {
	const catalog = validateCatalog(JSON.parse(await readFile(catalogPath, "utf8")) as unknown);
	const name = requested || catalog.defaults.pi;
	const profile = catalog.profiles.find((candidate) => candidate.name === name);
	if (!profile) throw new Error(`Unknown Herder profile ${JSON.stringify(name)}.`);
	if (!profile.hosts.includes("pi")) throw new Error(`Herder profile ${JSON.stringify(name)} does not support Pi.`);
	const roles = Object.fromEntries(HERDER_ROLES.map((role) => [role, {
		agent_type: `herder.${role}`,
		...profile.roles[role],
	}])) as Record<HerderRole, RoleMapping>;
	return {
		profile: name,
		profile_sha256: sha256(stableJson(profile)),
		host: "pi",
		defaulted: requested === undefined,
		orchestrator: profile.orchestrator,
		roles,
	};
}

export interface AvailableModel {
	provider?: string;
	id?: string;
	fullId?: string;
	reasoning?: boolean;
	thinkingLevelMap?: Partial<Record<ThinkingEffort, string | null>>;
}

export function modelMatches(requested: string, candidate: AvailableModel): boolean {
	const id = candidate.id || "";
	const fullId = candidate.fullId || (candidate.provider && id ? `${candidate.provider}/${id}` : "");
	return requested === id || requested === fullId || fullId.endsWith(`/${requested}`);
}

export function unavailableProfileModels(profile: ResolvedPiProfile, available: readonly AvailableModel[]): string[] {
	const required = new Set([profile.orchestrator.model, ...HERDER_ROLES.map((role) => profile.roles[role].model)]);
	return [...required].filter((model) => !available.some((candidate) => modelMatches(model, candidate)));
}

export function modelSupportsEffort(model: AvailableModel, effort: ThinkingEffort): boolean {
	if (model.reasoning === false) return effort === "off";
	if (!model.thinkingLevelMap) return effort !== "max";
	const mapped = model.thinkingLevelMap[effort];
	if (mapped === null) return false;
	if (effort === "xhigh" || effort === "max") return mapped !== undefined;
	return true;
}

export function effectiveModelSupportsEffort(
	effectiveModel: string | undefined,
	effort: ThinkingEffort,
	available: readonly AvailableModel[],
): boolean {
	if (!effectiveModel) return false;
	const suffix = `:${effort}`;
	const fullId = effectiveModel.endsWith(suffix) ? effectiveModel.slice(0, -suffix.length) : effectiveModel;
	const model = available.find((candidate) => {
		const candidateFullId = candidate.fullId || (candidate.provider && candidate.id ? `${candidate.provider}/${candidate.id}` : "");
		return candidateFullId === fullId;
	});
	return Boolean(model && modelSupportsEffort(model, effort));
}

export function activeModelMatches(profile: ResolvedPiProfile, active: AvailableModel | undefined): boolean {
	return Boolean(active && modelMatches(profile.orchestrator.model, active));
}

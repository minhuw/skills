import assert from "node:assert/strict";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";
import { loadPiProfile } from "../lib/profile.ts";
import {
	assertPiSubagentsRuntime,
	validateHerderRoleAgents,
} from "../lib/runtime-preflight.ts";

const packageRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../../..");
const catalog = path.join(packageRoot, "plugins/herder/agent-profiles/profiles.json");
const agentRoot = path.join(packageRoot, "pi/herder/agents");

const runtimePing = {
	version: 1,
	methods: ["ping", "spawn", "status", "stop", "resume"],
	capabilities: { asyncSpawn: true, resume: true },
};

test("separately installed pi-subagents runtime must expose the required RPC contract", () => {
	assert.doesNotThrow(() => assertPiSubagentsRuntime(runtimePing));
	assert.throws(() => assertPiSubagentsRuntime(undefined), /Update it with `pi install npm:pi-subagents`/);
	assert.throws(() => assertPiSubagentsRuntime({ ...runtimePing, version: 2 }), /incompatible/);
	assert.throws(() => assertPiSubagentsRuntime({ ...runtimePing, methods: ["spawn"] }), /incompatible/);
});

test("Herder validates its package-owned role agents and model efforts locally", async () => {
	const profile = await loadPiProfile(catalog, "offcut");
	const available = [
		{ provider: "proxy", id: "kimi-k3", fullId: "proxy/kimi-k3", thinkingLevelMap: { max: "max" } },
		{ provider: "proxy", id: "grok-4.5", fullId: "proxy/grok-4.5", thinkingLevelMap: { high: "high", max: null } },
		{ provider: "proxy", id: "gpt-5.6-sol", fullId: "proxy/gpt-5.6-sol", thinkingLevelMap: { xhigh: "xhigh", max: "max" } },
	];
	await assert.doesNotReject(() => validateHerderRoleAgents(agentRoot, profile, available));
	await assert.rejects(
		() => validateHerderRoleAgents(agentRoot, profile, available.map((model) => model.id === "grok-4.5" ? { ...model, thinkingLevelMap: { high: null, max: null } } : model)),
		/does not support thinking high/,
	);
});

test("Herder rejects malformed package-owned agent metadata", async () => {
	const profile = await loadPiProfile(catalog, "offcut");
	const root = await mkdtemp(path.join(os.tmpdir(), "herder-agent-preflight-"));
	try {
		for (const role of ["plan-accountant", "plan-implementer", "plan-reviewer", "plan-judge", "plan-saver"]) {
			await writeFile(path.join(root, `${role}.md`), `---\nname: ${role}\npackage: herder\n---\n`);
		}
		await writeFile(path.join(root, "plan-reviewer.md"), "---\nname: wrong\npackage: herder\n---\n");
		const available = [
			{ provider: "proxy", id: "kimi-k3", thinkingLevelMap: { max: "max" } },
			{ provider: "proxy", id: "grok-4.5", thinkingLevelMap: { high: "high" } },
			{ provider: "proxy", id: "gpt-5.6-sol", thinkingLevelMap: { xhigh: "xhigh", max: "max" } },
		];
		await assert.rejects(() => validateHerderRoleAgents(root, profile, available), /mismatched name or package metadata/);
	} finally {
		await rm(root, { recursive: true, force: true });
	}
});

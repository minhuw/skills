import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";
import {
	activeModelMatches,
	effectiveModelSupportsEffort,
	loadPiProfile,
	modelMatches,
	modelSupportsEffort,
	unavailableProfileModels,
} from "../lib/profile.ts";

const packageRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../../..");
const catalog = path.join(packageRoot, "plugins/herder/agent-profiles/profiles.json");
const registry = path.join(packageRoot, "plugins/herder/agent-profiles/scripts/profile-registry.mjs");

test("Pi resolves profile models into five generic package agents", async () => {
	const profile = await loadPiProfile(catalog, "offcut");
	assert.equal(profile.host, "pi");
	assert.equal(profile.defaulted, false);
	assert.deepEqual(profile.orchestrator, { model: "kimi-k3", effort: "max" });
	assert.equal(profile.roles["plan-accountant"].agent_type, "herder.plan-accountant");
	assert.equal(profile.roles["plan-accountant"].model, "grok-4.5");
	assert.equal(profile.roles["plan-accountant"].effort, "high");
	assert.equal(profile.roles["plan-reviewer"].agent_type, "herder.plan-reviewer");

	const registryProfile = JSON.parse(execFileSync(process.execPath, [registry, "resolve", "--host", "pi", "--profile", "offcut"], { encoding: "utf8" }));
	assert.equal(profile.profile_sha256, registryProfile.profile_sha256);
	assert.deepEqual(profile.roles, registryProfile.roles);
});

test("Pi rejects thinking levels that the resolved model cannot honor", () => {
	const grok = {
		provider: "proxy",
		id: "grok-4.5",
		fullId: "proxy/grok-4.5",
		reasoning: true,
		thinkingLevelMap: { low: "low", medium: "medium", high: "high", xhigh: null, max: null },
	};
	assert.equal(modelSupportsEffort(grok, "high"), true);
	assert.equal(modelSupportsEffort(grok, "max"), false);
	assert.equal(effectiveModelSupportsEffort("proxy/grok-4.5:high", "high", [grok]), true);
	assert.equal(effectiveModelSupportsEffort("proxy/grok-4.5:max", "max", [grok]), false);
	assert.equal(effectiveModelSupportsEffort("other/grok-4.5:high", "high", [grok]), false);
});

test("model checks accept provider-qualified catalog entries without substitution", async () => {
	const profile = await loadPiProfile(catalog, "offcut");
	const available = [
		{ provider: "proxy", id: "kimi-k3", fullId: "proxy/kimi-k3" },
		{ provider: "proxy", id: "grok-4.5", fullId: "proxy/grok-4.5" },
		{ provider: "proxy", id: "gpt-5.6-sol", fullId: "proxy/gpt-5.6-sol" },
	];
	assert.deepEqual(unavailableProfileModels(profile, available), []);
	assert.equal(activeModelMatches(profile, available[0]), true);
	assert.equal(modelMatches("other/kimi-k3", available[0]), false);
	assert.deepEqual(unavailableProfileModels(profile, available.slice(0, 2)), ["gpt-5.6-sol"]);
});

test("a profile for another host does not invalidate Pi's selected profile", async () => {
	const root = mkdtempSync(path.join(os.tmpdir(), "herder-pi-profiles-"));
	try {
		const modified = JSON.parse(readFileSync(catalog, "utf8"));
		modified.profiles.push({ ...modified.profiles[0], name: "codex-only", hosts: ["codex"] });
		const fixture = path.join(root, "profiles.json");
		writeFileSync(fixture, JSON.stringify(modified));
		assert.equal((await loadPiProfile(fixture, "eclipse")).profile, "eclipse");
		await assert.rejects(() => loadPiProfile(fixture, "codex-only"), /does not support Pi/);
	} finally {
		rmSync(root, { recursive: true, force: true });
	}
});

import assert from "node:assert/strict";
import test from "node:test";
import { buildControllerTask, controllerWorkflowScript } from "../lib/controller-task.ts";
import type { ResolvedPiProfile } from "../lib/profile.ts";

const profile: ResolvedPiProfile = {
	profile: "offcut",
	profile_sha256: "a".repeat(64),
	host: "pi",
	defaulted: false,
	orchestrator: { model: "kimi-k3", effort: "max" },
	roles: {
		"plan-accountant": { agent_type: "herder.plan-accountant", model: "grok-4.5", effort: "max" },
		"plan-implementer": { agent_type: "herder.plan-implementer", model: "grok-4.5", effort: "high" },
		"plan-reviewer": { agent_type: "herder.plan-reviewer", model: "gpt-5.6-sol", effort: "xhigh" },
		"plan-judge": { agent_type: "herder.plan-judge", model: "gpt-5.6-sol", effort: "xhigh" },
		"plan-saver": { agent_type: "herder.plan-saver", model: "gpt-5.6-sol", effort: "max" },
	},
};

test("controller task carries exact durable inputs", () => {
	const task = buildControllerTask({
		mode: "resume",
		repoRoot: "/tmp/repo",
		planDir: "/tmp/repo/herder-plans",
		maxParallel: 5,
		profile,
		piProtocolPath: "/pkg/pi-protocol.md",
		canonicalProtocolPath: "/pkg/orchestration-protocol.md",
		planManagerPath: "/pkg/herder-plans.mjs",
		profileRegistryPath: "/pkg/profile-registry.mjs",
		helperRoot: "/pkg/scripts",
		roleContractPaths: { "plan-reviewer": "/pkg/plan-reviewer.md" },
	});
	assert.match(task, /^HERDER_PI_CONTROLLER_V1/m);
	assert.match(task, /^MAX_PARALLEL: 5$/m);
	assert.match(task, /^PROFILE_REGISTRY_PATH: \/pkg\/profile-registry\.mjs$/m);
	assert.match(task, /"agent_type":"herder\.plan-reviewer"/);
	assert.match(task, /first-completion backfill/);
});

test("workflow script safely serializes untrusted-looking task text", () => {
	const script = controllerWorkflowScript({
		agent: "herder.plan-accountant",
		task: "line\n`); throw new Error('bad') //",
		cwd: "/tmp/repo with spaces",
		model: "grok-4.5",
		thinking: "max",
	});
	assert.match(script, /^return runs\.run\("herder-controller", /);
	assert.match(script, /"context":"fresh"/);
	assert.doesNotMatch(script, /\n`\); throw/);
});

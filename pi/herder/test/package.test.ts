import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import path from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";

const packageRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../../..");

test("Pi package registers Herder without double-loading pi-subagents", async () => {
	const manifest = JSON.parse(await readFile(path.join(packageRoot, "package.json"), "utf8"));
	assert.deepEqual(manifest.pi.extensions, ["./pi/herder/index.ts"]);
	assert.deepEqual(manifest.pi.subagents.agents, ["./pi/herder/agents"]);
	assert.equal(Object.hasOwn(manifest.pi, "skills"), false);
	assert.equal(Object.hasOwn(manifest, "dependencies"), false);
	assert.equal(Object.hasOwn(manifest, "bundledDependencies"), false);
	assert.equal(Object.hasOwn(manifest.peerDependencies, "pi-subagents"), false);
});

test("controller owns nested dispatch while workers cannot recurse", async () => {
	const agentDir = path.join(packageRoot, "pi/herder/agents");
	const controller = await readFile(path.join(agentDir, "plan-accountant.md"), "utf8");
	assert.match(controller, /^package: herder$/m);
	assert.match(controller, /^tools: .*subagent, subagent_wait$/m);
	assert.match(controller, /^maxSubagentDepth: 2$/m);

	for (const role of ["plan-implementer", "plan-reviewer", "plan-judge", "plan-saver"]) {
		const contents = await readFile(path.join(agentDir, `${role}.md`), "utf8");
		assert.match(contents, /^package: herder$/m);
		assert.doesNotMatch(contents, /^tools: .*subagent/m);
		assert.match(contents, /ROLE_CONTRACT_PATH/);
	}
});

test("Pi overlay specifies rolling first-completion scheduling and stable worktrees", async () => {
	const protocol = await readFile(path.join(packageRoot, "pi/herder/pi-orchestration.md"), "utf8");
	assert.match(protocol, /rolling, role-agnostic pool/);
	assert.match(protocol, /subagent_wait` without `all:true`/);
	assert.match(protocol, /Never use `pi-subagents` managed temporary worktrees/);
	assert.match(protocol, /async run ID is opaque/);
	assert.match(protocol, /including separators such as `\|`/);
	assert.match(protocol, /Integration is still the only cross-plan lock/);
	assert.match(protocol, /never returns `ACTIONS` for the outer Pi session to execute/);
});

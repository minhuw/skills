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

test("deterministic manager owns scheduling while workers cannot recurse", async () => {
	const agentDir = path.join(packageRoot, "pi/herder/agents");
	const extension = await readFile(path.join(packageRoot, "pi/herder/index.ts"), "utf8");
	assert.match(extension, /runtime\/client\.ts/);
	assert.match(extension, /rpc\.call\("spawn", \{\s*agent: action\.agentType,/);
	assert.match(extension, /updateFromReply\(reply\);\s*await dispatchReply\(reply\);/);
	assert.match(extension, /artifacts: false,\s*mission: false,/);
	assert.doesNotMatch(extension, /buildControllerTask|controllerWorkflowScript|workflowScript:/);

	for (const role of ["plan-implementer", "plan-reviewer", "plan-judge"]) {
		const contents = await readFile(path.join(agentDir, `${role}.md`), "utf8");
		assert.match(contents, /^package: herder$/m);
		assert.doesNotMatch(contents, /^tools: .*subagent/m);
		assert.match(contents, /ROLE_CONTRACT_PATH/);
	}
});

test("Pi overlay specifies manager-owned scheduling and stable worktrees", async () => {
	const protocol = await readFile(path.join(packageRoot, "pi/herder/pi-orchestration.md"), "utf8");
	assert.match(protocol, /same deterministic Herder Run Manager/);
	assert.match(protocol, /no managed temporary worktree/);
	assert.match(protocol, /opaque `pi-subagents` run IDs/);
	assert.match(protocol, /No control slot is reserved/);
	assert.match(protocol, /only integration is serialized/);
});

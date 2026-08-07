#!/usr/bin/env node

import assert from "node:assert/strict";
import { execFileSync, spawnSync } from "node:child_process";
import { readFile } from "node:fs/promises";
import path from "node:path";
import process from "node:process";
import { fileURLToPath } from "node:url";

const scriptDir = path.dirname(fileURLToPath(import.meta.url));
const registry = path.join(scriptDir, "profile-registry.mjs");
const pluginRoot = path.resolve(scriptDir, "../..");
const roles = ["plan-implementer", "plan-reviewer", "plan-judge"];
const run = (...args) => JSON.parse(execFileSync(process.execPath, [registry, ...args], { encoding: "utf8" }));

run("check");
const listed = run("list");
assert.deepEqual(listed.defaults, { codex: "eclipse", claude: "shannon", pi: "eclipse" });
assert.deepEqual(listed.profiles.map((profile) => profile.name), ["eclipse", "shannon", "offcut"]);

const codex = run("resolve", "--host", "codex");
assert.equal(codex.profile, "eclipse");
assert.deepEqual(Object.keys(codex.roles), roles);
assert.deepEqual(codex.roles["plan-implementer"], {
  agent_type: "eclipse_plan_implementer",
  model: "gpt-5.6-luna",
  effort: "max",
  service_tier: "fast",
});

const claude = run("resolve", "--host", "claude");
assert.equal(claude.profile, "shannon");
assert.deepEqual(Object.keys(claude.roles), roles);
assert.equal(claude.roles["plan-reviewer"].agent_type, "herder:shannon-plan-reviewer");

const pi = run("resolve", "--host", "pi", "--profile", "offcut");
assert.deepEqual(Object.keys(pi.roles), roles);
assert.equal(pi.roles["plan-implementer"].agent_type, "herder.plan-implementer");
assert.equal(pi.roles["plan-implementer"].model, "grok-4.5");

for (const host of ["codex", "claude", "pi"]) {
  const profile = run("resolve", "--host", host, "--profile", "offcut");
  assert.deepEqual(profile.orchestrator, { model: "kimi-k3", effort: "max" });
  assert.equal(profile.roles["plan-implementer"].model, "grok-4.5");
  assert.equal(profile.roles["plan-reviewer"].model, "gpt-5.6-sol");
  assert.equal(profile.roles["plan-judge"].effort, "xhigh");
}

const unsupported = spawnSync(process.execPath, [registry, "resolve", "--host", "codex", "--profile", "shannon"], { encoding: "utf8" });
assert.equal(unsupported.status, 1);
assert.match(unsupported.stderr, /does not support codex/);

const manifest = JSON.parse(await readFile(path.join(pluginRoot, "agent-profiles/manifest.json"), "utf8"));
assert.equal(manifest.hosts.codex.files.length, 6);
assert.equal(manifest.hosts.claude.files.length, 9);
assert.equal(manifest.hosts.pi.files.length, 3);
assert.equal(manifest.hosts.codex.files.some((file) => file.legacy), false);
assert.deepEqual(Object.keys(manifest.profiles.offcut.hosts.pi.roles), roles);

const generatedImplementer = await readFile(path.join(pluginRoot, "agent-profiles/generated/codex/offcut_plan_implementer.toml"), "utf8");
assert.match(generatedImplementer, /^name = "offcut_plan_implementer"$/m);
assert.match(generatedImplementer, /^model = "grok-4\.5"$/m);

const generatedReviewer = await readFile(path.join(pluginRoot, "agents/eclipse-plan-reviewer.md"), "utf8");
assert.match(generatedReviewer, /^name: eclipse-plan-reviewer$/m);
assert.match(generatedReviewer, /^model: gpt-5\.6-sol$/m);

console.log("herder profile registry tests passed");

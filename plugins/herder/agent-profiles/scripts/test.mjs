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

function run(...args) {
  return JSON.parse(execFileSync(process.execPath, [registry, ...args], { encoding: "utf8" }));
}

run("check");
const listed = run("list");
assert.deepEqual(listed.defaults, { codex: "eclipse", claude: "shannon" });
assert.deepEqual(listed.profiles.map((profile) => profile.name), ["eclipse", "shannon", "offcut"]);
assert.equal(listed.profiles.every((profile) => /^[0-9a-f]{64}$/.test(profile.sha256)), true);

const codexDefault = run("resolve", "--host", "codex");
assert.equal(codexDefault.profile, "eclipse");
assert.equal(codexDefault.defaulted, true);
assert.deepEqual(codexDefault.orchestrator, { model: "gpt-5.6-sol", effort: "max" });
assert.equal(codexDefault.roles["plan-accountant"].agent_type, "eclipse_plan_accountant");
assert.deepEqual(codexDefault.roles["plan-accountant"], {
  agent_type: "eclipse_plan_accountant",
  model: "gpt-5.6-luna",
  effort: "max",
  service_tier: "fast",
});

const claudeDefault = run("resolve", "--host", "claude");
assert.equal(claudeDefault.profile, "shannon");
assert.deepEqual(claudeDefault.orchestrator, { model: "claude-opus-4-8", effort: "high" });
assert.equal(claudeDefault.roles["plan-accountant"].agent_type, "herder:shannon-plan-accountant");
assert.equal(claudeDefault.roles["plan-accountant"].model, "claude-opus-4-8");
assert.equal(claudeDefault.roles["plan-accountant"].effort, "medium");

const eclipseOnClaude = run("resolve", "--host", "claude", "--profile", "eclipse");
assert.equal(eclipseOnClaude.profile, "eclipse");
assert.equal(eclipseOnClaude.defaulted, false);
assert.deepEqual(eclipseOnClaude.roles["plan-accountant"], {
  agent_type: "herder:eclipse-plan-accountant",
  model: "gpt-5.6-luna",
  effort: "max",
});
assert.equal(eclipseOnClaude.roles["plan-reviewer"].agent_type, "herder:eclipse-plan-reviewer");
assert.equal(eclipseOnClaude.roles["plan-reviewer"].model, "gpt-5.6-sol");
assert.equal(eclipseOnClaude.roles["plan-reviewer"].effort, "xhigh");

for (const host of ["codex", "claude"]) {
  const frontier = run("resolve", "--host", host, "--profile", "offcut");
  assert.equal(frontier.defaulted, false);
  assert.deepEqual(frontier.orchestrator, { model: "kimi-k3", effort: "max" });
  assert.equal(frontier.roles["plan-accountant"].model, "grok-4.5");
  assert.equal(frontier.roles["plan-accountant"].effort, "max");
  assert.equal(frontier.roles["plan-implementer"].model, "grok-4.5");
  assert.equal(frontier.roles["plan-implementer"].effort, "high");
  assert.equal(frontier.roles["plan-reviewer"].model, "gpt-5.6-sol");
  assert.equal(frontier.roles["plan-reviewer"].effort, "xhigh");
  assert.equal(frontier.roles["plan-judge"].effort, "xhigh");
  assert.equal(frontier.roles["plan-saver"].effort, "max");
}

const unsupported = spawnSync(process.execPath, [registry, "resolve", "--host", "codex", "--profile", "shannon"], { encoding: "utf8" });
assert.equal(unsupported.status, 1);
assert.match(unsupported.stderr, /does not support codex/);
const unknown = spawnSync(process.execPath, [registry, "resolve", "--host", "codex", "--profile", "missing"], { encoding: "utf8" });
assert.equal(unknown.status, 1);
assert.match(unknown.stderr, /Unknown Herder profile/);

const manifest = JSON.parse(await readFile(path.join(pluginRoot, "agent-profiles/manifest.json"), "utf8"));
assert.equal(manifest.schema_version, 2);
assert.equal(manifest.hosts.codex.files.length, 15);
assert.equal(manifest.hosts.claude.files.length, 20);
assert.equal(new Set(manifest.hosts.codex.files.map((file) => file.target)).size, 15);
assert.equal(new Set(manifest.hosts.claude.files.map((file) => file.identifier)).size, 20);

const generatedImplementer = await readFile(path.join(pluginRoot, "agent-profiles/generated/codex/offcut_plan_implementer.toml"), "utf8");
assert.match(generatedImplementer, /^name = "offcut_plan_implementer"$/m);
assert.match(generatedImplementer, /^model = "grok-4\.5"$/m);
assert.doesNotMatch(generatedImplementer, /^service_tier\s*=/m);
assert.match(generatedImplementer, /Treat the provided plan worktree and branch as the only repository target/);

const generatedAccountant = await readFile(path.join(pluginRoot, "agent-profiles/generated/codex/offcut_plan_accountant.toml"), "utf8");
assert.match(generatedAccountant, /^model = "grok-4\.5"$/m);
assert.match(generatedAccountant, /bind the resolved profile/);
assert.match(generatedAccountant, /selected agent type, model, effort/);
assert.match(generatedAccountant, /Never fall back to another definition/);

const generatedClaudeSaver = await readFile(path.join(pluginRoot, "agents/offcut-plan-saver.md"), "utf8");
assert.match(generatedClaudeSaver, /^name: offcut-plan-saver$/m);
assert.match(generatedClaudeSaver, /^model: gpt-5\.6-sol$/m);
assert.match(generatedClaudeSaver, /^effort: max$/m);

const generatedClaudeAccountant = await readFile(path.join(pluginRoot, "agents/offcut-plan-accountant.md"), "utf8");
assert.match(generatedClaudeAccountant, /bind the resolved profile/);
assert.match(generatedClaudeAccountant, /selected agent type, model, effort/);
assert.match(generatedClaudeAccountant, /Never fall back to another definition/);

const generatedClaudeEclipseReviewer = await readFile(path.join(pluginRoot, "agents/eclipse-plan-reviewer.md"), "utf8");
assert.match(generatedClaudeEclipseReviewer, /^name: eclipse-plan-reviewer$/m);
assert.match(generatedClaudeEclipseReviewer, /^model: gpt-5\.6-sol$/m);
assert.match(generatedClaudeEclipseReviewer, /^effort: xhigh$/m);

console.log("herder profile registry tests passed");

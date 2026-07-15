#!/usr/bin/env node

import assert from "node:assert/strict";
import { execFileSync, spawnSync } from "node:child_process";
import { access, mkdtemp, readFile, readdir, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import process from "node:process";
import { fileURLToPath } from "node:url";

const scriptDir = path.dirname(fileURLToPath(import.meta.url));
const installer = path.join(scriptDir, "install-herder.mjs");
const pluginRoot = path.resolve(scriptDir, "../../..");
const fixtureRoot = await mkdtemp(path.join(tmpdir(), "herder-plugin-install-test-"));

function run(...args) {
  return execFileSync(process.execPath, [installer, ...args], {
    encoding: "utf8",
    stdio: ["ignore", "pipe", "pipe"],
  });
}

try {
  const projectRoot = path.join(fixtureRoot, "project");
  const common = ["--host", "codex", "--project-root", projectRoot];

  const first = run(...common);
  assert.match(first, /Installed: .*plan_implementer\.toml/);
  const installed = path.join(projectRoot, ".codex/agents/plan_implementer.toml");
  const source = path.join(pluginRoot, "agent-profiles/codex/plan_implementer.toml");
  assert.deepEqual(await readFile(installed), await readFile(source));

  const second = run(...common);
  assert.match(second, /Unchanged: .*plan_implementer\.toml/);

  await writeFile(installed, "customized\n");
  const conflict = spawnSync(process.execPath, [installer, ...common], { encoding: "utf8" });
  assert.equal(conflict.status, 3);
  assert.equal(await readFile(installed, "utf8"), "customized\n");

  const preview = run(...common, "--dry-run");
  assert.match(preview, /Conflict \(would preserve\): .*plan_implementer\.toml/);
  assert.equal(await readFile(installed, "utf8"), "customized\n");

  const forced = run(...common, "--force");
  assert.match(forced, /Installed \(replaced\): .*plan_implementer\.toml/);
  assert.deepEqual(await readFile(installed), await readFile(source));
  const backupRoot = path.join(projectRoot, ".codex/agents/.herder-backups");
  const stamps = await readdir(backupRoot);
  assert.equal(stamps.length, 1);
  assert.equal(await readFile(path.join(backupRoot, stamps[0], "plan_implementer.toml"), "utf8"), "customized\n");

  const claudeProject = path.join(fixtureRoot, "claude-project");
  const claude = run("--host", "claude", "--project-root", claudeProject);
  assert.match(claude, /Bundled: herder:plan-implementer/);
  await assert.rejects(access(path.join(claudeProject, ".claude/agents")));

  const allProject = path.join(fixtureRoot, "all-project");
  const all = run("--host", "all", "--project-root", allProject);
  assert.match(all, /Installed: .*plan_implementer\.toml/);
  assert.match(all, /Bundled: herder:plan-reviewer/);

  const dryProject = path.join(fixtureRoot, "dry-project");
  const dry = run("--host", "codex", "--project-root", dryProject, "--dry-run");
  assert.match(dry, /Would install: .*plan_implementer\.toml/);
  await assert.rejects(access(path.join(dryProject, ".codex/agents")));

  const badHost = spawnSync(process.execPath, [installer, "--host", "other"], { encoding: "utf8" });
  assert.equal(badHost.status, 2);

  console.log("herder plugin installer tests passed");
} finally {
  await rm(fixtureRoot, { recursive: true, force: true });
}

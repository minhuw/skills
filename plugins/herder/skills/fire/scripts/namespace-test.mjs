#!/usr/bin/env node

import assert from "node:assert/strict"
import fs from "node:fs"
import os from "node:os"
import path from "node:path"
import process from "node:process"
import { spawnSync } from "node:child_process"
import { fileURLToPath } from "node:url"
import { inspectNamespace, validatePlanName } from "./namespace-run.mjs"

const script = path.join(path.dirname(fileURLToPath(import.meta.url)), "namespace-run.mjs")

function run(command, args, { cwd, allowFailure = false } = {}) {
  const result = spawnSync(command, args, { cwd, encoding: "utf8", maxBuffer: 16 * 1024 * 1024 })
  if (!allowFailure) assert.equal(result.status, 0, result.stderr || result.stdout)
  return result
}

function git(repo, ...args) {
  return run("git", ["-C", repo, ...args]).stdout.trim()
}

function planBody(id) {
  return `# Plan ${id}: Namespace fixture

## Status

- **Priority**: P1
- **Effort**: S
- **Risk**: LOW
- **Depends on**: none
- **Category**: tests
- **Planned at**: commit \`abc1234\`, 2026-07-19

## Why this matters

Exercise Fire namespace checks.

## Current state

The fixture is empty.

## Commands you will need

| Purpose | Command | Expected on success |
|---|---|---|
| Test | \`true\` | exit 0 |

## Scope

Namespace checks only.

## Steps

### Step 1: Test

Run the fixture.

## Test plan

Run the fixture test.

## Done criteria

- [ ] \`true\` exits 0.

## STOP conditions

Stop if repository state is ambiguous.

## Maintenance notes

Keep the fixture small.
`
}

function writePlans(repo) {
  const planDir = path.join(repo, "plans")
  fs.mkdirSync(planDir)
  fs.writeFileSync(path.join(planDir, "README.md"), `# Herder Plans

## Execution order & status

| Plan | Title | Priority | Effort | Depends on | Status |
|------|-------|----------|--------|------------|--------|
| [001](001-namespace.md) | Namespace | P1 | S | — | TODO |
`)
  fs.writeFileSync(path.join(planDir, "001-namespace.md"), planBody("001"))
  return planDir
}

const root = fs.mkdtempSync(path.join(os.tmpdir(), "herder-namespace-test-"))
try {
  const repo = path.join(root, "repo")
  fs.mkdirSync(repo)
  git(repo, "init", "-q", "-b", "main")
  git(repo, "config", "user.name", "Herder Namespace Test")
  git(repo, "config", "user.email", "herder-namespace@example.invalid")
  fs.writeFileSync(path.join(repo, "base.txt"), "base\n")
  git(repo, "add", "base.txt")
  git(repo, "commit", "-q", "-m", "test: base")
  const planDir = writePlans(repo)

  assert.equal(validatePlanName("plans"), "plans")
  assert.throws(() => validatePlanName("Plans"), /lowercase Git-safe basename/)
  assert.throws(() => validatePlanName("plans/other"), /lowercase Git-safe basename/)

  const fresh = inspectNamespace({ repo, planDir, mode: "fire" })
  assert.equal(fresh.ok, true)
  assert.equal(fresh.planName, "plans")
  assert.equal(fresh.namespace, "herder/plans")
  assert.equal(fresh.integrationBranch, "herder/plans/integration")
  assert.deepEqual(fresh.conflicts, [])

  git(repo, "branch", "herder/plans/integration", "main")
  git(repo, "branch", "herder/plans/001", "main")
  git(repo, "update-ref", "refs/plan-herder/plans/base", git(repo, "rev-parse", "main"), "")

  const collision = inspectNamespace({ repo, planDir, mode: "fire" })
  assert.equal(collision.ok, false)
  assert.equal(collision.reason, "namespace-conflict")
  assert.deepEqual(collision.conflicts.map((item) => item.branch).filter(Boolean).sort(), [
    "herder/plans/001",
    "herder/plans/integration",
  ])

  const resumed = inspectNamespace({ repo, planDir, mode: "resume" })
  assert.equal(resumed.ok, true)
  assert.equal(resumed.integration.branch, "herder/plans/integration")
  assert.equal(resumed.baseRef.ref, "refs/plan-herder/plans/base")
  assert.deepEqual(resumed.planBranches.map((item) => item.relative), ["001"])

  const other = inspectNamespace({ repo, planDir, planName: "other-plans", mode: "fire" })
  assert.equal(other.ok, true)
  assert.equal(other.integrationBranch, "herder/other-plans/integration")

  git(repo, "branch", "herder/plans/manual", "main")
  const ambiguous = inspectNamespace({ repo, planDir, mode: "resume" })
  assert.equal(ambiguous.ok, false)
  assert.equal(ambiguous.reason, "namespace-ambiguous")
  assert.equal(ambiguous.conflicts.some((item) => item.type === "unknown-branch"), true)

  git(repo, "branch", "herder/blocked", "main")
  const parentConflict = inspectNamespace({ repo, planDir, planName: "blocked", mode: "fire" })
  assert.equal(parentConflict.ok, false)
  assert.deepEqual(parentConflict.conflicts, [{ type: "parent-ref", ref: "refs/heads/herder/blocked" }])

  const cli = run(process.execPath, [
    script,
    "--repo", repo,
    "--plan-dir", planDir,
    "--mode", "fire",
    "--pretty",
  ], { cwd: repo, allowFailure: true })
  assert.equal(cli.status, 2)
  assert.equal(JSON.parse(cli.stdout).reason, "namespace-conflict")
  assert.equal(cli.stderr, "")

  console.log("herder Fire namespace tests passed")
} finally {
  fs.rmSync(root, { recursive: true, force: true })
}

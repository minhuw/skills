#!/usr/bin/env node

import assert from "node:assert/strict"
import { spawnSync } from "node:child_process"
import fs from "node:fs"
import os from "node:os"
import path from "node:path"
import process from "node:process"
import { fileURLToPath } from "node:url"
import { initPlanDir, snapshotPlan } from "../../plans/scripts/herder-plans.mjs"

const scriptDir = path.dirname(fileURLToPath(import.meta.url))
const assignmentManager = path.join(scriptDir, "assignment-bundle.mjs")
const root = fs.mkdtempSync(path.join(os.tmpdir(), "herder-assignment-test-"))

function git(cwd, ...args) {
  const result = spawnSync("git", ["-C", cwd, ...args], { encoding: "utf8" })
  assert.equal(result.status, 0, result.stderr || result.stdout)
  return result.stdout.trim()
}

function assignment(args, expectedStatus = 0) {
  const result = spawnSync(process.execPath, [assignmentManager, ...args], { encoding: "utf8" })
  assert.equal(result.status, expectedStatus, result.stderr || result.stdout)
  return JSON.parse(result.stdout)
}

function planBody() {
  return `# Plan 001: Keep assignment context local

## Status

- **Priority**: P1
- **Effort**: S
- **Risk**: LOW
- **Depends on**: none
- **Category**: orchestration
- **Planned at**: commit \`abc1234\`, 2026-07-28
- **Kind**: behavioral
- **Parent objective**: Keep every worker inside its assigned worktree
- **Review budget**: files<=2

## Why this matters

Workers need the exact assigned plan without reading the coordinator checkout.

## Current state

The coordinator owns the source backlog.

## Commands you will need

| Purpose | Command | Expected on success |
|---|---|---|
| Test | \`node --test\` | exit 0 |

## Scope

**In scope** (the only files you should modify):
- \`src/worker.mjs\`

**Out of scope**:
- The source plan directory.

## Dependency contract

Consumes the immutable assignment and changes no coordination state.

## Git workflow

- Branch: use the exact branch/worktree assigned by Herder Fire; never create or switch branches.
- Use one focused conventional commit.
- Do not push or open a pull request.

## Steps

### Step 1: Read the assignment

Use the local immutable bundle.

## Test plan

Run \`node --test\`.

## Review map

- Outcome: the worker remains in its worktree.
- Modified symbols: \`src/worker.mjs\`.
- Proof: \`node --test\`.
- Expected unchanged behavior: coordination files remain unchanged.
- Expected diff: at most 2 files.

## Done criteria

- [ ] The local assignment is available.

## STOP conditions

Stop if the assignment hash changes.

## Maintenance notes

Keep assignment transport deterministic.
`
}

function writePlan(planDir) {
  fs.writeFileSync(path.join(planDir, "README.md"), `# Herder Plans

## Execution order & status

| Plan | Title | Priority | Effort | Depends on | Status |
|------|-------|----------|--------|------------|--------|
| [001](001-local-assignment.md) | Keep assignment context local | P1 | S | — | TODO |
`)
  fs.writeFileSync(path.join(planDir, "001-local-assignment.md"), planBody())
}

function createFixture(name, { track }) {
  const repo = path.join(root, name)
  const worktree = path.join(root, `${name}-worktree`)
  fs.mkdirSync(repo)
  git(repo, "init", "-q")
  git(repo, "config", "user.name", "Herder Test")
  git(repo, "config", "user.email", "herder@example.invalid")
  fs.mkdirSync(path.join(repo, "src"))
  fs.writeFileSync(path.join(repo, "src", "worker.mjs"), "export const ready = true\n")
  const planDir = path.join(repo, "herder-plans")
  initPlanDir(planDir, { track })
  writePlan(planDir)
  git(repo, "add", "src/worker.mjs")
  if (track) git(repo, "add", "herder-plans")
  git(repo, "commit", "-qm", "Initial fixture")
  const head = git(repo, "rev-parse", "HEAD")
  const branch = `herder/${name}/001`
  git(repo, "worktree", "add", "-q", "-b", branch, worktree, head)
  return { repo, worktree, planDir, head, branch, snapshot: snapshotPlan(planDir, "001") }
}

try {
  for (const track of [false, true]) {
    const name = track ? "tracked" : "local"
    const fixture = createFixture(name, { track })
    const materialized = assignment([
      "materialize",
      "--plan", "001",
      "--plan-dir", fixture.planDir,
      "--worktree", fixture.worktree,
      "--expected-branch", fixture.branch,
      "--expected-head", fixture.head,
      "--expected-snapshot-sha256", fixture.snapshot.snapshotSha256,
    ])

    assert.equal(materialized.ok, true)
    assert.equal(materialized.scope, "001")
    assert.equal(materialized.branch, fixture.branch)
    assert.equal(materialized.relativePath, "herder-plans/.herder/assignment.json")
    assert.equal(git(fixture.worktree, "status", "--porcelain=v1", "--untracked-files=all"), "")
    assert.match(
      git(fixture.worktree, "check-ignore", "-v", "--no-index", "--", materialized.relativePath),
      track ? /\.gitignore:.*\.herder\// : /info\/exclude:.*\/herder-plans\//,
    )

    const bundleBytes = fs.readFileSync(materialized.bundlePath)
    const bundle = JSON.parse(bundleBytes)
    assert.equal(bundle.schemaVersion, 1)
    assert.equal(bundle.kind, "herder-plan-assignment")
    assert.equal(bundle.plan.id, "001")
    assert.equal(bundle.plan.title, "Keep assignment context local")
    assert.deepEqual(bundle.plan.reviewBudget, {
      files: 2,
      source: "files<=2",
    })
    assert.equal(bundle.planText, fixture.snapshot.planText)
    assert.equal(bundle.snapshotSha256, fixture.snapshot.snapshotSha256)
    assert.equal(bundle.assignment.branch, fixture.branch)
    assert.equal(bundle.assignment.generationBase, fixture.head)
    assert.equal(bundle.snapshotInputs.some((input) => Object.hasOwn(input, "file")), false)
    assert.equal(bundleBytes.includes(Buffer.from(fixture.repo)), false)
    assert.equal(fs.statSync(materialized.bundlePath).mode & 0o222, 0)

    const verified = assignment([
      "verify",
      "--worktree", fixture.worktree,
      "--bundle", materialized.bundlePath,
      "--expected-bundle-sha256", materialized.bundleSha256,
    ])
    assert.equal(verified.ok, true)
    assert.equal(verified.scope, "001")
    assert.equal(verified.bundleSha256, materialized.bundleSha256)

    const runMaterialized = assignment([
      "materialize-run",
      "--plan-dir", fixture.planDir,
      "--worktree", fixture.worktree,
      "--expected-branch", fixture.branch,
      "--expected-head", fixture.head,
    ])
    assert.equal(runMaterialized.scope, "RUN")
    assert.equal(runMaterialized.relativePath, "herder-plans/.herder/run-assignment.json")
    const runBundle = JSON.parse(fs.readFileSync(runMaterialized.bundlePath))
    assert.equal(runBundle.kind, "herder-run-assignment")
    assert.equal(runBundle.plans.length, 1)
    assert.equal(runBundle.plans[0].plan.id, "001")
    assert.equal(runBundle.plans[0].planText, fixture.snapshot.planText)
    assert.equal(JSON.stringify(runBundle).includes(fixture.repo), false)
    const runVerified = assignment([
      "verify",
      "--worktree", fixture.worktree,
      "--bundle", runMaterialized.bundlePath,
      "--expected-bundle-sha256", runMaterialized.bundleSha256,
    ])
    assert.equal(runVerified.scope, "RUN")
    assert.equal(runVerified.snapshotSha256, runMaterialized.snapshotSha256)

    fs.chmodSync(materialized.bundlePath, 0o644)
    fs.appendFileSync(materialized.bundlePath, " ")
    fs.chmodSync(materialized.bundlePath, 0o444)
    const tampered = assignment([
      "verify",
      "--worktree", fixture.worktree,
      "--bundle", materialized.bundlePath,
      "--expected-bundle-sha256", materialized.bundleSha256,
    ], 1)
    assert.match(tampered.error, /hash mismatch/)

    fs.chmodSync(materialized.bundlePath, 0o644)
    fs.writeFileSync(materialized.bundlePath, bundleBytes)
    fs.chmodSync(materialized.bundlePath, 0o444)
    git(fixture.worktree, "switch", "-q", "-c", `${fixture.branch}-wrong`)
    const wrongBranch = assignment([
      "verify",
      "--worktree", fixture.worktree,
      "--bundle", materialized.bundlePath,
      "--expected-bundle-sha256", materialized.bundleSha256,
    ], 1)
    assert.match(wrongBranch.error, /assignment branch mismatch/)
  }

  const stale = createFixture("stale", { track: false })
  const staleSnapshot = `${"0".repeat(63)}1`
  assert.notEqual(staleSnapshot, stale.snapshot.snapshotSha256)
  const staleResult = assignment([
    "materialize",
    "--plan", "001",
    "--plan-dir", stale.planDir,
    "--worktree", stale.worktree,
    "--expected-branch", stale.branch,
    "--expected-head", stale.head,
    "--expected-snapshot-sha256", staleSnapshot,
  ], 1)
  assert.match(staleResult.error, /plan snapshot mismatch/)
  assert.equal(fs.existsSync(path.join(stale.worktree, "herder-plans", ".herder", "assignment.json")), false)

  const symlinked = createFixture("symlinked", { track: false })
  const outside = path.join(root, "outside")
  fs.mkdirSync(outside)
  fs.mkdirSync(path.join(symlinked.worktree, "herder-plans"))
  fs.symlinkSync(outside, path.join(symlinked.worktree, "herder-plans", ".herder"))
  const symlinkResult = assignment([
    "materialize",
    "--plan", "001",
    "--plan-dir", symlinked.planDir,
    "--worktree", symlinked.worktree,
    "--expected-branch", symlinked.branch,
    "--expected-head", symlinked.head,
    "--expected-snapshot-sha256", symlinked.snapshot.snapshotSha256,
  ], 1)
  assert.match(symlinkResult.error, /contains a symlink/)
  assert.equal(fs.readdirSync(outside).length, 0)

  const unignoredRepo = path.join(root, "unignored")
  const unignoredWorktree = path.join(root, "unignored-worktree")
  fs.mkdirSync(unignoredRepo)
  git(unignoredRepo, "init", "-q")
  git(unignoredRepo, "config", "user.name", "Herder Test")
  git(unignoredRepo, "config", "user.email", "herder@example.invalid")
  fs.writeFileSync(path.join(unignoredRepo, "tracked.txt"), "base\n")
  const unignoredPlanDir = path.join(unignoredRepo, "herder-plans")
  fs.mkdirSync(unignoredPlanDir)
  writePlan(unignoredPlanDir)
  git(unignoredRepo, "add", "tracked.txt")
  git(unignoredRepo, "commit", "-qm", "Initial fixture")
  const unignoredHead = git(unignoredRepo, "rev-parse", "HEAD")
  const unignoredBranch = "herder/unignored/001"
  git(unignoredRepo, "worktree", "add", "-q", "-b", unignoredBranch, unignoredWorktree, unignoredHead)
  const unignoredSnapshot = snapshotPlan(unignoredPlanDir, "001")
  const unignoredResult = assignment([
    "materialize",
    "--plan", "001",
    "--plan-dir", unignoredPlanDir,
    "--worktree", unignoredWorktree,
    "--expected-branch", unignoredBranch,
    "--expected-head", unignoredHead,
    "--expected-snapshot-sha256", unignoredSnapshot.snapshotSha256,
  ], 1)
  assert.match(unignoredResult.error, /must be Git-ignored/)

  process.stdout.write("assignment bundle tests passed\n")
} finally {
  fs.rmSync(root, { recursive: true, force: true })
}

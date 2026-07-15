#!/usr/bin/env node

import assert from "node:assert/strict"
import fs from "node:fs"
import os from "node:os"
import path from "node:path"
import { spawnSync } from "node:child_process"
import {
  buildGraph,
  initPlanDir,
  setTracking,
  snapshotPlan,
  transitionStatus,
} from "./herder-plans.mjs"

function git(root, ...args) {
  const result = spawnSync("git", ["-C", root, ...args], { encoding: "utf8" })
  assert.equal(result.status, 0, result.stderr || result.stdout)
  return result.stdout.trim()
}

function planBody(id, title, dependencies) {
  return `# Plan ${id}: ${title}

## Status

- **Priority**: P1
- **Effort**: S
- **Risk**: LOW
- **Depends on**: ${dependencies}
- **Category**: tests
- **Planned at**: commit \`abc1234\`, 2026-07-15

## Why this matters

Fixture intent.

## Current state

Fixture state.

## Commands you will need

| Purpose | Command | Expected on success |
|---|---|---|
| Test | \`true\` | exit 0 |

## Scope

Fixture scope.

## Steps

### Step 1: Test

Run the fixture.

## Test plan

Run the fixture test.

## Done criteria

- [ ] \`true\` exits 0.

## STOP conditions

Stop if the fixture changed.

## Maintenance notes

Keep the fixture small.
`
}

function writeFixture(root, { cycle = false, mismatch = false } = {}) {
  const planDir = path.join(root, "herder-plans")
  fs.mkdirSync(planDir, { recursive: true })
  fs.writeFileSync(path.join(planDir, "README.md"), `# Herder Plans

## Execution order & status

| Plan | Title | Priority | Effort | Depends on | Status |
|------|-------|----------|--------|------------|--------|
| [001](001-first.md) | First | P1 | S | ${cycle ? "002" : "—"} | DONE |
| [002](002-second.md) | Second | P1 | M | 001 | TODO |
| 003 | Parallel | P2 | S | — | BLOCKED — previous attempt stopped |
`)
  fs.writeFileSync(path.join(planDir, "001-first.md"), planBody("001", "First", cycle ? "herder-plans/002-*.md" : "none"))
  fs.writeFileSync(path.join(planDir, "002-second.md"), planBody("002", "Second", mismatch ? "none" : "herder-plans/001-*.md"))
  fs.writeFileSync(path.join(planDir, "003-parallel.md"), planBody("003", "Parallel", "none"))
  return planDir
}

function expectFailure(fn, pattern) {
  assert.throws(fn, pattern)
}

const root = fs.mkdtempSync(path.join(os.tmpdir(), "herder-plans-test-"))
try {
  const repo = path.join(root, "repo")
  fs.mkdirSync(repo)
  git(repo, "init", "-q")

  const initialized = initPlanDir(path.join(repo, "herder-plans"))
  assert.equal(initialized.createdReadme, true)
  assert.equal(initialized.tracking, "local")
  assert.equal(buildGraph(initialized.planDir).complete, true)
  const excludeFile = git(repo, "rev-parse", "--git-path", "info/exclude")
  const resolvedExclude = path.isAbsolute(excludeFile) ? excludeFile : path.join(repo, excludeFile)
  assert.match(fs.readFileSync(resolvedExclude, "utf8"), /^\/herder-plans\/$/m)

  const tracked = setTracking(initialized.planDir, true)
  assert.equal(tracked.tracking, "tracked")
  assert.doesNotMatch(fs.readFileSync(resolvedExclude, "utf8"), /^\/herder-plans\/$/m)
  assert.equal(fs.readFileSync(path.join(initialized.planDir, ".gitignore"), "utf8"), ".herder/\n")

  const local = setTracking(initialized.planDir, false)
  assert.equal(local.tracking, "local")
  assert.match(fs.readFileSync(resolvedExclude, "utf8"), /^\/herder-plans\/$/m)

  const valid = buildGraph(writeFixture(path.join(root, "valid")))
  assert.deepEqual(valid.ready, ["002"])
  assert.deepEqual(valid.blocked, ["003"])
  assert.deepEqual(valid.waiting, [])
  assert.deepEqual(valid.waves, [["001", "003"], ["002"]])
  assert.equal(valid.complete, false)
  assert.equal(valid.plans.find((plan) => plan.id === "003").statusDetail, "previous attempt stopped")

  const snapshot = snapshotPlan(valid.planDir, "2")
  assert.equal(snapshot.plan.id, "002")
  assert.match(snapshot.planText, /Plan 002/)
  assert.match(snapshot.indexText, /Execution order/)

  const progress = transitionStatus(valid.planDir, "002", "IN PROGRESS")
  assert.equal(progress.from, "TODO")
  assert.equal(buildGraph(valid.planDir).plans.find((plan) => plan.id === "002").status, "IN PROGRESS")
  expectFailure(() => transitionStatus(valid.planDir, "002", "BLOCKED"), /requires a one-line status detail/)
  transitionStatus(valid.planDir, "002", "BLOCKED", "verification failed")
  assert.equal(buildGraph(valid.planDir).plans.find((plan) => plan.id === "002").statusDetail, "verification failed")
  expectFailure(() => transitionStatus(valid.planDir, "002", "DONE"), /Invalid plan transition/)
  transitionStatus(valid.planDir, "002", "IN PROGRESS")
  transitionStatus(valid.planDir, "002", "DONE")
  assert.equal(buildGraph(valid.planDir).plans.find((plan) => plan.id === "002").status, "DONE")

  expectFailure(
    () => buildGraph(writeFixture(path.join(root, "mismatch"), { mismatch: true })),
    /dependency mismatch/,
  )
  expectFailure(
    () => buildGraph(writeFixture(path.join(root, "cycle"), { cycle: true })),
    /Dependency cycle/,
  )

  const missingColumn = writeFixture(path.join(root, "missing-column"))
  const missingColumnIndex = path.join(missingColumn, "README.md")
  fs.writeFileSync(missingColumnIndex, fs.readFileSync(missingColumnIndex, "utf8").replace(" | Effort", ""))
  expectFailure(() => buildGraph(missingColumn), /required columns/)

  const unexplainedBlocked = writeFixture(path.join(root, "unexplained-blocked"))
  const unexplainedIndex = path.join(unexplainedBlocked, "README.md")
  fs.writeFileSync(unexplainedIndex, fs.readFileSync(unexplainedIndex, "utf8").replace("BLOCKED — previous attempt stopped", "BLOCKED"))
  expectFailure(() => buildGraph(unexplainedBlocked), /must explain why it is BLOCKED/)

  const malformed = writeFixture(path.join(root, "malformed"))
  const malformedPlan = path.join(malformed, "002-second.md")
  fs.writeFileSync(malformedPlan, fs.readFileSync(malformedPlan, "utf8").replace("## Maintenance notes", "## Notes"))
  expectFailure(() => buildGraph(malformed), /missing required heading "## Maintenance notes"/)

  const unindexed = writeFixture(path.join(root, "unindexed"))
  fs.writeFileSync(path.join(unindexed, "004-forgotten.md"), "# Plan 004\n\n- **Depends on**: none\n")
  expectFailure(() => buildGraph(unindexed), /missing from .*README\.md/)

  process.stdout.write("herder-plans tests passed\n")
} finally {
  fs.rmSync(root, { recursive: true, force: true })
}

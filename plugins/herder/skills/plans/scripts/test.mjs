#!/usr/bin/env node

import assert from "node:assert/strict"
import fs from "node:fs"
import os from "node:os"
import path from "node:path"
import { spawnSync } from "node:child_process"
import {
  bindRunProfile,
  buildGraph,
  getExecutionReport,
  getShapeReport,
  getRunProfile,
  getUsageReport,
  initPlanDir,
  migrateUsage,
  recordUsage,
  setTracking,
  snapshotPlan,
  transitionStatus,
} from "./herder-plans.mjs"
import { executionDatabasePath } from "./execution-store.mjs"

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
- **Kind**: behavioral
- **Parent objective**: Exercise the plan manager fixture

## Why this matters

Fixture intent.

## Current state

Fixture state.

## Commands you will need

| Purpose | Command | Expected on success |
|---|---|---|
| Test | \`true\` | exit 0 |

## Scope

**In scope** (declared write paths):
- \`src/${id}.mjs\`

**Out of scope**:
- Every other fixture file.

## Dependency contract

Consumes the declared predecessor state and provides one passing fixture.

## Git workflow

- Branch: use the exact branch/worktree assigned by Herder Fire; never create or switch branches.
- Use one focused conventional commit.
- Do not push or open a pull request.

## Steps

### Step 1: Test

Run the fixture.

## Test plan

Run the fixture test.

## Review map

- Outcome: the fixture command passes.
- Modified symbols: the scoped fixture file only.
- Proof: \`true\`.
- Expected unchanged behavior: every other fixture remains unchanged.
- Expected diff: the scoped fixture path and its direct tests.

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

function legacyUsageSection(attempt = "legacy-002-reviewer-1") {
  return `
<!-- herder-usage:start -->
## Execution usage

### Attempts

| Attempt | Plan | Role | Model | Effort | Outcome | Input tokens | Cached input | Output tokens | Reasoning tokens | Source |
|---|---|---|---|---|---|---:|---:|---:|---:|---|
| ${attempt} | 002 | plan-reviewer | gpt-5.6-sol | xhigh | APPROVE | 300 | 100 | 50 | 20 | codex-exec |
<!-- herder-usage:end -->
`
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
  assert.match(fs.readFileSync(path.join(initialized.planDir, "README.md"), "utf8"), /## Considered and rejected/)
  assert.doesNotMatch(fs.readFileSync(initialized.readme, "utf8"), /## Execution usage/)
  assert.equal(fs.existsSync(executionDatabasePath(initialized.planDir)), true)
  assert.equal(fs.statSync(executionDatabasePath(initialized.planDir)).mode & 0o777, 0o600)
  const emptyUsage = getUsageReport(initialized.planDir)
  assert.equal(emptyUsage.attempts, 0)
  assert.equal(emptyUsage.storage, "sqlite")
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

  const validDir = writeFixture(path.join(root, "valid"))
  const leakDir = path.join(validDir, "leak")
  fs.mkdirSync(leakDir)
  fs.writeFileSync(path.join(leakDir, "001-F004-deferred-example.md"), "# Deferred finding\n\nStatus: PENDING\n")
  const valid = buildGraph(validDir)
  assert.deepEqual(valid.ready, ["002"])
  assert.deepEqual(valid.blocked, ["003"])
  assert.deepEqual(valid.waiting, [])
  assert.deepEqual(valid.waves, [["001", "003"], ["002"]])
  assert.equal(valid.complete, false)
  assert.equal(valid.shapeReady, true)
  assert.equal(valid.plans.length, 3, "non-executable leak records entered the plan graph")
  assert.deepEqual(valid.overlaps, [])
  assert.equal(valid.plans.find((plan) => plan.id === "003").statusDetail, "previous attempt stopped")
  const shape = getShapeReport(valid.planDir)
  assert.equal(shape.shapeReady, true)
  assert.equal(shape.plans.find((plan) => plan.id === "002").planWords < 1200, true)
  assert.equal(Number.isSafeInteger(shape.plans.find((plan) => plan.id === "002").planLines), true)
  assert.equal(Object.hasOwn(shape.plans.find((plan) => plan.id === "002"), "reviewBudget"), false)

  const readmeBeforeUsage = fs.readFileSync(valid.readme, "utf8")
  const runProfile = {
    profile: "offcut",
    profileSha256: "1c5a08366d983d588fe0b8dfaf9f2c03d1c0801ab194b27c85da8b5e7f6453e2",
    host: "codex",
    roles: {
      "plan-accountant": { agent_type: "offcut_plan_accountant", model: "grok-4.5", effort: "max" },
      "plan-implementer": { agent_type: "offcut_plan_implementer", model: "grok-4.5", effort: "high" },
      "plan-reviewer": { agent_type: "offcut_plan_reviewer", model: "gpt-5.6-sol", effort: "xhigh" },
      "plan-judge": { agent_type: "offcut_plan_judge", model: "gpt-5.6-sol", effort: "xhigh" },
      "plan-saver": { agent_type: "offcut_plan_saver", model: "gpt-5.6-sol", effort: "max" },
    },
  }
  assert.equal(bindRunProfile(valid.planDir, runProfile).recorded, true)
  assert.equal(bindRunProfile(valid.planDir, runProfile).recorded, false)
  assert.deepEqual(getRunProfile(valid.planDir).configuration.roles, runProfile.roles)
  expectFailure(
    () => bindRunProfile(valid.planDir, { ...runProfile, profile: "eclipse" }),
    /already bound to offcut/,
  )
  const implementerUsage = {
    plan: "002",
    role: "plan-implementer",
    attempt: "run-1-002-implementer-1",
    model: "gpt-5.6-luna",
    effort: "max",
    outcome: "COMPLETE",
    inputTokens: "1000",
    cachedInputTokens: "400",
    outputTokens: "200",
    reasoningTokens: "50",
    source: "codex-exec",
    round: "1",
    generation: "generation-1",
    runtime: "native",
    harness: "codex",
    serviceTier: "fast",
    startedAt: "2026-08-03T00:00:00Z",
    finishedAt: "2026-08-03T00:00:02Z",
    durationMs: "2000",
  }
  assert.equal(recordUsage(valid.planDir, implementerUsage).recorded, true)
  assert.equal(recordUsage(valid.planDir, implementerUsage).recorded, false)
  assert.equal(recordUsage(valid.planDir, {
    plan: "002",
    role: "plan-reviewer",
    attempt: "run-1-002-reviewer-1",
    model: "gpt-5.6-sol",
    effort: "xhigh",
    outcome: "APPROVE",
    source: "unknown",
    round: "1",
    generation: "generation-1",
    runtime: "native",
    harness: "codex",
    serviceTier: "standard",
    startedAt: "2026-08-03T00:00:02Z",
    finishedAt: "2026-08-03T00:00:05Z",
    durationMs: "3000",
  }).recorded, true)

  const usage = getUsageReport(valid.planDir)
  assert.equal(usage.attempts, 2)
  assert.deepEqual(usage.byPlan, [{
    key: "002",
    attempts: 2,
    tokenAttempts: 1,
    knownTokens: 1200,
  }])
  assert.equal(usage.byRole.find((row) => row.key === "plan-implementer").knownTokens, 1200)
  assert.equal(usage.byModel.find((row) => row.key === "gpt-5.6-sol / xhigh").tokenAttempts, 0)
  assert.equal(usage.storage, "sqlite")
  assert.equal(usage.runConfiguration.profile, "offcut")
  assert.equal(fs.readFileSync(valid.readme, "utf8"), readmeBeforeUsage)
  assert.equal(fs.existsSync(executionDatabasePath(valid.planDir)), true)
  const databaseBeforeReports = fs.readFileSync(executionDatabasePath(valid.planDir))
  const planReport = getExecutionReport(valid.planDir, "002")
  assert.equal(planReport.attempts, 2)
  assert.deepEqual(planReport.rounds, [1])
  assert.deepEqual(planReport.tokenCoverage, { reported: 1, total: 2 })
  assert.equal(planReport.tokens.reportedInputOutput, 1200)
  assert.equal(planReport.timing.wallClockMs, 5000)
  assert.equal(planReport.timing.attemptDurationMs, 5000)
  assert.deepEqual(planReport.timing.durationCoverage, { reported: 2, total: 2 })
  assert.equal(planReport.byRole.find((row) => row.key === "plan-reviewer").attempts, 1)
  assert.equal(planReport.byRuntime.find((row) => row.key === "native / codex").attempts, 2)
  assert.equal(planReport.byGeneration.find((row) => row.key === "generation-1").attempts, 2)
  assert.equal(planReport.byServiceTier.find((row) => row.key === "fast").attempts, 1)
  assert.equal(planReport.lifecycle.status, "TODO")
  assert.equal(planReport.runConfiguration.profile, "offcut")
  assert.deepEqual(fs.readFileSync(executionDatabasePath(valid.planDir)), databaseBeforeReports)
  expectFailure(
    () => recordUsage(valid.planDir, { ...implementerUsage, outcome: "FAILED" }),
    /already recorded with different values/,
  )
  expectFailure(
    () => recordUsage(valid.planDir, { ...implementerUsage, attempt: "bad-source", source: "unknown" }),
    /numeric usage but an unknown source/,
  )
  expectFailure(
    () => recordUsage(valid.planDir, { ...implementerUsage, attempt: "unknown-plan", plan: "999" }),
    /is not indexed/,
  )

  const snapshot = snapshotPlan(valid.planDir, "2")
  assert.equal(snapshot.plan.id, "002")
  assert.match(snapshot.planText, /Plan 002/)
  assert.match(snapshot.indexText, /Execution order/)
  assert.match(snapshot.snapshotSha256, /^[a-f0-9]{64}$/)
  assert.equal(snapshot.snapshotInputs.length, 1)

  fs.writeFileSync(path.join(valid.planDir, "CONTEXT.md"), `# Herder Plan-Set Context

## Objective

Keep shared fixture facts in one compiled snapshot input.
`)
  const composedSnapshot = snapshotPlan(valid.planDir, "2")
  assert.match(composedSnapshot.planText, /herder-snapshot:shared-context/)
  assert.match(composedSnapshot.planText, /Keep shared fixture facts/)
  assert.match(composedSnapshot.planText, /Plan 002/)
  assert.equal(composedSnapshot.snapshotInputs.length, 2)
  assert.equal(composedSnapshot.contextText.includes("Plan-Set Context"), true)

  const progress = transitionStatus(valid.planDir, "002", "IN PROGRESS")
  assert.equal(progress.from, "TODO")
  assert.equal(buildGraph(valid.planDir).plans.find((plan) => plan.id === "002").status, "IN PROGRESS")
  expectFailure(() => transitionStatus(valid.planDir, "002", "BLOCKED"), /requires a one-line status detail/)
  transitionStatus(valid.planDir, "002", "BLOCKED", "verification failed")
  assert.equal(buildGraph(valid.planDir).plans.find((plan) => plan.id === "002").statusDetail, "verification failed")
  expectFailure(() => transitionStatus(valid.planDir, "002", "DONE"), /Invalid plan transition/)
  transitionStatus(valid.planDir, "002", "IN PROGRESS")
  const completed = transitionStatus(valid.planDir, "002", "DONE")
  assert.equal(completed.report.lifecycle.status, "DONE")
  assert.equal(completed.report.attempts, 2)
  assert.equal(buildGraph(valid.planDir).plans.find((plan) => plan.id === "002").status, "DONE")

  const legacyDir = writeFixture(path.join(root, "legacy-usage"))
  const legacyReadme = path.join(legacyDir, "README.md")
  fs.appendFileSync(legacyReadme, legacyUsageSection())
  const legacyMarkdown = fs.readFileSync(legacyReadme, "utf8")
  assert.equal(fs.existsSync(executionDatabasePath(legacyDir)), false)
  const legacyReadOnly = getUsageReport(legacyDir)
  assert.equal(legacyReadOnly.storage, "legacy-readonly")
  assert.equal(legacyReadOnly.attempts, 1)
  assert.equal(fs.existsSync(executionDatabasePath(legacyDir)), false)
  assert.equal(fs.readFileSync(legacyReadme, "utf8"), legacyMarkdown)
  const migrated = migrateUsage(legacyDir)
  assert.equal(migrated.migrated, 1)
  assert.equal(migrated.removedLegacySection, true)
  assert.equal(fs.existsSync(executionDatabasePath(legacyDir)), true)
  assert.doesNotMatch(fs.readFileSync(legacyReadme, "utf8"), /herder-usage|legacy-002-reviewer-1/)
  const repeatedMigration = migrateUsage(legacyDir)
  assert.equal(repeatedMigration.migrated, 0)
  assert.equal(repeatedMigration.removedLegacySection, false)
  assert.equal(getUsageReport(legacyDir).attempts, 1)

  const malformedLegacyDir = writeFixture(path.join(root, "malformed-legacy-usage"))
  const malformedLegacyReadme = path.join(malformedLegacyDir, "README.md")
  fs.appendFileSync(malformedLegacyReadme, "\n<!-- herder-usage:start -->\n")
  expectFailure(() => migrateUsage(malformedLegacyDir), /malformed legacy Herder usage section markers/)
  assert.equal(fs.existsSync(executionDatabasePath(malformedLegacyDir)), false)

  const symlinkDatabaseDir = writeFixture(path.join(root, "symlink-database"))
  const externalDatabase = path.join(root, "external-database")
  fs.mkdirSync(externalDatabase)
  fs.symlinkSync(externalDatabase, path.join(symlinkDatabaseDir, ".herder"))
  expectFailure(() => migrateUsage(symlinkDatabaseDir), /Execution runtime path must be a real directory/)

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

  const legacyBudget = writeFixture(path.join(root, "legacy-budget"))
  const legacyBudgetPlan = path.join(legacyBudget, "002-second.md")
  fs.writeFileSync(
    legacyBudgetPlan,
    fs.readFileSync(legacyBudgetPlan, "utf8").replace(
      "- **Parent objective**: Exercise the plan manager fixture\n",
      "- **Parent objective**: Exercise the plan manager fixture\n- **Review budget**: arbitrary legacy value, changed_lines<=0\n",
    ),
  )
  const ignoredLegacyBudget = buildGraph(legacyBudget).plans.find((plan) => plan.id === "002")
  assert.equal(Object.hasOwn(ignoredLegacyBudget, "reviewBudget"), false)
  assert.equal(ignoredLegacyBudget.shapeReady, true)

  const legacyShape = writeFixture(path.join(root, "legacy-shape"))
  const legacyShapePlan = path.join(legacyShape, "002-second.md")
  fs.writeFileSync(
    legacyShapePlan,
    fs.readFileSync(legacyShapePlan, "utf8")
      .replace("- **Kind**: behavioral\n", "")
      .replace("- **Parent objective**: Exercise the plan manager fixture\n", "")
      .replace(/## Dependency contract[\s\S]*?(?=## Git workflow)/, "")
      .replace(/## Review map[\s\S]*?(?=## Done criteria)/, ""),
  )
  const legacyGraph = buildGraph(legacyShape)
  assert.equal(legacyGraph.shapeReady, false)
  assert.match(legacyGraph.warnings.join("\n"), /Plan 002 shape: missing metadata "Kind"/)

  const overlap = writeFixture(path.join(root, "overlap"))
  const overlapPlan = path.join(overlap, "003-parallel.md")
  fs.writeFileSync(
    overlapPlan,
    fs.readFileSync(overlapPlan, "utf8").replace("src/003.mjs", "src/002.mjs"),
  )
  const overlapShape = getShapeReport(overlap)
  assert.deepEqual(overlapShape.overlaps, [{
    plans: ["002", "003"],
    paths: ["src/002.mjs"],
    ordered: false,
  }])
  assert.match(overlapShape.warnings.join("\n"), /unordered overlapping in-scope paths/)

  const verbose = writeFixture(path.join(root, "verbose"))
  const verbosePlan = path.join(verbose, "002-second.md")
  fs.writeFileSync(
    verbosePlan,
    `${fs.readFileSync(verbosePlan, "utf8")}\n${"repeated ".repeat(1300)}\n`,
  )
  const verboseShape = getShapeReport(verbose)
  assert.equal(verboseShape.shapeReady, false)
  assert.match(verboseShape.warnings.join("\n"), /compact subplans must stay at or below 1200/)

  const legacyBranch = writeFixture(path.join(root, "legacy-branch"))
  const legacyBranchPlan = path.join(legacyBranch, "002-second.md")
  fs.writeFileSync(
    legacyBranchPlan,
    fs.readFileSync(legacyBranchPlan, "utf8").replace(
      "use the exact branch/worktree assigned by Herder Fire; never create or switch branches.",
      "use `herder/002-second`",
    ),
  )
  expectFailure(() => buildGraph(legacyBranch), /must delegate branch ownership to Herder Fire/)

  const misplacedBranch = writeFixture(path.join(root, "misplaced-branch"))
  const misplacedBranchPlan = path.join(misplacedBranch, "002-second.md")
  const canonicalBranch = "- Branch: use the exact branch/worktree assigned by Herder Fire; never create or switch branches."
  fs.writeFileSync(
    misplacedBranchPlan,
    fs.readFileSync(misplacedBranchPlan, "utf8")
      .replace(`${canonicalBranch}\n`, "")
      .replace("## Status", `${canonicalBranch}\n\n## Status`),
  )
  expectFailure(() => buildGraph(misplacedBranch), /exactly one "- Branch:" instruction in "## Git workflow"/)

  const unindexed = writeFixture(path.join(root, "unindexed"))
  fs.writeFileSync(path.join(unindexed, "004-forgotten.md"), "# Plan 004\n\n- **Depends on**: none\n")
  expectFailure(() => buildGraph(unindexed), /missing from .*README\.md/)

  process.stdout.write("herder-plans tests passed\n")
} finally {
  fs.rmSync(root, { recursive: true, force: true })
}

#!/usr/bin/env node

import assert from "node:assert/strict"
import fs from "node:fs"
import os from "node:os"
import path from "node:path"
import process from "node:process"
import { spawnSync } from "node:child_process"
import { fileURLToPath } from "node:url"
import { parseWorktreeRecords } from "./cleanup-run.mjs"

const scriptDir = path.dirname(fileURLToPath(import.meta.url))
const cleanup = path.join(scriptDir, "cleanup-run.mjs")

function run(command, args, { cwd, allowFailure = false } = {}) {
  const result = spawnSync(command, args, { cwd, encoding: "utf8", maxBuffer: 16 * 1024 * 1024 })
  if (!allowFailure) assert.equal(result.status, 0, result.stderr || result.stdout)
  return result
}

function git(repo, ...args) {
  return run("git", ["-C", repo, ...args]).stdout.trim()
}

function planBody(id, title) {
  return `# Plan ${id}: ${title}

## Status

- **Priority**: P1
- **Effort**: S
- **Risk**: LOW
- **Depends on**: none
- **Category**: tests
- **Planned at**: commit \`abc1234\`, 2026-07-16

## Why this matters

Cleanup fixture.

## Current state

Cleanup fixture.

## Commands you will need

| Purpose | Command | Expected on success |
|---|---|---|
| Test | \`true\` | exit 0 |

## Scope

Cleanup fixture.

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

function writePlans(repo) {
  const planDir = path.join(repo, "plans")
  fs.mkdirSync(planDir)
  fs.writeFileSync(path.join(planDir, "README.md"), `# Herder Plans

## Execution order & status

| Plan | Title | Priority | Effort | Depends on | Status |
|------|-------|----------|--------|------------|--------|
| [001](001-done.md) | Done | P1 | S | — | DONE |
| [002](002-blocked.md) | Blocked | P1 | S | — | BLOCKED — reviewer stopped |
| [003](003-markerless.md) | Markerless | P1 | S | — | DONE |
| [004](004-legacy.md) | Legacy marker | P1 | S | — | DONE |
| [005](005-legacy-trailer.md) | Legacy trailer | P1 | S | — | DONE |
`)
  fs.writeFileSync(path.join(planDir, "001-done.md"), planBody("001", "Done"))
  fs.writeFileSync(path.join(planDir, "002-blocked.md"), planBody("002", "Blocked"))
  fs.writeFileSync(path.join(planDir, "003-markerless.md"), planBody("003", "Markerless"))
  fs.writeFileSync(path.join(planDir, "004-legacy.md"), planBody("004", "Legacy marker"))
  fs.writeFileSync(path.join(planDir, "005-legacy-trailer.md"), planBody("005", "Legacy trailer"))
  return planDir
}

function writeFinalPlans(repo) {
  const planDir = path.join(repo, "plans")
  fs.mkdirSync(planDir)
  fs.writeFileSync(path.join(planDir, "README.md"), `# Herder Plans

## Execution order & status

| Plan | Title | Priority | Effort | Depends on | Status |
|------|-------|----------|--------|------------|--------|
| [001](001-done.md) | Done | P1 | S | — | DONE |
| [002](002-rejected.md) | Rejected | P1 | S | — | REJECTED — superseded experiment |
`)
  fs.writeFileSync(path.join(planDir, "001-done.md"), planBody("001", "Done"))
  fs.writeFileSync(path.join(planDir, "002-rejected.md"), planBody("002", "Rejected"))
  return planDir
}

function addWorktree(repo, root, branch, startPoint) {
  git(repo, "branch", branch, startPoint)
  const worktree = path.join(root, branch.replaceAll("/", "-"))
  git(repo, "worktree", "add", "-q", worktree, branch)
  return worktree
}

function commitFile(worktree, name, contents, message) {
  fs.writeFileSync(path.join(worktree, name), contents)
  git(worktree, "add", name)
  git(worktree, "commit", "-q", "-m", message)
}

function cleanupResult(repo, planDir, integrationBranch, extra = [], { allowFailure = false } = {}) {
  const result = run(process.execPath, [
    cleanup,
    "--repo", repo,
    "--plan-dir", planDir,
    "--integration-branch", integrationBranch,
    "--pretty",
    ...extra,
  ], { cwd: repo, allowFailure })
  return { process: result, json: result.status === 0 ? JSON.parse(result.stdout) : null }
}

const root = fs.mkdtempSync(path.join(os.tmpdir(), "herder-cleanup-test-"))
try {
  const expectedWorktrees = [
    { path: "/tmp/one", branch: "main", locked: false },
    { path: "/tmp/two", branch: "topic", locked: true },
  ]
  assert.deepEqual(parseWorktreeRecords(
    "worktree /tmp/one\0HEAD abc\0branch refs/heads/main\0\0worktree /tmp/two\0HEAD def\0branch refs/heads/topic\0locked active\0\0",
    true,
  ), expectedWorktrees)
  assert.deepEqual(parseWorktreeRecords(
    "worktree /tmp/one\nHEAD abc\nbranch refs/heads/main\n\nworktree /tmp/two\nHEAD def\nbranch refs/heads/topic\nlocked active\n\n",
    false,
  ), expectedWorktrees)

  const repo = path.join(root, "repo")
  const worktrees = path.join(root, "worktrees")
  fs.mkdirSync(repo)
  fs.mkdirSync(worktrees)
  git(repo, "init", "-q", "-b", "main")
  git(repo, "config", "user.name", "Herder Cleanup Test")
  git(repo, "config", "user.email", "herder-cleanup@example.invalid")
  fs.writeFileSync(path.join(repo, "base.txt"), "base\n")
  git(repo, "add", "base.txt")
  git(repo, "commit", "-q", "-m", "test: base")
  const initial = git(repo, "rev-parse", "HEAD")
  const planDir = writePlans(repo)
  const runId = "cleanup-fixture"
  const integrationBranch = `plan-herder/integration-${runId}`
  const integration = addWorktree(repo, worktrees, integrationBranch, initial)

  const candidateBranch = `plan-herder/${runId}/001-candidate`
  const candidate = addWorktree(repo, worktrees, candidateBranch, integrationBranch)
  commitFile(candidate, "done.txt", "done\n", "feat: done candidate")
  const candidateHead = git(candidate, "rev-parse", "HEAD")

  commitFile(integration, "prior-plan.txt", "prior plan\n", "feat: integrate an earlier plan")

  const stageBranch = `plan-herder/${runId}/001-stage-1`
  const stage = addWorktree(repo, worktrees, stageBranch, integrationBranch)
  git(stage, "cherry-pick", candidateHead)
  const countBeforeIntegration = git(stage, "rev-list", "--count", `${initial}..HEAD`)
  assert.equal(git(stage, "log", "-1", "--format=%s"), "feat: done candidate")
  git(integration, "merge", "-q", "--ff-only", stageBranch)
  const completionCommit = git(integration, "rev-parse", "HEAD")
  const completionRef = `refs/plan-herder/${runId}/completed/001`
  git(repo, "update-ref", completionRef, completionCommit, "")
  assert.equal(git(integration, "rev-list", "--count", `${initial}..HEAD`), countBeforeIntegration)
  assert.equal(git(repo, "rev-parse", completionRef), completionCommit)
  assert.doesNotMatch(git(integration, "log", "--format=%B", `${initial}..HEAD`), /herder|plan[- ]?\d+/i)
  assert.equal(run("git", ["-C", repo, "merge-base", "--is-ancestor", candidateHead, integrationBranch], { allowFailure: true }).status, 1)
  assert.equal(git(repo, "rev-list", "--min-parents=2", `${initial}..${integrationBranch}`), "")

  const unreachableBranch = `plan-herder/${runId}/001-stage-99`
  const unreachable = addWorktree(repo, worktrees, unreachableBranch, "main")
  commitFile(unreachable, "unreachable.txt", "unreachable\n", "test: unreachable done artifact")

  const unmatchedCandidateBranch = `plan-herder/${runId}/001-candidate-replan-1`
  const unmatchedCandidate = addWorktree(repo, worktrees, unmatchedCandidateBranch, "main")
  commitFile(unmatchedCandidate, "unmatched.txt", "unmatched\n", "test: unmatched candidate patch")

  git(integration, "commit", "-q", "--allow-empty", "-m", "plan-herder(004): mark plan done")
  const legacyBranch = `plan-herder/${runId}/004-candidate`
  const legacy = addWorktree(repo, worktrees, legacyBranch, integrationBranch)

  git(integration, "commit", "-q", "--allow-empty", "-m", "feat: preserve legacy trailer", "--trailer", "Plan-Herder-Complete: 005")
  const legacyTrailerBranch = `plan-herder/${runId}/005-candidate`
  const legacyTrailer = addWorktree(repo, worktrees, legacyTrailerBranch, integrationBranch)

  const dirtyDoneBranch = `plan-herder/${runId}/001-rescue-1`
  const dirtyDone = addWorktree(repo, worktrees, dirtyDoneBranch, integrationBranch)
  fs.writeFileSync(path.join(dirtyDone, "uncommitted-done.txt"), "preserve me\n")

  const lockedDoneBranch = `plan-herder/${runId}/001-stage-100`
  const lockedDone = addWorktree(repo, worktrees, lockedDoneBranch, integrationBranch)
  git(repo, "worktree", "lock", "--reason", "plan-herder:test:done-active", lockedDone)

  const failedBranch = `plan-herder/${runId}/002-candidate`
  const failed = addWorktree(repo, worktrees, failedBranch, integrationBranch)
  commitFile(failed, "failed.txt", "failed\n", "test: preserved failed candidate")

  const markerlessBranch = `plan-herder/${runId}/003-candidate`
  const markerless = addWorktree(repo, worktrees, markerlessBranch, integrationBranch)
  git(repo, "update-ref", `refs/plan-herder/${runId}/completed/003`, git(unmatchedCandidate, "rev-parse", "HEAD"), "")

  const dirtyBranch = `plan-herder/${runId}/002-rescue-1`
  const dirty = addWorktree(repo, worktrees, dirtyBranch, integrationBranch)
  fs.writeFileSync(path.join(dirty, "uncommitted.txt"), "evidence\n")

  const lockedBranch = `plan-herder/${runId}/002-stage-1`
  const locked = addWorktree(repo, worktrees, lockedBranch, integrationBranch)
  git(repo, "worktree", "lock", "--reason", "plan-herder:test:active", locked)

  const unknownBranch = `plan-herder/${runId}/manual-note`
  git(repo, "branch", unknownBranch, integrationBranch)

  const invalid = cleanupResult(repo, planDir, "main", ["--dry-run"], { allowFailure: true })
  assert.notEqual(invalid.process.status, 0)
  assert.match(invalid.process.stderr, /Integration branch must match/)

  const preview = cleanupResult(repo, planDir, integrationBranch, ["--dry-run"]).json
  assert.deepEqual(
    preview.actions.map((item) => item.branch).sort(),
    [candidateBranch, stageBranch, unreachableBranch, unmatchedCandidateBranch, legacyBranch, legacyTrailerBranch].sort(),
    JSON.stringify(preview, null, 2),
  )
  assert.equal(preview.actions.find((item) => item.branch === candidateBranch).proof, "patch-equivalent")
  assert.equal(preview.actions.find((item) => item.branch === stageBranch).proof, "ancestor")
  assert.equal(preview.actions.find((item) => item.branch === unreachableBranch).proof, "superseded-by-completion")
  assert.equal(preview.actions.find((item) => item.branch === unmatchedCandidateBranch).proof, "superseded-by-completion")
  assert.equal(preview.removed.length, 0)
  assert.equal(preview.preserved.completionRefs, `refs/plan-herder/${runId}/completed/`)
  assert.equal(preview.skipped.find((item) => item.branch === failedBranch).reason, "preserved-non-done-evidence")
  assert.equal(preview.skipped.find((item) => item.branch === dirtyBranch).reason, "preserved-non-done-evidence")
  assert.equal(preview.skipped.find((item) => item.branch === lockedBranch).reason, "preserved-non-done-evidence")
  assert.equal(preview.skipped.find((item) => item.branch === dirtyDoneBranch).reason, "worktree-dirty")
  assert.equal(preview.skipped.find((item) => item.branch === lockedDoneBranch).reason, "worktree-locked")
  assert.equal(preview.skipped.find((item) => item.branch === markerlessBranch).reason, "completion-proof-missing")
  assert.equal(preview.skipped.find((item) => item.branch === unknownBranch).reason, "unrecognized-run-artifact")
  assert.equal(fs.existsSync(candidate), true)
  assert.equal(fs.existsSync(stage), true)

  const scopedPreview = cleanupResult(repo, planDir, integrationBranch, ["--plan", "1", "--dry-run"]).json
  assert.deepEqual(
    scopedPreview.actions.map((item) => item.branch).sort(),
    [candidateBranch, stageBranch, unreachableBranch, unmatchedCandidateBranch].sort(),
  )
  assert.equal(scopedPreview.skipped.some((item) => item.plan === "002" || item.plan === "003"), false)

  const invalidFinalize = cleanupResult(repo, planDir, integrationBranch, ["--finalize", "--plan", "1", "--dry-run"], { allowFailure: true })
  assert.notEqual(invalidFinalize.process.status, 0)
  assert.match(invalidFinalize.process.stderr, /--finalize cannot be combined with --plan/)

  const invalidHandoff = cleanupResult(repo, planDir, integrationBranch, ["--handoff-target", "main", "--dry-run"], { allowFailure: true })
  assert.notEqual(invalidHandoff.process.status, 0)
  assert.match(invalidHandoff.process.stderr, /--handoff-target requires --finalize/)

  const cleaned = cleanupResult(repo, planDir, integrationBranch).json
  assert.deepEqual(
    cleaned.removed.map((item) => item.branch).sort(),
    [candidateBranch, stageBranch, unreachableBranch, unmatchedCandidateBranch, legacyBranch, legacyTrailerBranch].sort(),
  )
  assert.equal(fs.existsSync(candidate), false)
  assert.equal(fs.existsSync(stage), false)
  assert.equal(git(repo, "branch", "--list", candidateBranch), "")
  assert.equal(git(repo, "branch", "--list", stageBranch), "")
  assert.equal(git(repo, "branch", "--list", unreachableBranch), "")
  assert.equal(git(repo, "branch", "--list", unmatchedCandidateBranch), "")
  assert.equal(fs.existsSync(legacy), false)
  assert.equal(git(repo, "branch", "--list", legacyBranch), "")
  assert.equal(fs.existsSync(legacyTrailer), false)
  assert.equal(git(repo, "branch", "--list", legacyTrailerBranch), "")
  assert.equal(git(repo, "rev-parse", completionRef), completionCommit)
  assert.notEqual(git(repo, "branch", "--list", integrationBranch), "")
  assert.equal(fs.existsSync(integration), true)
  assert.notEqual(git(repo, "branch", "--list", failedBranch), "")
  assert.equal(fs.existsSync(markerless), true)
  assert.notEqual(git(repo, "branch", "--list", markerlessBranch), "")

  const failedPreview = cleanupResult(repo, planDir, integrationBranch, ["--include-failed", "--dry-run"]).json
  assert.deepEqual(failedPreview.actions.map((item) => item.branch), [failedBranch])
  assert.equal(failedPreview.skipped.find((item) => item.branch === dirtyBranch).reason, "worktree-dirty")
  assert.equal(failedPreview.skipped.find((item) => item.branch === lockedBranch).reason, "worktree-locked")

  const failedCleanup = cleanupResult(repo, planDir, integrationBranch, ["--include-failed"]).json
  assert.deepEqual(failedCleanup.removed.map((item) => item.branch), [failedBranch])
  assert.equal(fs.existsSync(failed), false)
  assert.equal(git(repo, "branch", "--list", failedBranch), "")
  assert.equal(fs.existsSync(dirty), true)
  assert.notEqual(git(repo, "branch", "--list", dirtyBranch), "")
  assert.equal(fs.existsSync(locked), true)
  assert.notEqual(git(repo, "branch", "--list", lockedBranch), "")
  assert.notEqual(git(repo, "branch", "--list", markerlessBranch), "")
  assert.notEqual(git(repo, "branch", "--list", dirtyDoneBranch), "")
  assert.notEqual(git(repo, "branch", "--list", lockedDoneBranch), "")
  assert.notEqual(git(repo, "branch", "--list", unknownBranch), "")
  assert.notEqual(git(repo, "branch", "--list", integrationBranch), "")

  const blockedFinalization = cleanupResult(repo, planDir, integrationBranch, ["--finalize", "--dry-run"]).json
  assert.equal(blockedFinalization.finalization.eligible, false)
  assert.equal(blockedFinalization.finalization.blockers.some((item) => item.reason === "plan-not-terminal"), true)
  assert.equal(blockedFinalization.finalization.blockers.some((item) => item.reason === "run-artifact-would-remain"), true)
  assert.equal(git(repo, "rev-parse", completionRef), completionCommit)

  const finalRepo = path.join(root, "final-repo")
  const finalWorktrees = path.join(root, "final-worktrees")
  fs.mkdirSync(finalRepo)
  fs.mkdirSync(finalWorktrees)
  git(finalRepo, "init", "-q", "-b", "main")
  git(finalRepo, "config", "user.name", "Herder Finalize Test")
  git(finalRepo, "config", "user.email", "herder-finalize@example.invalid")
  fs.writeFileSync(path.join(finalRepo, "base.txt"), "base\n")
  git(finalRepo, "add", "base.txt")
  git(finalRepo, "commit", "-q", "-m", "test: base")
  const finalInitial = git(finalRepo, "rev-parse", "HEAD")
  const finalPlanDir = writeFinalPlans(finalRepo)
  const finalRunId = "finalize-fixture"
  const finalIntegrationBranch = `plan-herder/integration-${finalRunId}`
  const finalIntegration = addWorktree(finalRepo, finalWorktrees, finalIntegrationBranch, finalInitial)
  const finalCandidateBranch = `plan-herder/${finalRunId}/001-candidate`
  const finalCandidate = addWorktree(finalRepo, finalWorktrees, finalCandidateBranch, finalIntegrationBranch)
  commitFile(finalCandidate, "done.txt", "done\n", "feat: add completed behavior")
  const finalCandidateHead = git(finalCandidate, "rev-parse", "HEAD")
  const finalStageBranch = `plan-herder/${finalRunId}/001-stage-1`
  const finalStage = addWorktree(finalRepo, finalWorktrees, finalStageBranch, finalIntegrationBranch)
  git(finalStage, "cherry-pick", finalCandidateHead)
  git(finalIntegration, "merge", "-q", "--ff-only", finalStageBranch)
  const finalCompletionCommit = git(finalIntegration, "rev-parse", "HEAD")
  const finalCompletionRef = `refs/plan-herder/${finalRunId}/completed/001`
  git(finalRepo, "update-ref", finalCompletionRef, finalCompletionCommit, "")
  const finalRejectedBranch = `plan-herder/${finalRunId}/002-candidate`
  const finalRejected = addWorktree(finalRepo, finalWorktrees, finalRejectedBranch, finalIntegrationBranch)
  commitFile(finalRejected, "rejected.txt", "rejected\n", "test: retain rejected experiment")

  const finalizePreview = cleanupResult(finalRepo, finalPlanDir, finalIntegrationBranch, ["--finalize", "--dry-run"]).json
  assert.equal(finalizePreview.finalization.eligible, true)
  assert.deepEqual(finalizePreview.finalization.refsPlanned, [
    { ref: finalCompletionRef, target: finalCompletionCommit, plan: "001" },
  ])
  assert.deepEqual(
    finalizePreview.actions.map((item) => item.branch).sort(),
    [finalCandidateBranch, finalStageBranch, finalRejectedBranch].sort(),
  )
  assert.equal(finalizePreview.actions.find((item) => item.branch === finalRejectedBranch).mode, "failed-evidence")
  assert.equal(git(finalRepo, "rev-parse", finalCompletionRef), finalCompletionCommit)

  const finalized = cleanupResult(finalRepo, finalPlanDir, finalIntegrationBranch, ["--finalize"]).json
  assert.equal(finalized.finalization.eligible, true)
  assert.deepEqual(finalized.finalization.refsRemoved, [
    { ref: finalCompletionRef, target: finalCompletionCommit, plan: "001" },
  ])
  assert.notEqual(run("git", ["-C", finalRepo, "show-ref", "--verify", finalCompletionRef], { allowFailure: true }).status, 0)
  assert.equal(git(finalRepo, "branch", "--list", finalCandidateBranch), "")
  assert.equal(git(finalRepo, "branch", "--list", finalStageBranch), "")
  assert.equal(git(finalRepo, "branch", "--list", finalRejectedBranch), "")
  assert.equal(fs.existsSync(finalCandidate), false)
  assert.equal(fs.existsSync(finalStage), false)
  assert.equal(fs.existsSync(finalRejected), false)
  assert.equal(finalized.preserved.completionRefs, null)
  assert.notEqual(git(finalRepo, "branch", "--list", finalIntegrationBranch), "")
  assert.equal(fs.existsSync(finalIntegration), true)

  const prematureHandoff = cleanupResult(finalRepo, finalPlanDir, finalIntegrationBranch, ["--finalize", "--handoff-target", "main", "--dry-run"]).json
  assert.equal(prematureHandoff.finalization.eligible, true)
  assert.equal(prematureHandoff.handoff.eligible, false)
  assert.equal(prematureHandoff.handoff.blockers.some((item) => item.reason === "handoff-target-does-not-contain-integration"), true)
  assert.notEqual(git(finalRepo, "branch", "--list", finalIntegrationBranch), "")
  assert.equal(fs.existsSync(finalIntegration), true)

  git(finalRepo, "merge", "-q", "--ff-only", finalIntegrationBranch)
  const handoffCleanup = cleanupResult(finalRepo, finalPlanDir, finalIntegrationBranch, ["--finalize", "--handoff-target", "main"]).json
  assert.equal(handoffCleanup.finalization.eligible, true)
  assert.equal(handoffCleanup.handoff.eligible, true)
  assert.equal(handoffCleanup.handoff.removed, true)
  assert.equal(handoffCleanup.preserved.integrationBranch, null)
  assert.equal(handoffCleanup.preserved.integrationWorktree, null)
  assert.equal(git(finalRepo, "branch", "--list", finalIntegrationBranch), "")
  assert.equal(fs.existsSync(finalIntegration), false)

  console.log("herder Fire cleanup tests passed")
} finally {
  fs.rmSync(root, { recursive: true, force: true })
}

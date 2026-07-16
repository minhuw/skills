#!/usr/bin/env node

import fs from "node:fs"
import path from "node:path"
import process from "node:process"
import { spawnSync } from "node:child_process"
import { fileURLToPath } from "node:url"
import { buildGraph } from "../../plans/scripts/herder-plans.mjs"

function fail(message) {
  throw new Error(message)
}

function runGit(repoRoot, args, { allowFailure = false } = {}) {
  const result = spawnSync("git", ["-C", repoRoot, ...args], {
    encoding: "utf8",
    maxBuffer: 16 * 1024 * 1024,
  })
  if (result.error) fail(`Cannot run git: ${result.error.message}`)
  if (result.status !== 0 && !allowFailure) {
    fail(`git ${args.join(" ")} failed: ${(result.stderr || result.stdout).trim()}`)
  }
  return result
}

function takeValue(args, index, name) {
  const value = args[index + 1]
  if (!value || value.startsWith("--")) fail(`${name} requires a value`)
  return value
}

function parseArguments(argv) {
  const options = {
    repo: null,
    planDir: null,
    integrationBranch: null,
    plan: null,
    dryRun: false,
    includeFailed: false,
    pretty: false,
  }
  for (let index = 0; index < argv.length; index += 1) {
    const argument = argv[index]
    if (["--dry-run", "--include-failed", "--pretty"].includes(argument)) {
      if (argument === "--dry-run") options.dryRun = true
      else if (argument === "--include-failed") options.includeFailed = true
      else options.pretty = true
      continue
    }
    if (["--repo", "--plan-dir", "--integration-branch", "--plan"].includes(argument)) {
      const value = takeValue(argv, index, argument)
      index += 1
      if (argument === "--repo") options.repo = value
      else if (argument === "--plan-dir") options.planDir = value
      else if (argument === "--integration-branch") options.integrationBranch = value
      else options.plan = value
      continue
    }
    fail(`Unknown argument: ${argument}`)
  }
  for (const [name, value] of [
    ["--repo", options.repo],
    ["--plan-dir", options.planDir],
    ["--integration-branch", options.integrationBranch],
  ]) {
    if (!value) fail(`${name} is required`)
  }
  return options
}

function canonicalPlanId(value) {
  if (!/^\d+$/.test(String(value))) fail(`Invalid plan ID: ${JSON.stringify(value)}`)
  const number = Number.parseInt(value, 10)
  if (!Number.isSafeInteger(number)) fail(`Invalid plan ID: ${JSON.stringify(value)}`)
  return String(number).padStart(3, "0")
}

function isInside(parent, candidate) {
  const relative = path.relative(parent, candidate)
  return relative === "" || (relative !== ".." && !relative.startsWith(`..${path.sep}`) && !path.isAbsolute(relative))
}

function parseIntegrationBranch(branch) {
  const match = String(branch).match(/^plan-herder\/integration-([A-Za-z0-9][A-Za-z0-9._-]*)$/)
  if (!match || match[1].includes("..") || match[1].endsWith(".") || match[1].endsWith(".lock")) {
    fail(`Integration branch must match plan-herder/integration-<run-id>: ${JSON.stringify(branch)}`)
  }
  return match[1]
}

function parseWorktrees(repoRoot) {
  const output = runGit(repoRoot, ["worktree", "list", "--porcelain", "-z"]).stdout
  const records = []
  for (const rawRecord of output.split("\0\0").filter(Boolean)) {
    const record = { path: "", branch: "", locked: false }
    for (const field of rawRecord.split("\0").filter(Boolean)) {
      if (field.startsWith("worktree ")) record.path = field.slice("worktree ".length)
      else if (field.startsWith("branch refs/heads/")) record.branch = field.slice("branch refs/heads/".length)
      else if (field === "locked" || field.startsWith("locked ")) record.locked = true
    }
    if (record.path) records.push(record)
  }
  return records
}

function listRunBranches(repoRoot, runId) {
  const prefix = `plan-herder/${runId}/`
  const output = runGit(repoRoot, [
    "for-each-ref",
    "--format=%(refname:lstrip=2)%09%(objectname)",
    `refs/heads/${prefix}`,
  ]).stdout
  return output.split(/\r?\n/).filter(Boolean).map((line) => {
    const separator = line.indexOf("\t")
    if (separator === -1) fail(`Cannot parse Git branch record: ${JSON.stringify(line)}`)
    const branch = line.slice(0, separator)
    return { branch, head: line.slice(separator + 1), relative: branch.slice(prefix.length) }
  })
}

function artifactIdentity(relative) {
  const match = relative.match(/^(\d{3,})-(candidate(?:-replan-\d+)?|stage-\d+|rescue(?:-\d+)?)$/)
  if (!match) return null
  return { plan: match[1], kind: match[2] }
}

function isAncestor(repoRoot, ancestor, descendant) {
  const result = runGit(repoRoot, ["merge-base", "--is-ancestor", ancestor, descendant], { allowFailure: true })
  if (result.status === 0) return true
  if (result.status === 1) return false
  fail(`Cannot compare ${ancestor} with ${descendant}: ${(result.stderr || result.stdout).trim()}`)
}

function completionMarkers(repoRoot, integrationBranch) {
  const output = runGit(repoRoot, ["log", "--format=%H%x09%s", integrationBranch]).stdout
  const markers = new Set()
  for (const line of output.split(/\r?\n/).filter(Boolean)) {
    const separator = line.indexOf("\t")
    if (separator === -1) continue
    const subject = line.slice(separator + 1)
    const match = subject.match(/^plan-herder\((\d{3,})\): mark plan done$/)
    if (match) markers.add(match[1])
  }
  return markers
}

function worktreeStatus(repoRoot, worktree) {
  if (!worktree) return { clean: true, locked: false, path: null }
  if (worktree.locked) return { clean: false, locked: true, path: worktree.path }
  if (!fs.existsSync(worktree.path)) return { clean: false, locked: false, path: worktree.path, missing: true }
  const result = runGit(repoRoot, ["-C", worktree.path, "status", "--porcelain=v1", "--untracked-files=all"])
  return { clean: result.stdout === "", locked: false, path: worktree.path }
}

export function cleanupRun(input) {
  const repoCandidate = path.resolve(input.repo)
  if (!fs.existsSync(repoCandidate) || !fs.statSync(repoCandidate).isDirectory()) fail(`Repository does not exist: ${repoCandidate}`)
  const repoRoot = fs.realpathSync(repoCandidate)
  const actualRoot = fs.realpathSync(runGit(repoRoot, ["rev-parse", "--show-toplevel"]).stdout.trim())
  if (actualRoot !== repoRoot) fail(`--repo must be the Git repository root: ${actualRoot}`)

  const planCandidate = path.resolve(repoRoot, input.planDir)
  if (!fs.existsSync(planCandidate) || !fs.statSync(planCandidate).isDirectory()) fail(`Plan directory does not exist: ${planCandidate}`)
  const planDir = fs.realpathSync(planCandidate)
  if (!isInside(repoRoot, planDir)) fail(`Plan directory must be inside the repository: ${planDir}`)

  const runId = parseIntegrationBranch(input.integrationBranch)
  runGit(repoRoot, ["check-ref-format", "--branch", input.integrationBranch])
  const integrationRef = `refs/heads/${input.integrationBranch}`
  runGit(repoRoot, ["show-ref", "--verify", integrationRef])
  const integrationHead = runGit(repoRoot, ["rev-parse", integrationRef]).stdout.trim()
  const graph = buildGraph(planDir)
  const planFilter = input.plan ? canonicalPlanId(input.plan) : null
  if (planFilter && !graph.plans.some((plan) => plan.id === planFilter)) fail(`Plan ${planFilter} is not indexed in ${graph.readme}`)

  const plans = new Map(graph.plans.map((plan) => [plan.id, plan]))
  const markers = completionMarkers(repoRoot, input.integrationBranch)
  const worktrees = new Map(parseWorktrees(repoRoot).filter((item) => item.branch).map((item) => [item.branch, item]))
  const actions = []
  const skipped = []

  for (const item of listRunBranches(repoRoot, runId)) {
    const identity = artifactIdentity(item.relative)
    if (!identity) {
      skipped.push({ branch: item.branch, reason: "unrecognized-run-artifact" })
      continue
    }
    if (planFilter && identity.plan !== planFilter) continue
    const plan = plans.get(identity.plan)
    if (!plan) {
      skipped.push({ branch: item.branch, plan: identity.plan, reason: "plan-not-indexed" })
      continue
    }

    let mode
    if (plan.status === "DONE") {
      if (!markers.has(plan.id)) {
        skipped.push({ branch: item.branch, plan: plan.id, status: plan.status, reason: "completion-marker-missing" })
        continue
      }
      if (!isAncestor(repoRoot, item.head, integrationHead)) {
        skipped.push({ branch: item.branch, plan: plan.id, status: plan.status, reason: "artifact-not-reachable-from-integration" })
        continue
      }
      mode = "integrated"
    } else if (input.includeFailed) {
      mode = "failed-evidence"
    } else {
      skipped.push({ branch: item.branch, plan: plan.id, status: plan.status, reason: "preserved-non-done-evidence" })
      continue
    }

    const state = worktreeStatus(repoRoot, worktrees.get(item.branch))
    if (state.locked) {
      skipped.push({ branch: item.branch, plan: plan.id, status: plan.status, worktree: state.path, reason: "worktree-locked" })
      continue
    }
    if (state.missing) {
      skipped.push({ branch: item.branch, plan: plan.id, status: plan.status, worktree: state.path, reason: "worktree-missing" })
      continue
    }
    if (!state.clean) {
      skipped.push({ branch: item.branch, plan: plan.id, status: plan.status, worktree: state.path, reason: "worktree-dirty" })
      continue
    }
    actions.push({
      branch: item.branch,
      head: item.head,
      plan: plan.id,
      status: plan.status,
      kind: identity.kind,
      mode,
      worktree: state.path,
      operations: [...(state.path ? ["remove-worktree"] : []), mode === "integrated" ? "delete-proven-branch" : "delete-failed-evidence-branch"],
    })
  }

  const removed = []
  if (!input.dryRun) {
    for (const action of actions) {
      if (action.worktree) runGit(repoRoot, ["worktree", "remove", "--", action.worktree])
      runGit(repoRoot, ["update-ref", "-d", `refs/heads/${action.branch}`, action.head])
      removed.push(action)
    }
  }

  return {
    repoRoot,
    planDir,
    integrationBranch: input.integrationBranch,
    integrationHead,
    runId,
    plan: planFilter,
    dryRun: Boolean(input.dryRun),
    includeFailed: Boolean(input.includeFailed),
    actions,
    removed,
    skipped,
    preserved: {
      integrationBranch: input.integrationBranch,
      integrationWorktree: worktrees.get(input.integrationBranch)?.path ?? null,
      logs: true,
    },
  }
}

function main(argv) {
  const options = parseArguments(argv)
  const result = cleanupRun(options)
  process.stdout.write(`${JSON.stringify(result, null, options.pretty ? 2 : 0)}\n`)
}

const isMain = process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)
if (isMain) {
  try {
    main(process.argv.slice(2))
  } catch (error) {
    process.stderr.write(`herder-cleanup: ${error.message}\n`)
    process.exitCode = 1
  }
}

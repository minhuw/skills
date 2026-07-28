#!/usr/bin/env node

import { spawnSync } from "node:child_process"
import { createHash, randomUUID } from "node:crypto"
import fs from "node:fs"
import path from "node:path"
import process from "node:process"
import { fileURLToPath } from "node:url"
import { buildGraph, snapshotPlan } from "../../plans/scripts/herder-plans.mjs"

export const ASSIGNMENT_SCHEMA_VERSION = 1
export const ASSIGNMENT_KIND = "herder-plan-assignment"
export const RUN_ASSIGNMENT_KIND = "herder-run-assignment"
export const ASSIGNMENT_RELATIVE_SUFFIX = path.join(".herder", "assignment.json")
export const RUN_ASSIGNMENT_RELATIVE_SUFFIX = path.join(".herder", "run-assignment.json")

function sha256(value) {
  return createHash("sha256").update(value).digest("hex")
}

function isSha256(value) {
  return /^[0-9a-f]{64}$/.test(String(value))
}

function isInside(parent, candidate) {
  const relative = path.relative(parent, candidate)
  return relative !== ""
    && relative !== ".."
    && !relative.startsWith(`..${path.sep}`)
    && !path.isAbsolute(relative)
}

function git(cwd, args, { allowFailure = false } = {}) {
  const result = spawnSync("git", ["-C", cwd, ...args], { encoding: "utf8" })
  if (result.error) throw new Error(`Cannot run git: ${result.error.message}`)
  if (result.status !== 0 && !allowFailure) {
    throw new Error(`git ${args.join(" ")} failed: ${(result.stderr || result.stdout).trim()}`)
  }
  return result
}

function gitValue(cwd, ...args) {
  return git(cwd, args).stdout.trim()
}

function canonicalGitPath(cwd, value) {
  const resolved = path.isAbsolute(value) ? value : path.resolve(cwd, value)
  return fs.realpathSync(resolved)
}

function repositoryContext(start) {
  const root = fs.realpathSync(gitValue(start, "rev-parse", "--show-toplevel"))
  const commonDir = canonicalGitPath(root, gitValue(root, "rev-parse", "--git-common-dir"))
  return { root, commonDir }
}

function currentBranch(worktree) {
  const result = git(worktree, ["symbolic-ref", "--quiet", "--short", "HEAD"], { allowFailure: true })
  if (result.status !== 0 || !result.stdout.trim()) {
    throw new Error(`worktree must have a checked-out branch: ${worktree}`)
  }
  return result.stdout.trim()
}

function parseArguments(argv) {
  const command = argv.shift()
  if (!["materialize", "materialize-run", "verify"].includes(command)) {
    throw new Error("usage: assignment-bundle.mjs materialize|materialize-run|verify [options]")
  }
  const options = { pretty: false }
  while (argv.length > 0) {
    const argument = argv.shift()
    if (argument === "--pretty") {
      options.pretty = true
      continue
    }
    if (!argument.startsWith("--")) throw new Error(`unknown argument: ${argument}`)
    const value = argv.shift()
    if (!value || value.startsWith("--")) throw new Error(`${argument} requires a value`)
    const key = argument.slice(2).replace(/-([a-z])/g, (_, letter) => letter.toUpperCase())
    if (Object.hasOwn(options, key)) throw new Error(`${argument} may be provided only once`)
    options[key] = value
  }
  return { command, options }
}

function requireOption(options, name) {
  const value = options[name]
  if (!value) {
    const flag = name.replace(/[A-Z]/g, (letter) => `-${letter.toLowerCase()}`)
    throw new Error(`--${flag} is required`)
  }
  return value
}

function assertKnownOptions(options, allowed) {
  for (const key of Object.keys(options)) {
    if (!allowed.has(key)) throw new Error(`unknown option: --${key.replace(/[A-Z]/g, (letter) => `-${letter.toLowerCase()}`)}`)
  }
}

function assertNoSymlinkComponents(root, candidate) {
  if (!isInside(root, candidate)) throw new Error(`assignment path escapes the worktree: ${candidate}`)
  const relative = path.relative(root, candidate)
  let cursor = root
  for (const component of relative.split(path.sep)) {
    cursor = path.join(cursor, component)
    let status
    try {
      status = fs.lstatSync(cursor)
    } catch (error) {
      if (error.code === "ENOENT") continue
      throw error
    }
    if (status.isSymbolicLink()) throw new Error(`assignment path contains a symlink: ${cursor}`)
    if (cursor !== candidate && !status.isDirectory()) {
      throw new Error(`assignment parent is not a directory: ${cursor}`)
    }
  }
}

function assertIgnored(worktree, bundlePath) {
  const relative = path.relative(worktree, bundlePath).split(path.sep).join("/")
  const result = git(worktree, ["check-ignore", "--quiet", "--no-index", "--", relative], { allowFailure: true })
  if (result.status !== 0) {
    throw new Error(`assignment bundle must be Git-ignored before materialization: ${relative}`)
  }
  return relative
}

function assertSnapshotEntry(entry) {
  if (!entry.plan || typeof entry.plan !== "object" || !/^\d{3,}$/.test(String(entry.plan.id))) {
    throw new Error("assignment bundle has an invalid plan identity")
  }
  if (!Array.isArray(entry.snapshotInputs) || entry.snapshotInputs.length === 0) {
    throw new Error("assignment bundle has no snapshot input fingerprints")
  }
  for (const input of entry.snapshotInputs) {
    if (!input || typeof input.kind !== "string" || typeof input.name !== "string" || !isSha256(input.sha256)) {
      throw new Error("assignment bundle has an invalid snapshot input fingerprint")
    }
    if (Object.hasOwn(input, "file")) throw new Error("assignment bundle leaks a coordinator snapshot path")
  }
  if (typeof entry.planText !== "string" || !isSha256(entry.snapshotSha256)) {
    throw new Error("assignment bundle has invalid compiled plan content")
  }
  if (sha256(entry.planText) !== entry.snapshotSha256) {
    throw new Error("assignment bundle planText does not match snapshotSha256")
  }
}

function runSnapshotSha256(plans) {
  return sha256(JSON.stringify(plans.map((entry) => ({
    id: entry.plan.id,
    snapshotSha256: entry.snapshotSha256,
  }))))
}

function assertBundleEnvelope(bundle) {
  if (!bundle || typeof bundle !== "object" || Array.isArray(bundle)) throw new Error("assignment bundle is not a JSON object")
  if (
    bundle.schemaVersion !== ASSIGNMENT_SCHEMA_VERSION
    || ![ASSIGNMENT_KIND, RUN_ASSIGNMENT_KIND].includes(bundle.kind)
  ) {
    throw new Error(`unsupported assignment bundle schema: ${JSON.stringify(bundle.schemaVersion)}`)
  }
  if (!bundle.assignment || typeof bundle.assignment.branch !== "string" || typeof bundle.assignment.generationBase !== "string") {
    throw new Error("assignment bundle has invalid branch metadata")
  }
  if (bundle.kind === ASSIGNMENT_KIND) {
    assertSnapshotEntry(bundle)
    return
  }
  if (!Array.isArray(bundle.plans) || bundle.plans.length === 0) {
    throw new Error("run assignment bundle has no plan snapshots")
  }
  for (const entry of bundle.plans) assertSnapshotEntry(entry)
  if (!isSha256(bundle.snapshotSha256) || bundle.snapshotSha256 !== runSnapshotSha256(bundle.plans)) {
    throw new Error("run assignment bundle snapshot set does not match snapshotSha256")
  }
}

function snapshotEntry(snapshot) {
  return {
    snapshotSha256: snapshot.snapshotSha256,
    snapshotInputs: snapshot.snapshotInputs.map((input) => ({
      kind: input.kind,
      name: path.basename(input.file),
      sha256: input.sha256,
    })),
    plan: {
      id: snapshot.plan.id,
      title: snapshot.plan.title,
      kind: snapshot.plan.kind,
      parentObjective: snapshot.plan.parentObjective,
      dependencies: snapshot.plan.dependencies,
      reviewBudget: snapshot.plan.reviewBudget,
      inScopePaths: snapshot.plan.inScopePaths,
    },
    planText: snapshot.planText,
  }
}

function materialize(options, { run = false } = {}) {
  const allowed = new Set([
    "pretty",
    "planDir",
    "worktree",
    "expectedBranch",
    "expectedHead",
  ])
  if (!run) {
    allowed.add("plan")
    allowed.add("expectedSnapshotSha256")
  }
  assertKnownOptions(options, allowed)
  const planId = run ? null : requireOption(options, "plan")
  const planDir = fs.realpathSync(path.resolve(requireOption(options, "planDir")))
  const worktreeInput = fs.realpathSync(path.resolve(requireOption(options, "worktree")))
  const expectedBranch = requireOption(options, "expectedBranch")
  const expectedHead = requireOption(options, "expectedHead")
  const expectedSnapshotSha256 = run ? null : requireOption(options, "expectedSnapshotSha256")
  if (!run && !isSha256(expectedSnapshotSha256)) {
    throw new Error("--expected-snapshot-sha256 must be a lowercase SHA-256")
  }

  const coordination = repositoryContext(planDir)
  const execution = repositoryContext(worktreeInput)
  if (worktreeInput !== execution.root) throw new Error(`--worktree must be the Git worktree root: ${execution.root}`)
  if (coordination.root === execution.root) throw new Error("assignment bundle requires a separate execution worktree")
  if (coordination.commonDir !== execution.commonDir) {
    throw new Error("plan directory and execution worktree do not belong to the same Git repository")
  }
  if (!isInside(coordination.root, planDir)) throw new Error("plan directory must be inside the coordination checkout")

  const branch = currentBranch(execution.root)
  if (branch !== expectedBranch) throw new Error(`worktree branch mismatch: expected ${expectedBranch}, found ${branch}`)
  const head = gitValue(execution.root, "rev-parse", "HEAD")
  if (head !== expectedHead) throw new Error(`worktree HEAD mismatch: expected ${expectedHead}, found ${head}`)
  const beforeStatus = gitValue(execution.root, "status", "--porcelain=v1", "--untracked-files=all")
  if (beforeStatus) throw new Error("execution worktree must be clean before assignment materialization")

  let snapshots
  if (run) {
    const graph = buildGraph(planDir)
    if (graph.plans.length === 0) throw new Error("cannot materialize a run assignment for an empty plan set")
    snapshots = graph.plans.map((plan) => snapshotPlan(planDir, plan.id))
  } else {
    const snapshot = snapshotPlan(planDir, planId)
    if (snapshot.snapshotSha256 !== expectedSnapshotSha256) {
      throw new Error(`plan snapshot mismatch: expected ${expectedSnapshotSha256}, found ${snapshot.snapshotSha256}`)
    }
    snapshots = [snapshot]
  }

  const relativePlanDir = path.relative(coordination.root, planDir)
  const bundlePath = path.join(
    execution.root,
    relativePlanDir,
    run ? RUN_ASSIGNMENT_RELATIVE_SUFFIX : ASSIGNMENT_RELATIVE_SUFFIX,
  )
  assertNoSymlinkComponents(execution.root, bundlePath)
  const relativePath = assertIgnored(execution.root, bundlePath)
  if (fs.existsSync(bundlePath)) throw new Error(`assignment bundle already exists: ${bundlePath}`)

  const entries = snapshots.map(snapshotEntry)
  const bundle = run
    ? {
        schemaVersion: ASSIGNMENT_SCHEMA_VERSION,
        kind: RUN_ASSIGNMENT_KIND,
        snapshotSha256: runSnapshotSha256(entries),
        plans: entries,
        assignment: {
          branch,
          generationBase: head,
        },
      }
    : {
        schemaVersion: ASSIGNMENT_SCHEMA_VERSION,
        kind: ASSIGNMENT_KIND,
        ...entries[0],
        assignment: {
          branch,
          generationBase: head,
        },
      }
  assertBundleEnvelope(bundle)
  const bytes = `${JSON.stringify(bundle, null, 2)}\n`
  const bundleSha256 = sha256(bytes)

  fs.mkdirSync(path.dirname(bundlePath), { recursive: true })
  assertNoSymlinkComponents(execution.root, bundlePath)
  const temporary = `${bundlePath}.tmp-${process.pid}-${randomUUID()}`
  try {
    fs.writeFileSync(temporary, bytes, { flag: "wx", mode: 0o600 })
    fs.renameSync(temporary, bundlePath)
    fs.chmodSync(bundlePath, 0o444)
  } finally {
    if (fs.existsSync(temporary)) fs.rmSync(temporary)
  }

  const afterStatus = gitValue(execution.root, "status", "--porcelain=v1", "--untracked-files=all")
  if (afterStatus) {
    throw new Error("assignment materialization changed visible Git worktree state")
  }

  return {
    ok: true,
    command: run ? "materialize-run" : "materialize",
    scope: run ? "RUN" : snapshots[0].plan.id,
    branch,
    generationBase: head,
    bundlePath,
    relativePath,
    bundleSha256,
    snapshotSha256: bundle.snapshotSha256,
  }
}

function verify(options) {
  assertKnownOptions(options, new Set(["pretty", "worktree", "bundle", "expectedBundleSha256"]))
  const worktreeInput = fs.realpathSync(path.resolve(requireOption(options, "worktree")))
  const bundleInput = path.resolve(requireOption(options, "bundle"))
  const expectedBundleSha256 = requireOption(options, "expectedBundleSha256")
  if (!isSha256(expectedBundleSha256)) throw new Error("--expected-bundle-sha256 must be a lowercase SHA-256")

  const execution = repositoryContext(worktreeInput)
  if (worktreeInput !== execution.root) throw new Error(`--worktree must be the Git worktree root: ${execution.root}`)
  if (!fs.existsSync(bundleInput)) throw new Error(`assignment bundle is missing: ${bundleInput}`)
  const bundlePath = fs.realpathSync(bundleInput)
  if (bundlePath !== bundleInput || fs.lstatSync(bundleInput).isSymbolicLink()) {
    throw new Error(`assignment bundle must not be a symlink: ${bundleInput}`)
  }
  assertNoSymlinkComponents(execution.root, bundlePath)
  if (!fs.statSync(bundlePath).isFile()) throw new Error(`assignment bundle is not a regular file: ${bundlePath}`)
  if ((fs.statSync(bundlePath).mode & 0o222) !== 0) throw new Error("assignment bundle must be read-only")
  const relativePath = assertIgnored(execution.root, bundlePath)

  const bytes = fs.readFileSync(bundlePath)
  const bundleSha256 = sha256(bytes)
  if (bundleSha256 !== expectedBundleSha256) {
    throw new Error(`assignment bundle hash mismatch: expected ${expectedBundleSha256}, found ${bundleSha256}`)
  }
  let bundle
  try {
    bundle = JSON.parse(bytes.toString("utf8"))
  } catch (error) {
    throw new Error(`assignment bundle is not valid JSON: ${error.message}`)
  }
  assertBundleEnvelope(bundle)
  const branch = currentBranch(execution.root)
  if (bundle.assignment.branch !== branch) {
    throw new Error(`assignment branch mismatch: expected ${bundle.assignment.branch}, found ${branch}`)
  }

  return {
    ok: true,
    command: "verify",
    scope: bundle.kind === RUN_ASSIGNMENT_KIND ? "RUN" : bundle.plan.id,
    branch,
    generationBase: bundle.assignment.generationBase,
    bundlePath,
    relativePath,
    bundleSha256,
    snapshotSha256: bundle.snapshotSha256,
  }
}

function print(result, pretty) {
  process.stdout.write(`${JSON.stringify(result, null, pretty ? 2 : 0)}\n`)
}

function main() {
  let parsed
  try {
    parsed = parseArguments(process.argv.slice(2))
    const result = parsed.command === "verify"
      ? verify(parsed.options)
      : materialize(parsed.options, { run: parsed.command === "materialize-run" })
    print(result, parsed.options.pretty)
  } catch (error) {
    print({ ok: false, error: error.message }, parsed?.options?.pretty)
    process.exitCode = 1
  }
}

const invokedAsScript = process.argv[1] && fs.realpathSync(process.argv[1]) === fileURLToPath(import.meta.url)
if (invokedAsScript) main()

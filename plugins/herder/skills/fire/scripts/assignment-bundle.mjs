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

function isObjectId(value) {
  return /^[0-9a-f]{40,64}$/.test(String(value))
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

function gitBuffer(cwd, args) {
  const result = spawnSync("git", ["-C", cwd, ...args])
  if (result.error) throw new Error(`Cannot run git: ${result.error.message}`)
  if (result.status !== 0) {
    throw new Error(`git ${args.join(" ")} failed: ${Buffer.concat([result.stderr || Buffer.alloc(0), result.stdout || Buffer.alloc(0)]).toString().trim()}`)
  }
  return result.stdout
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

function readRequiredMetadata(metadataDir, name) {
  const file = path.join(metadataDir, name)
  let status
  try {
    status = fs.lstatSync(file)
  } catch (error) {
    if (error.code === "ENOENT") throw new Error(`active rebase metadata is missing ${name}`)
    throw error
  }
  if (!status.isFile() || status.isSymbolicLink()) {
    throw new Error(`active rebase metadata is not a regular file: ${name}`)
  }
  const value = fs.readFileSync(file, "utf8").trim()
  if (!value) throw new Error(`active rebase metadata is empty: ${name}`)
  return value
}

function fingerprintTree(root) {
  const entries = []
  function visit(directory, relativeDirectory = "") {
    for (const name of fs.readdirSync(directory).sort()) {
      const absolute = path.join(directory, name)
      const relative = path.join(relativeDirectory, name).split(path.sep).join("/")
      const status = fs.lstatSync(absolute)
      if (status.isSymbolicLink()) throw new Error(`active rebase metadata contains a symlink: ${relative}`)
      if (status.isDirectory()) {
        entries.push({ path: `${relative}/`, type: "directory", mode: status.mode & 0o777 })
        visit(absolute, relative)
        continue
      }
      if (!status.isFile()) throw new Error(`active rebase metadata contains a non-file: ${relative}`)
      entries.push({
        path: relative,
        type: "file",
        mode: status.mode & 0o777,
        size: status.size,
        sha256: sha256(fs.readFileSync(absolute)),
      })
    }
  }
  visit(root)
  return entries
}

function fingerprintUntracked(worktree) {
  const output = gitBuffer(worktree, ["ls-files", "--others", "--exclude-standard", "-z"])
  const names = output.toString("utf8").split("\0").filter(Boolean).sort()
  return names.map((name) => {
    const absolute = path.resolve(worktree, name)
    if (!isInside(worktree, absolute)) throw new Error(`untracked path escapes the worktree: ${name}`)
    const status = fs.lstatSync(absolute)
    if (status.isSymbolicLink()) {
      return { path: name, type: "symlink", mode: status.mode & 0o777, sha256: sha256(fs.readlinkSync(absolute)) }
    }
    if (!status.isFile()) throw new Error(`untracked path is not a regular file: ${name}`)
    return {
      path: name,
      type: "file",
      mode: status.mode & 0o777,
      size: status.size,
      sha256: sha256(fs.readFileSync(absolute)),
    }
  })
}

function worktreeLeaseReason(worktree) {
  const blocks = gitValue(worktree, "worktree", "list", "--porcelain").split(/\n\n+/)
  const prefix = `worktree ${worktree}\n`
  const block = blocks.find((entry) => `${entry}\n`.startsWith(prefix))
  if (!block) throw new Error(`expected stable plan worktree is not registered: ${worktree}`)
  const locked = block.split("\n").find((line) => line === "locked" || line.startsWith("locked "))
  return locked ? locked.slice("locked".length).trim() : null
}

function activeRebaseMetadata(worktree) {
  const mergePath = path.resolve(worktree, gitValue(worktree, "rev-parse", "--git-path", "rebase-merge"))
  const applyPath = path.resolve(worktree, gitValue(worktree, "rev-parse", "--git-path", "rebase-apply"))
  const candidates = [
    ["merge", mergePath],
    ["apply", applyPath],
  ].filter(([, candidate]) => fs.existsSync(candidate))
  if (candidates.length !== 1) {
    throw new Error(candidates.length === 0
      ? "active-rebase verification requires active Git rebase metadata"
      : "active-rebase verification found ambiguous Git rebase metadata")
  }
  const [backend, metadataDir] = candidates[0]
  if (!fs.lstatSync(metadataDir).isDirectory() || fs.lstatSync(metadataDir).isSymbolicLink()) {
    throw new Error("active rebase metadata must be a real directory")
  }
  return {
    backend,
    metadataDir,
    headName: readRequiredMetadata(metadataDir, "head-name"),
    onto: readRequiredMetadata(metadataDir, "onto"),
    origHead: readRequiredMetadata(metadataDir, "orig-head"),
    entries: fingerprintTree(metadataDir),
  }
}

function parseArguments(argv) {
  const command = argv.shift()
  if (!["materialize", "materialize-run", "inspect-active-rebase", "verify"].includes(command)) {
    throw new Error("usage: assignment-bundle.mjs materialize|materialize-run|inspect-active-rebase|verify [options]")
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
  const verificationMode = options.verificationMode || "branch"
  if (verificationMode === "active-rebase") return verifyActiveRebase(options)
  if (verificationMode !== "branch") throw new Error(`unknown verification mode: ${verificationMode}`)
  assertKnownOptions(options, new Set(["pretty", "worktree", "bundle", "expectedBundleSha256", "verificationMode"]))
  const worktreeInput = fs.realpathSync(path.resolve(requireOption(options, "worktree")))
  const execution = repositoryContext(worktreeInput)
  if (worktreeInput !== execution.root) throw new Error(`--worktree must be the Git worktree root: ${execution.root}`)
  const verifiedBundle = readVerifiedBundle(execution.root, options)
  const { bundle, bundlePath, relativePath, bundleSha256 } = verifiedBundle
  const branch = currentBranch(execution.root)
  if (bundle.assignment.branch !== branch) {
    throw new Error(`assignment branch mismatch: expected ${bundle.assignment.branch}, found ${branch}`)
  }

  return {
    ok: true,
    command: "verify",
    verificationMode: "branch",
    scope: bundle.kind === RUN_ASSIGNMENT_KIND ? "RUN" : bundle.plan.id,
    branch,
    generationBase: bundle.assignment.generationBase,
    bundlePath,
    relativePath,
    bundleSha256,
    snapshotSha256: bundle.snapshotSha256,
  }
}

function readVerifiedBundle(worktree, options) {
  const bundleInput = path.resolve(requireOption(options, "bundle"))
  const expectedBundleSha256 = requireOption(options, "expectedBundleSha256")
  if (!isSha256(expectedBundleSha256)) throw new Error("--expected-bundle-sha256 must be a lowercase SHA-256")
  if (!fs.existsSync(bundleInput)) throw new Error(`assignment bundle is missing: ${bundleInput}`)
  const bundlePath = fs.realpathSync(bundleInput)
  if (bundlePath !== bundleInput || fs.lstatSync(bundleInput).isSymbolicLink()) {
    throw new Error(`assignment bundle must not be a symlink: ${bundleInput}`)
  }
  assertNoSymlinkComponents(worktree, bundlePath)
  if (!fs.statSync(bundlePath).isFile()) throw new Error(`assignment bundle is not a regular file: ${bundlePath}`)
  if ((fs.statSync(bundlePath).mode & 0o222) !== 0) throw new Error("assignment bundle must be read-only")
  const relativePath = assertIgnored(worktree, bundlePath)

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
  return { bundle, bundlePath, relativePath, bundleSha256 }
}

function activeRebaseAllowedOptions({ includeStateHash }) {
  const allowed = new Set([
    "pretty",
    "worktree",
    "bundle",
    "expectedBundleSha256",
    "expectedWorktree",
    "expectedBranch",
    "expectedWorkerMode",
    "expectedDetachedHead",
    "expectedRebaseOnto",
    "expectedRebaseOrigHead",
    "expectedPlanHead",
    "expectedCheckpointRef",
    "expectedCheckpoint",
    "expectedLeaseReason",
  ])
  if (includeStateHash) {
    allowed.add("verificationMode")
    allowed.add("expectedRebaseStateSha256")
  }
  return allowed
}

function requireObjectIdOption(options, name) {
  const value = requireOption(options, name)
  if (!isObjectId(value)) {
    const flag = name.replace(/[A-Z]/g, (letter) => `-${letter.toLowerCase()}`)
    throw new Error(`--${flag} must be a full lowercase Git object ID`)
  }
  return value
}

function activeRebaseEvidence(options, { includeStateHash }) {
  assertKnownOptions(options, activeRebaseAllowedOptions({ includeStateHash }))
  const worktreeInput = fs.realpathSync(path.resolve(requireOption(options, "worktree")))
  const expectedWorktree = path.resolve(requireOption(options, "expectedWorktree"))
  const execution = repositoryContext(worktreeInput)
  if (worktreeInput !== execution.root) throw new Error(`--worktree must be the Git worktree root: ${execution.root}`)
  if (expectedWorktree !== execution.root) {
    throw new Error(`active-rebase worktree mismatch: expected ${expectedWorktree}, found ${execution.root}`)
  }

  const expectedBranch = requireOption(options, "expectedBranch")
  const expectedWorkerMode = requireOption(options, "expectedWorkerMode")
  const expectedDetachedHead = requireObjectIdOption(options, "expectedDetachedHead")
  const expectedRebaseOnto = requireObjectIdOption(options, "expectedRebaseOnto")
  const expectedRebaseOrigHead = requireObjectIdOption(options, "expectedRebaseOrigHead")
  const expectedPlanHead = requireObjectIdOption(options, "expectedPlanHead")
  const expectedCheckpointRef = requireOption(options, "expectedCheckpointRef")
  const expectedCheckpoint = requireObjectIdOption(options, "expectedCheckpoint")
  const expectedLeaseReason = requireOption(options, "expectedLeaseReason")
  if (expectedWorkerMode !== "GUIDED_REPAIR") {
    throw new Error("active-rebase verification requires --expected-worker-mode GUIDED_REPAIR")
  }
  const branchMatch = expectedBranch.match(/^herder\/([^/]+)\/(\d{3,})$/)
  if (!branchMatch) throw new Error(`active-rebase verification requires an exact Herder plan branch: ${expectedBranch}`)
  const [, planName, planId] = branchMatch
  const [leaseNamespace, leasePlanName, leasePlanId, leaseRole, leaseAttempt, ...leaseTask] = expectedLeaseReason.split(":")
  const normalizedLeaseRole = leaseRole?.replace(/^plan[-_]/, "").toLowerCase()
  if (leaseNamespace !== "plan-herder"
    || leasePlanName !== planName
    || leasePlanId !== planId
    || normalizedLeaseRole !== "implementer"
    || !leaseAttempt
    || leaseTask.join(":").length === 0
    || /[\r\n]/.test(expectedLeaseReason)) {
    throw new Error("active-rebase verification requires the exact guided-repair Implementer lease")
  }
  const branchRef = `refs/heads/${expectedBranch}`
  if (git(execution.root, ["check-ref-format", branchRef], { allowFailure: true }).status !== 0) {
    throw new Error(`invalid expected plan branch: ${expectedBranch}`)
  }
  const checkpointPrefix = `refs/plan-herder/${planName}/checkpoints/${planId}/`
  if (!expectedCheckpointRef.startsWith(checkpointPrefix)
    || !/^\d+-\d+$/.test(expectedCheckpointRef.slice(checkpointPrefix.length))
    || git(execution.root, ["check-ref-format", expectedCheckpointRef], { allowFailure: true }).status !== 0) {
    throw new Error(`invalid expected Herder checkpoint ref: ${expectedCheckpointRef}`)
  }
  if (expectedPlanHead !== expectedRebaseOrigHead || expectedCheckpoint !== expectedRebaseOrigHead) {
    throw new Error("active-rebase plan head, original commit, and checkpoint must identify the same pre-restack commit")
  }

  const verifiedBundle = readVerifiedBundle(execution.root, options)
  const { bundle, bundlePath, relativePath, bundleSha256 } = verifiedBundle
  if (bundle.kind !== ASSIGNMENT_KIND) throw new Error("active-rebase verification requires a plan assignment bundle")
  if (bundle.plan.id !== planId) {
    throw new Error(`assignment plan mismatch: expected ${planId}, found ${bundle.plan.id}`)
  }
  if (bundle.assignment.branch !== expectedBranch) {
    throw new Error(`assignment branch mismatch: expected ${expectedBranch}, found ${bundle.assignment.branch}`)
  }

  const symbolic = git(execution.root, ["symbolic-ref", "--quiet", "HEAD"], { allowFailure: true })
  if (symbolic.status === 0 || symbolic.stdout.trim()) {
    throw new Error("active-rebase verification requires Git's detached rebase HEAD")
  }
  const rebase = activeRebaseMetadata(execution.root)
  if (rebase.headName !== branchRef) {
    throw new Error(`active rebase head-name mismatch: expected ${branchRef}, found ${rebase.headName}`)
  }
  if (rebase.onto !== expectedRebaseOnto) {
    throw new Error(`active rebase onto mismatch: expected ${expectedRebaseOnto}, found ${rebase.onto}`)
  }
  if (rebase.origHead !== expectedRebaseOrigHead) {
    throw new Error(`active rebase orig-head mismatch: expected ${expectedRebaseOrigHead}, found ${rebase.origHead}`)
  }

  const detachedHead = gitValue(execution.root, "rev-parse", "HEAD")
  const planHead = gitValue(execution.root, "rev-parse", "--verify", branchRef)
  const checkpoint = gitValue(execution.root, "rev-parse", "--verify", expectedCheckpointRef)
  const origHeadRef = gitValue(execution.root, "rev-parse", "--verify", "ORIG_HEAD")
  if (detachedHead !== expectedDetachedHead) {
    throw new Error(`active rebase detached HEAD mismatch: expected ${expectedDetachedHead}, found ${detachedHead}`)
  }
  if (planHead !== expectedPlanHead) {
    throw new Error(`active rebase plan branch moved: expected ${expectedPlanHead}, found ${planHead}`)
  }
  if (checkpoint !== expectedCheckpoint) {
    throw new Error(`active rebase checkpoint mismatch: expected ${expectedCheckpoint}, found ${checkpoint}`)
  }
  if (origHeadRef !== expectedRebaseOrigHead) {
    throw new Error(`active rebase ORIG_HEAD mismatch: expected ${expectedRebaseOrigHead}, found ${origHeadRef}`)
  }
  const leaseReason = worktreeLeaseReason(execution.root)
  if (leaseReason !== expectedLeaseReason) {
    throw new Error(`active-rebase lease mismatch: expected ${expectedLeaseReason}, found ${leaseReason || "unlocked"}`)
  }

  const indexStages = gitBuffer(execution.root, ["ls-files", "--stage", "-z"])
  const conflictBytes = gitBuffer(execution.root, ["diff", "--name-only", "--diff-filter=U", "-z"])
  const conflicts = conflictBytes.toString("utf8").split("\0").filter(Boolean).sort()
  if (conflicts.length === 0) throw new Error("active-rebase verification requires preserved unresolved conflicts")
  const state = {
    schemaVersion: 1,
    worktree: execution.root,
    assignment: {
      bundlePath,
      bundleSha256,
      kind: bundle.kind,
      branch: bundle.assignment.branch,
      workerMode: expectedWorkerMode,
    },
    leaseReason,
    rebase: {
      backend: rebase.backend,
      headName: rebase.headName,
      onto: rebase.onto,
      origHead: rebase.origHead,
      metadataEntries: rebase.entries,
    },
    refs: {
      detachedHead,
      planRef: branchRef,
      planHead,
      checkpointRef: expectedCheckpointRef,
      checkpoint,
      origHeadRef,
    },
    gitState: {
      statusSha256: sha256(gitBuffer(execution.root, ["status", "--porcelain=v2", "-z", "--untracked-files=all"])),
      indexStagesSha256: sha256(indexStages),
      conflicts,
      conflictsSha256: sha256(conflictBytes),
      worktreeDiffSha256: sha256(gitBuffer(execution.root, ["diff", "--binary", "--full-index", "--no-ext-diff", "--"])),
      cachedDiffSha256: sha256(gitBuffer(execution.root, ["diff", "--cached", "--binary", "--full-index", "--no-ext-diff", "--"])),
      untracked: fingerprintUntracked(execution.root),
    },
  }
  return {
    execution,
    bundle,
    bundlePath,
    relativePath,
    bundleSha256,
    state,
    rebaseStateSha256: sha256(JSON.stringify(state)),
  }
}

function inspectActiveRebase(options) {
  const evidence = activeRebaseEvidence(options, { includeStateHash: false })
  return {
    ok: true,
    command: "inspect-active-rebase",
    verificationMode: "active-rebase",
    scope: evidence.bundle.plan.id,
    branch: evidence.bundle.assignment.branch,
    workerMode: "GUIDED_REPAIR",
    generationBase: evidence.bundle.assignment.generationBase,
    bundlePath: evidence.bundlePath,
    relativePath: evidence.relativePath,
    bundleSha256: evidence.bundleSha256,
    snapshotSha256: evidence.bundle.snapshotSha256,
    detachedHead: evidence.state.refs.detachedHead,
    rebaseOnto: evidence.state.rebase.onto,
    rebaseOrigHead: evidence.state.rebase.origHead,
    planHead: evidence.state.refs.planHead,
    checkpointRef: evidence.state.refs.checkpointRef,
    checkpoint: evidence.state.refs.checkpoint,
    conflicts: evidence.state.gitState.conflicts,
    rebaseStateSha256: evidence.rebaseStateSha256,
  }
}

function verifyActiveRebase(options) {
  if (options.verificationMode !== "active-rebase") {
    throw new Error("active-rebase verification must be explicitly requested")
  }
  const expectedRebaseStateSha256 = requireOption(options, "expectedRebaseStateSha256")
  if (!isSha256(expectedRebaseStateSha256)) {
    throw new Error("--expected-rebase-state-sha256 must be a lowercase SHA-256")
  }
  const evidence = activeRebaseEvidence(options, { includeStateHash: true })
  if (evidence.rebaseStateSha256 !== expectedRebaseStateSha256) {
    throw new Error(`active rebase state mismatch: expected ${expectedRebaseStateSha256}, found ${evidence.rebaseStateSha256}`)
  }

  return {
    ok: true,
    command: "verify",
    verificationMode: "active-rebase",
    scope: evidence.bundle.plan.id,
    branch: evidence.bundle.assignment.branch,
    workerMode: "GUIDED_REPAIR",
    generationBase: evidence.bundle.assignment.generationBase,
    bundlePath: evidence.bundlePath,
    relativePath: evidence.relativePath,
    bundleSha256: evidence.bundleSha256,
    snapshotSha256: evidence.bundle.snapshotSha256,
    detachedHead: evidence.state.refs.detachedHead,
    rebaseStateSha256: evidence.rebaseStateSha256,
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
      : parsed.command === "inspect-active-rebase"
        ? inspectActiveRebase(parsed.options)
        : materialize(parsed.options, { run: parsed.command === "materialize-run" })
    print(result, parsed.options.pretty)
  } catch (error) {
    print({ ok: false, error: error.message }, parsed?.options?.pretty)
    process.exitCode = 1
  }
}

const invokedAsScript = process.argv[1] && fs.realpathSync(process.argv[1]) === fileURLToPath(import.meta.url)
if (invokedAsScript) main()

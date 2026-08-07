#!/usr/bin/env node

import { createHash } from "node:crypto"
import fs from "node:fs"
import path from "node:path"
import process from "node:process"
import { spawnSync } from "node:child_process"

const ROLE_NAMES = [
  "controller",
  "plan-implementer",
  "plan-reviewer",
  "plan-judge",
  "plan-saver",
]
const CHILD_ROLES = ROLE_NAMES.filter((role) => role !== "controller")
const EXPECTED_MUTABILITY = {
  controller: true,
  "plan-implementer": true,
  "plan-reviewer": false,
  "plan-judge": false,
  "plan-saver": true,
}
const HARNESS_BINARIES = {
  codex: "codex",
  "grok-build": "grok",
  pi: "pi",
}
const MAX_TASK_BYTES = 128 * 1024

class UsageError extends Error {}

function fail(message) {
  throw new Error(message)
}

function takeValue(argv, index, option) {
  const value = argv[index + 1]
  if (!value || value.startsWith("--")) throw new UsageError(`${option} requires a value`)
  return value
}

function parseArguments(argv) {
  const command = argv[0]
  if (!command || ["-h", "--help"].includes(command)) return { help: true }
  if (!["validate", "preflight", "launch-controller", "normalize-worktree", "launcher", "dispatch"].includes(command)) {
    throw new UsageError(`Unknown command: ${command}`)
  }
  const options = {
    command,
    profile: "",
    role: "",
    worktree: "",
    taskFile: "",
    attempt: "",
    controllerTerminal: "",
    controllerWorktree: "",
    expectedBranch: "",
    expectedHead: "",
    readyTimeoutMs: 60000,
    pretty: false,
  }
  for (let index = 1; index < argv.length; index += 1) {
    const argument = argv[index]
    if (argument === "--pretty") options.pretty = true
    else if (["--profile", "--role", "--worktree", "--task-file", "--attempt", "--controller-terminal", "--controller-worktree", "--expected-branch", "--expected-head", "--ready-timeout-ms"].includes(argument)) {
      const value = takeValue(argv, index, argument)
      index += 1
      if (argument === "--profile") options.profile = value
      else if (argument === "--role") options.role = value
      else if (argument === "--worktree") options.worktree = value
      else if (argument === "--task-file") options.taskFile = value
      else if (argument === "--attempt") options.attempt = value
      else if (argument === "--controller-terminal") options.controllerTerminal = value
      else if (argument === "--controller-worktree") options.controllerWorktree = value
      else if (argument === "--expected-branch") options.expectedBranch = value
      else if (argument === "--expected-head") options.expectedHead = value
      else {
        options.readyTimeoutMs = Number(value)
        if (!Number.isSafeInteger(options.readyTimeoutMs) || options.readyTimeoutMs < 1000 || options.readyTimeoutMs > 600000) {
          throw new UsageError("--ready-timeout-ms must be an integer from 1000 through 600000")
        }
      }
    } else throw new UsageError(`Unknown argument: ${argument}`)
  }
  if (!options.profile) throw new UsageError("--profile is required")
  if (["launcher", "dispatch"].includes(command) && !options.role) throw new UsageError("--role is required")
  if (command === "launch-controller" && (!options.controllerTerminal || !options.controllerWorktree)) {
    throw new UsageError("--controller-terminal and --controller-worktree are required")
  }
  if (command === "normalize-worktree") {
    for (const [name, value] of [
      ["--worktree", options.worktree],
      ["--expected-branch", options.expectedBranch],
      ["--expected-head", options.expectedHead],
    ]) {
      if (!value) throw new UsageError(`${name} is required`)
    }
  }
  if (command === "dispatch") {
    for (const [name, value] of [
      ["--worktree", options.worktree],
      ["--task-file", options.taskFile],
      ["--attempt", options.attempt],
      ["--controller-terminal", options.controllerTerminal],
    ]) {
      if (!value) throw new UsageError(`${name} is required`)
    }
  }
  return options
}

function usage() {
  return `Usage:
  orca-runtime.mjs validate --profile <file> [--pretty]
  orca-runtime.mjs preflight --profile <file> [--pretty]
  orca-runtime.mjs launch-controller --profile <file> --controller-terminal <handle> --controller-worktree <selector> [--pretty]
  orca-runtime.mjs normalize-worktree --profile <file> --worktree <selector> --expected-branch <branch> --expected-head <sha> [--pretty]
  orca-runtime.mjs launcher --profile <file> --role <role> [--pretty]
  orca-runtime.mjs dispatch --profile <file> --role <child-role> --worktree <selector> --task-file <file> --attempt <id> --controller-terminal <handle> [--ready-timeout-ms <ms>] [--pretty]
`
}

function isString(value) {
  return typeof value === "string" && value.trim().length > 0
}

function stringArray(value, label) {
  if (!Array.isArray(value) || value.length === 0 || value.some((item) => !isString(item))) {
    fail(`${label} must be a non-empty array of non-empty strings`)
  }
  return value.map(String)
}

function optionValue(command, names) {
  for (let index = 0; index < command.length; index += 1) {
    for (const name of names) {
      if (command[index] === name) return command[index + 1] ?? null
      if (command[index].startsWith(`${name}=`)) return command[index].slice(name.length + 1)
    }
  }
  return null
}

function unquote(value) {
  if (!isString(value)) return value
  if ((value.startsWith("\"") && value.endsWith("\""))
    || (value.startsWith("'") && value.endsWith("'"))) {
    return value.slice(1, -1)
  }
  return value
}

function containsCredentialArgument(args) {
  const credentialFlag = /^--?(?:api[-_]?key|access[-_]?token|auth[-_]?token|secret|password)(?:=|$)/i
  const credentialAssignment = /^(?:[A-Z0-9_]*(?:API_KEY|ACCESS_TOKEN|AUTH_TOKEN|SECRET|PASSWORD))=/i
  return args.some((argument) => credentialFlag.test(argument) || credentialAssignment.test(argument))
}

function validateRoleCommand(roleName, role, command) {
  const expectedProvider = {
    codex: "openai-codex",
    "grok-build": "xai",
  }[role.harness]
  if (expectedProvider && role.provider !== expectedProvider) {
    fail(`${roleName}.provider must be ${expectedProvider} for ${role.harness}`)
  }

  if (role.harness === "codex") {
    if (optionValue(command, ["--model", "-m"]) !== role.model) {
      fail(`${roleName}.command must select declared Codex model ${role.model}`)
    }
    const configs = command.flatMap((argument, index) => (
      ["-c", "--config"].includes(argument) && command[index + 1] ? [command[index + 1]] : []
    ))
    const configuredEffort = configs
      .map((entry) => entry.match(/^model_reasoning_effort=(.+)$/)?.[1])
      .filter(Boolean)
      .map(unquote)
    if (!configuredEffort.includes(role.effort)) {
      fail(`${roleName}.command must select declared Codex effort ${role.effort}`)
    }
    if (roleName === "controller" && !command.includes("--dangerously-bypass-approvals-and-sandbox")) {
      fail("controller.command must use Codex permissive mode so its Orca CLI children can reach the configured runtime")
    }
    if (role.mutates === false) {
      if (optionValue(command, ["--sandbox", "-s"]) !== "read-only"
        || optionValue(command, ["--ask-for-approval", "-a"]) !== "never"
        || command.includes("--dangerously-bypass-approvals-and-sandbox")) {
        fail(`${roleName}.command must enforce Codex read-only sandbox with approvals disabled`)
      }
    }
  } else if (role.harness === "grok-build") {
    if (optionValue(command, ["--model"]) !== role.model) {
      fail(`${roleName}.command must select declared Grok model ${role.model}`)
    }
    if (optionValue(command, ["--effort"]) !== role.effort) {
      fail(`${roleName}.command must select declared Grok effort ${role.effort}`)
    }
    if (role.mutates === false
      && (optionValue(command, ["--permission-mode"]) !== "plan" || command.includes("--always-approve"))) {
      fail(`${roleName}.command must enforce Grok plan permission mode`)
    }
  } else if (role.harness === "pi") {
    if (optionValue(command, ["--model", "-m"]) !== `${role.provider}/${role.model}`) {
      fail(`${roleName}.command must select declared Pi route ${role.provider}/${role.model}`)
    }
    if (optionValue(command, ["--thinking"]) !== role.effort) {
      fail(`${roleName}.command must select declared Pi effort ${role.effort}`)
    }
    if (role.mutates === false && optionValue(command, ["--tools"]) !== "read,bash,grep,find,ls") {
      fail(`${roleName}.command must enforce the exact read-only Pi tool allowlist`)
    }
    if (role.provider === "kimi-coding" && command.includes("--no-extensions")) {
      fail(`${roleName}.command must allow the installed Kimi provider extension`)
    }
  }
}

function stableJson(value) {
  if (Array.isArray(value)) return `[${value.map(stableJson).join(",")}]`
  if (value && typeof value === "object") {
    return `{${Object.keys(value).sort().map((key) => `${JSON.stringify(key)}:${stableJson(value[key])}`).join(",")}}`
  }
  return JSON.stringify(value)
}

function sha256(value) {
  return createHash("sha256").update(value).digest("hex")
}

function readProfile(file) {
  const profilePath = path.resolve(file)
  let parsed
  try {
    parsed = JSON.parse(fs.readFileSync(profilePath, "utf8"))
  } catch (error) {
    fail(`Cannot read Orca runtime profile ${profilePath}: ${error.message}`)
  }
  if (parsed.schemaVersion !== 1) fail(`Unsupported Orca runtime profile schema: ${JSON.stringify(parsed.schemaVersion)}`)
  if (parsed.runtime !== "orca") fail(`Orca runtime profile must declare runtime "orca"`)
  if (parsed.controllerInOrca !== true) fail("Orca runtime profile must require controllerInOrca")
  if (!isString(parsed.name)) fail("Orca runtime profile requires a name")
  if (!parsed.roles || typeof parsed.roles !== "object" || Array.isArray(parsed.roles)) fail("Orca runtime profile requires roles")

  const unknownRoles = Object.keys(parsed.roles).filter((role) => !ROLE_NAMES.includes(role))
  if (unknownRoles.length > 0) fail(`Unknown Orca runtime roles: ${unknownRoles.join(", ")}`)
  const roles = {}
  for (const roleName of ROLE_NAMES) {
    const role = parsed.roles[roleName]
    if (!role || typeof role !== "object" || Array.isArray(role)) fail(`Missing Orca runtime role: ${roleName}`)
    const unknownFields = Object.keys(role).filter((field) => !["harness", "provider", "model", "effort", "mutates", "command"].includes(field))
    if (unknownFields.length > 0) fail(`${roleName} contains unknown fields: ${unknownFields.join(", ")}`)
    if (!Object.hasOwn(HARNESS_BINARIES, role.harness)) fail(`Unsupported harness for ${roleName}: ${JSON.stringify(role.harness)}`)
    if (roleName === "controller" && role.harness !== "codex") fail("Orca controller harness must be codex")
    if (!isString(role.provider) || !isString(role.model) || !isString(role.effort)) {
      fail(`${roleName} requires provider, model, and effort`)
    }
    if (role.mutates !== EXPECTED_MUTABILITY[roleName]) {
      fail(`${roleName} mutates must be ${EXPECTED_MUTABILITY[roleName]}`)
    }
    const command = stringArray(role.command, `${roleName}.command`)
    if (command[0] !== HARNESS_BINARIES[role.harness]) {
      fail(`${roleName}.command must launch ${HARNESS_BINARIES[role.harness]}`)
    }
    if (containsCredentialArgument(command)) {
      fail(`${roleName}.command must not embed credentials`)
    }
    validateRoleCommand(roleName, role, command)
    roles[roleName] = {
      harness: role.harness,
      provider: role.provider,
      model: role.model,
      effort: role.effort,
      mutates: role.mutates,
      command,
    }
  }
  const normalized = {
    schemaVersion: 1,
    name: parsed.name,
    runtime: "orca",
    controllerInOrca: true,
    roles,
  }
  return {
    profilePath,
    profileHash: sha256(stableJson(normalized)),
    profile: normalized,
  }
}

function shellQuote(value) {
  if (/^[A-Za-z0-9_@%+=:,./-]+$/.test(value)) return value
  return `'${value.replaceAll("'", `'\"'\"'`)}'`
}

function launcher(role) {
  return role.command.map(shellQuote).join(" ")
}

function executablePath(command) {
  if (command.includes(path.sep)) {
    const candidate = path.resolve(command)
    try {
      fs.accessSync(candidate, fs.constants.X_OK)
      return candidate
    } catch {
      return null
    }
  }
  const extensions = process.platform === "win32"
    ? String(process.env.PATHEXT || ".EXE;.CMD;.BAT").split(";")
    : [""]
  for (const directory of String(process.env.PATH || "").split(path.delimiter)) {
    if (!directory) continue
    for (const extension of extensions) {
      const candidate = path.join(directory, `${command}${extension}`)
      try {
        fs.accessSync(candidate, fs.constants.X_OK)
        return candidate
      } catch {
        // Continue searching PATH.
      }
    }
  }
  return null
}

function parseJsonOutput(result, label) {
  try {
    return JSON.parse(result.stdout)
  } catch (error) {
    fail(`${label} returned invalid JSON: ${error.message}`)
  }
}

function run(command, args, { label = command, timeout = 600000, allowFailure = false } = {}) {
  const result = spawnSync(command, args, {
    encoding: "utf8",
    timeout,
    maxBuffer: 16 * 1024 * 1024,
  })
  if (result.error) fail(`${label} failed to start: ${result.error.message}`)
  if (result.status !== 0 && !allowFailure) {
    const fingerprint = sha256(`${result.stdout}\0${result.stderr}`)
    fail(`${label} failed with exit ${result.status}; output_sha256=${fingerprint}`)
  }
  return result
}

function orcaBinary() {
  return process.env.HERDER_ORCA_BIN || "orca"
}

function runOrca(args, label) {
  const binary = orcaBinary()
  if (!executablePath(binary)) fail(`Orca CLI not found: ${binary}`)
  return parseJsonOutput(run(binary, [...args, "--json"], { label: label || `orca ${args.join(" ")}` }), label || "Orca")
}

function nestedResult(value) {
  return value && typeof value === "object" && value.result && typeof value.result === "object"
    ? value.result
    : value
}

function waitForWorkerReady(terminalHandle, readyTimeoutMs) {
  const binary = orcaBinary()
  if (!executablePath(binary)) fail(`Orca CLI not found: ${binary}`)
  const waitResult = run(binary, [
    "terminal", "wait",
    "--terminal", terminalHandle,
    "--for", "tui-idle",
    "--timeout-ms", String(readyTimeoutMs),
    "--json",
  ], {
    label: "orca terminal wait",
    timeout: readyTimeoutMs + 30000,
    allowFailure: true,
  })
  const waitEvidenceSha256 = sha256(`${waitResult.stdout}\0${waitResult.stderr}`)
  if (waitResult.status === 0) {
    parseJsonOutput(waitResult, "orca terminal wait")
    return {
      mode: "tui-idle",
      evidenceSha256: waitEvidenceSha256,
    }
  }
  fail(`orca terminal wait failed with exit ${waitResult.status}; output_sha256=${waitEvidenceSha256}`)
}

function findStringByKeys(value, keys) {
  if (!value || typeof value !== "object") return null
  for (const key of keys) {
    if (isString(value[key])) return value[key]
  }
  for (const child of Object.values(value)) {
    if (!child || typeof child !== "object") continue
    const found = findStringByKeys(child, keys)
    if (found) return found
  }
  return null
}

function controllerLauncherHash(loaded) {
  return sha256(launcher(loaded.profile.roles.controller))
}

function verifyControllerAttestation(loaded) {
  if (process.env.HERDER_ORCA_PROFILE_SHA256 !== loaded.profileHash
    || process.env.HERDER_ORCA_CONTROLLER_LAUNCHER_SHA256 !== controllerLauncherHash(loaded)) {
    fail("Controller routing is unattested; launch it with the profile's launch-controller command")
  }
}

function verifyControllerContext(explicitTerminal = null, explicitWorktree = null) {
  const status = nestedResult(runOrca(["status"], "orca status"))
  if (status?.runtime?.reachable !== true) fail("Orca runtime is not reachable")
  const worktreeSelector = explicitWorktree || process.env.HERDER_ORCA_CONTROLLER_WORKTREE
  const worktree = nestedResult(worktreeSelector
    ? runOrca(["worktree", "show", "--worktree", worktreeSelector], "orca worktree show")
    : runOrca(["worktree", "current"], "orca worktree current"))
  const terminalSelector = explicitTerminal || process.env.HERDER_ORCA_CONTROLLER_TERMINAL
  if (!terminalSelector) fail("Controller terminal handle is unavailable")
  const terminal = nestedResult(runOrca(
    ["terminal", "show", "--terminal", terminalSelector],
    "orca terminal show",
  ))
  const controllerTerminal = findStringByKeys(terminal, ["handle", "terminalHandle", "terminal_handle"])
  const worktreeId = findStringByKeys(worktree, ["worktreeId", "worktree_id", "id"])
  const worktreePath = findStringByKeys(worktree, ["path", "worktreePath", "worktree_path"])
  if (!controllerTerminal) fail("Current controller is not running in a detectable Orca terminal")
  if (!worktreeId || !worktreePath) fail("Current controller is not inside a detectable Orca worktree")
  return { controllerTerminal, worktreeId, worktreePath }
}

function launchController(loaded, options) {
  verifyControllerContext(options.controllerTerminal, options.controllerWorktree)
  const role = loaded.profile.roles.controller
  const launcherSha256 = controllerLauncherHash(loaded)
  const result = spawnSync(role.command[0], role.command.slice(1), {
    stdio: "inherit",
    env: {
      ...process.env,
      HERDER_ORCA_PROFILE_SHA256: loaded.profileHash,
      HERDER_ORCA_CONTROLLER_LAUNCHER_SHA256: launcherSha256,
      HERDER_ORCA_CONTROLLER_TERMINAL: options.controllerTerminal,
      HERDER_ORCA_CONTROLLER_WORKTREE: options.controllerWorktree,
    },
  })
  if (result.error) fail(`Controller failed to start: ${result.error.message}`)
  if (result.status !== 0) fail(`Controller exited with status ${result.status}`)
  return {
    ok: true,
    runtime: "orca",
    profile: loaded.profile.name,
    profileHash: loaded.profileHash,
    role: "controller",
    harness: role.harness,
    provider: role.provider,
    model: role.model,
    effort: role.effort,
    launcherSha256,
    exitCode: result.status,
  }
}

function normalizeBranch(value) {
  return String(value || "").replace(/^refs\/heads\//, "")
}

function orcaBranchAlias(branch) {
  return branch.replaceAll("/", "-")
}

function git(worktreePath, args, options = {}) {
  return run("git", ["-C", worktreePath, ...args], {
    label: `git ${args.join(" ")}`,
    ...options,
  })
}

function normalizeWorktree(loaded, options) {
  verifyControllerAttestation(loaded)
  if (!/^herder\/[a-z0-9][a-z0-9._-]*\/(?:integration|\d{3,})$/.test(options.expectedBranch)) {
    fail("--expected-branch must be an exact Herder integration or indexed plan branch")
  }
  if (!/^[a-f0-9]{40,64}$/.test(options.expectedHead)) {
    fail("--expected-head must be a full hexadecimal object ID")
  }
  git(process.cwd(), ["check-ref-format", "--branch", options.expectedBranch])

  const before = nestedResult(runOrca([
    "worktree", "show",
    "--worktree", options.worktree,
  ], "orca worktree show"))
  const worktreeId = findStringByKeys(before, ["worktreeId", "worktree_id", "id"])
  const worktreePath = findStringByKeys(before, ["path", "worktreePath", "worktree_path"])
  const reportedBefore = normalizeBranch(findStringByKeys(before, ["branch", "branchName", "branch_name"]))
  if (!worktreeId || !worktreePath || !fs.existsSync(worktreePath)) {
    fail("Orca did not return a stable, existing worktree identity")
  }
  const canonicalPath = fs.realpathSync(worktreePath)
  const gitRoot = fs.realpathSync(git(canonicalPath, ["rev-parse", "--show-toplevel"]).stdout.trim())
  if (gitRoot !== canonicalPath) fail("Orca worktree path is not its Git top level")

  const headBefore = git(canonicalPath, ["rev-parse", "HEAD"]).stdout.trim()
  if (headBefore !== options.expectedHead) {
    fail(`Orca worktree HEAD mismatch: expected ${options.expectedHead}, found ${headBefore}`)
  }
  if (git(canonicalPath, ["status", "--porcelain=v1", "--untracked-files=all"]).stdout !== "") {
    fail("Orca worktree must be clean before branch normalization")
  }

  const currentBranch = normalizeBranch(git(canonicalPath, ["symbolic-ref", "HEAD"]).stdout.trim())
  const alias = orcaBranchAlias(options.expectedBranch)
  if (![options.expectedBranch, alias].includes(currentBranch)) {
    fail(`Unexpected Orca branch rewrite: expected ${options.expectedBranch} or ${alias}, found ${currentBranch}`)
  }
  if (reportedBefore && reportedBefore !== currentBranch) {
    fail(`Orca/Git branch disagreement before normalization: Orca reported ${reportedBefore}, Git reported ${currentBranch}`)
  }

  let renamed = false
  if (currentBranch !== options.expectedBranch) {
    const targetRef = git(canonicalPath, [
      "show-ref", "--verify", "--quiet", `refs/heads/${options.expectedBranch}`,
    ], { allowFailure: true })
    if (targetRef.status === 0) fail(`Target Herder branch already exists: ${options.expectedBranch}`)
    if (![1, 128].includes(targetRef.status)) fail("Cannot prove target Herder branch is absent")
    git(canonicalPath, ["branch", "--move", options.expectedBranch])
    renamed = true
  }

  const branchAfter = normalizeBranch(git(canonicalPath, ["symbolic-ref", "HEAD"]).stdout.trim())
  const headAfter = git(canonicalPath, ["rev-parse", "HEAD"]).stdout.trim()
  if (branchAfter !== options.expectedBranch || headAfter !== options.expectedHead) {
    fail("Git branch normalization did not preserve the expected branch and HEAD")
  }
  if (git(canonicalPath, ["status", "--porcelain=v1", "--untracked-files=all"]).stdout !== "") {
    fail("Git branch normalization changed worktree contents")
  }
  if (renamed) {
    const aliasRef = git(canonicalPath, [
      "show-ref", "--verify", "--quiet", `refs/heads/${alias}`,
    ], { allowFailure: true })
    if (aliasRef.status === 0) fail(`Sanitized Orca alias still exists after normalization: ${alias}`)
  }

  const after = nestedResult(runOrca([
    "worktree", "show",
    "--worktree", options.worktree,
  ], "orca worktree show after normalization"))
  const pathAfter = findStringByKeys(after, ["path", "worktreePath", "worktree_path"])
  const idAfter = findStringByKeys(after, ["worktreeId", "worktree_id", "id"])
  if (!pathAfter || fs.realpathSync(pathAfter) !== canonicalPath || idAfter !== worktreeId) {
    fail("Orca ownership changed during branch normalization")
  }

  return {
    ok: true,
    runtime: "orca",
    profile: loaded.profile.name,
    profileHash: loaded.profileHash,
    worktreeId,
    worktreePath: canonicalPath,
    expectedBranch: options.expectedBranch,
    expectedHead: options.expectedHead,
    sanitizedAlias: alias,
    renamed,
    gitBranch: branchAfter,
    orcaReportedBranchBefore: reportedBefore || null,
    orcaReportedBranchAfter: normalizeBranch(findStringByKeys(after, ["branch", "branchName", "branch_name"])) || null,
  }
}

function preflight(loaded, options) {
  const executables = {}
  for (const roleName of ROLE_NAMES) {
    const binary = loaded.profile.roles[roleName].command[0]
    const resolved = executablePath(binary)
    if (!resolved) fail(`Required ${roleName} harness is unavailable: ${binary}`)
    executables[roleName] = resolved
  }
  const {
    controllerTerminal,
    worktreeId,
    worktreePath,
  } = verifyControllerContext()
  verifyControllerAttestation(loaded)
  const orchestration = nestedResult(runOrca(
    ["orchestration", "task-list", "--brief"],
    "orca orchestration task-list",
  ))
  if (!Array.isArray(orchestration?.tasks)) {
    fail("Orca experimental orchestration is unavailable or returned an unsupported response")
  }

  return {
    ok: true,
    runtime: "orca",
    profile: loaded.profile.name,
    profilePath: loaded.profilePath,
    profileHash: loaded.profileHash,
    controllerTerminal,
    worktreeId,
    worktreePath,
    orchestration: {
      status: "available",
      existingTaskCount: Number.isSafeInteger(orchestration.count)
        ? orchestration.count
        : orchestration.tasks.length,
    },
    executables,
  }
}

function dispatch(loaded, options) {
  verifyControllerAttestation(loaded)
  if (!CHILD_ROLES.includes(options.role)) throw new UsageError(`dispatch role must be one of: ${CHILD_ROLES.join(", ")}`)
  const role = loaded.profile.roles[options.role]
  const taskPath = path.resolve(options.taskFile)
  const taskText = fs.readFileSync(taskPath, "utf8")
  if (!taskText.trim()) fail("Task envelope is empty")
  if (Buffer.byteLength(taskText) > MAX_TASK_BYTES) fail("Task envelope exceeds 128 KiB")
  if (taskText.includes("\0")) fail("Task envelope contains a NUL byte")

  let terminalHandle = null
  let taskId = null
  let dispatchId = null
  let deliverySha256 = null
  let readiness = null
  try {
    const terminalResponse = nestedResult(runOrca([
      "terminal", "create",
      "--worktree", options.worktree,
      "--title", options.attempt,
      "--command", launcher(role),
    ], "orca terminal create"))
    terminalHandle = findStringByKeys(terminalResponse, ["agentTerminalHandle", "terminalHandle", "terminal_handle", "handle"])
    if (!terminalHandle) fail("Orca did not return a worker terminal handle")

    readiness = waitForWorkerReady(terminalHandle, options.readyTimeoutMs)

    const taskResponse = nestedResult(runOrca([
      "orchestration", "task-create",
      "--spec", taskText,
      "--task-title", options.attempt,
      "--display-name", options.attempt,
    ], "orca orchestration task-create"))
    taskId = findStringByKeys(taskResponse, ["taskId", "task_id", "id"])
    if (!taskId) fail("Orca did not return an orchestration task ID")

    const dispatchResponse = nestedResult(runOrca([
      "orchestration", "dispatch",
      "--task", taskId,
      "--to", terminalHandle,
      "--from", options.controllerTerminal,
    ], "orca orchestration dispatch"))
    dispatchId = findStringByKeys(dispatchResponse, ["dispatchId", "dispatch_id", "id"])
    if (!dispatchId) fail("Orca did not return a dispatch ID")

    const lifecyclePayload = JSON.stringify({
      taskId,
      dispatchId,
      filesModified: [],
    })
    const deliveryText = `# Orca supervised dispatch

You own one tracked task from coordinator terminal ${options.controllerTerminal}.

- Task ID: ${taskId}
- Dispatch ID: ${dispatchId}
- Attempt: ${options.attempt}
- Role: ${options.role}

Execute the complete task below. When it is terminal, send exactly one \`worker_done\` message from this same terminal to ${options.controllerTerminal}. Use the active task and dispatch IDs above, replace the body with a concise three-sentence summary, and replace \`filesModified\` with the actual repository-relative paths:

\`\`\`text
orca orchestration send --to ${shellQuote(options.controllerTerminal)} --type worker_done --subject ${shellQuote(`${options.attempt} complete`)} --body ${shellQuote("<three-sentence summary>")} --payload ${shellQuote(lifecyclePayload)} --json
\`\`\`

After sending \`worker_done\`, end your turn and idle. Do not poll the coordinator.

# Task

${taskText}`
    runOrca([
      "terminal", "send",
      "--terminal", terminalHandle,
      "--text", deliveryText,
      "--enter",
    ], "orca terminal send tracked task")
    deliverySha256 = sha256(deliveryText)
  } catch (error) {
    fail(
      `Orca dispatch incomplete; role=${options.role}; attempt=${options.attempt}; `
      + `terminalHandle=${terminalHandle ?? "none"}; taskId=${taskId ?? "none"}; dispatchId=${dispatchId ?? "none"}; `
      + `cause=${error.message}`,
    )
  }

  return {
    ok: true,
    runtime: "orca",
    profile: loaded.profile.name,
    profileHash: loaded.profileHash,
    role: options.role,
    harness: role.harness,
    provider: role.provider,
    model: role.model,
    effort: role.effort,
    mutates: role.mutates,
    attempt: options.attempt,
    worktree: options.worktree,
    controllerTerminal: options.controllerTerminal,
    terminalHandle,
    readiness: readiness.mode,
    readinessEvidenceSha256: readiness.evidenceSha256,
    taskId,
    dispatchId,
    taskSha256: sha256(taskText),
    launcherSha256: sha256(launcher(role)),
    delivery: "tracked-terminal-send",
    deliverySha256,
  }
}

function main(argv) {
  const options = parseArguments(argv)
  if (options.help) {
    process.stdout.write(usage())
    return
  }
  const loaded = readProfile(options.profile)
  let result
  if (options.command === "validate") {
    result = {
      ok: true,
      profile: loaded.profile,
      profilePath: loaded.profilePath,
      profileHash: loaded.profileHash,
    }
  } else if (options.command === "preflight") result = preflight(loaded, options)
  else if (options.command === "launch-controller") result = launchController(loaded, options)
  else if (options.command === "normalize-worktree") result = normalizeWorktree(loaded, options)
  else if (options.command === "launcher") {
    if (!ROLE_NAMES.includes(options.role)) throw new UsageError(`Unknown role: ${options.role}`)
    const role = loaded.profile.roles[options.role]
    result = {
      ok: true,
      profile: loaded.profile.name,
      profileHash: loaded.profileHash,
      role: options.role,
      harness: role.harness,
      provider: role.provider,
      model: role.model,
      effort: role.effort,
      mutates: role.mutates,
      command: role.command,
      launcher: launcher(role),
      launcherSha256: sha256(launcher(role)),
    }
  } else result = dispatch(loaded, options)
  process.stdout.write(`${JSON.stringify(result, null, options.pretty ? 2 : 0)}\n`)
}

try {
  main(process.argv.slice(2))
} catch (error) {
  const prefix = error instanceof UsageError ? "herder-orca-runtime usage" : "herder-orca-runtime"
  process.stderr.write(`${prefix}: ${error.message}\n`)
  if (error instanceof UsageError) process.stderr.write(usage())
  process.exitCode = 1
}

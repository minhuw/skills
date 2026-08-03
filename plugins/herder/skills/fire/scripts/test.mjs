#!/usr/bin/env node

import assert from "node:assert/strict"
import { execFileSync, spawnSync } from "node:child_process"
import { chmod, mkdtemp, mkdir, readFile, rm, stat, symlink, writeFile } from "node:fs/promises"
import { tmpdir } from "node:os"
import path from "node:path"
import process from "node:process"
import { fileURLToPath } from "node:url"

const scriptDir = path.dirname(fileURLToPath(import.meta.url))
const reader = path.join(scriptDir, "read-codex-agent-evidence.mjs")
const gateRunner = path.join(scriptDir, "run-gate.mjs")
const roundPolicy = path.join(scriptDir, "round-policy.mjs")
const orcaRuntime = path.join(scriptDir, "orca-runtime.mjs")
const orcaProfile = path.join(scriptDir, "..", "references", "orca-heterogeneous-profile.json")
const root = await mkdtemp(path.join(tmpdir(), "herder-agent-evidence-test-"))
const sessions = path.join(root, "sessions", "2026", "07", "15")
const archivedSessions = path.join(root, "archived_sessions")
const candidateReal = path.join(root, "candidate-real")
const agentId = "019f0000-0000-7000-8000-000000000001"
const interruptedAgentId = "019f0000-0000-7000-8000-000000000002"
const priorAgentId = "019f0000-0000-7000-8000-000000000003"

try {
  await mkdir(sessions, { recursive: true })
  await mkdir(archivedSessions, { recursive: true })
  await mkdir(candidateReal)
  const events = [
    {
      type: "session_meta",
      payload: {
        id: agentId,
        parent_thread_id: "parent",
        thread_source: "subagent",
        history_mode: "legacy",
        source: { subagent: { thread_spawn: { agent_path: "/root/run-001", agent_nickname: "Pip", agent_role: "plan_implementer" } } },
      },
    },
    {
      type: "turn_context",
      payload: {
        cwd: candidateReal,
        model: "gpt-5.6-luna",
        effort: "max",
        multi_agent_version: "v2",
        approval_policy: "never",
        sandbox_policy: { type: "workspace-write" },
      },
    },
    { type: "event_msg", payload: { type: "user_message", message: "self-contained plan" } },
    {
      type: "event_msg",
      payload: {
        type: "token_count",
        info: { total_token_usage: { input_tokens: 101, cached_input_tokens: 20, output_tokens: 31, reasoning_output_tokens: 11 } },
      },
    },
    { timestamp: "2026-07-15T12:00:00Z", type: "event_msg", payload: { type: "task_complete", last_agent_message: "STATUS: COMPLETE" } },
  ]
  await writeFile(path.join(sessions, "rollout.jsonl"), `${events.map(JSON.stringify).join("\n")}\n`)

  const priorEvents = [
    {
      type: "session_meta",
      payload: {
        id: priorAgentId,
        parent_thread_id: "prior-parent",
        thread_source: "subagent",
        source: { subagent: { thread_spawn: { agent_path: "/root/prior-001", agent_role: "plan_saver" } } },
      },
    },
    { type: "turn_context", payload: { cwd: path.join(candidateReal, "nested"), model: "gpt-5.6-sol", effort: "xhigh" } },
    { timestamp: "2026-07-14T12:00:00Z", type: "event_msg", payload: { type: "task_complete" } },
  ]
  await writeFile(path.join(archivedSessions, "rollout-prior.jsonl"), `${priorEvents.map(JSON.stringify).join("\n")}\n`)

  const interruptedEvents = [
    {
      type: "session_meta",
      payload: {
        id: interruptedAgentId,
        parent_thread_id: "parent",
        thread_source: "subagent",
        source: { subagent: { thread_spawn: { agent_path: "/root/run-002", agent_nickname: "Violet", agent_role: "plan_saver" } } },
      },
    },
    {
      type: "turn_context",
      payload: {
        cwd: "/tmp/rescue",
        model: "gpt-5.6-sol",
        effort: "xhigh",
        multi_agent_version: "v2",
      },
    },
    {
      type: "event_msg",
      payload: {
        type: "token_count",
        info: { total_token_usage: { input_tokens: 55, cached_input_tokens: 34, output_tokens: 8, reasoning_output_tokens: 3 } },
      },
    },
    { type: "event_msg", payload: { type: "task_complete" } },
  ]
  await writeFile(path.join(sessions, "rollout-interrupted.jsonl"), `${interruptedEvents.map(JSON.stringify).join("\n")}\n`)

  const evidence = JSON.parse(execFileSync(process.execPath, [reader, "--agent-id", agentId, "--codex-home", root], { encoding: "utf8" }))
  assert.equal(evidence.ok, true)
  assert.equal(evidence.agentRole, "plan_implementer")
  assert.equal(evidence.model, "gpt-5.6-luna")
  assert.equal(evidence.effort, "max")
  assert.equal(evidence.multiAgentVersion, "v2")
  assert.equal(evidence.sandbox, "workspace-write")
  assert.equal(evidence.userMessageCount, 1)
  assert.equal(evidence.taskMessageCount, 0)
  assert.deepEqual(evidence.terminal, {
    taskComplete: true,
    turnAborted: false,
    finalEnvelopePresent: true,
  })
  assert.deepEqual(evidence.usage, {
    inputTokens: 101,
    cachedInputTokens: 20,
    outputTokens: 31,
    reasoningTokens: 11,
    source: "codex-multi-agent-v2-transcript",
  })

  const byTask = JSON.parse(execFileSync(process.execPath, [reader, "--agent", "/root/run-001", "--codex-home", root], { encoding: "utf8" }))
  assert.equal(byTask.agentId, agentId)

  const archived = JSON.parse(execFileSync(process.execPath, [reader, "--agent-id", priorAgentId, "--codex-home", root], { encoding: "utf8" }))
  assert.equal(archived.agentRole, "plan_saver")
  assert.equal(archived.transcript, path.join(archivedSessions, "rollout-prior.jsonl"))

  const interrupted = JSON.parse(execFileSync(process.execPath, [reader, "--agent-id", interruptedAgentId, "--codex-home", root], { encoding: "utf8" }))
  assert.equal(interrupted.agentRole, "plan_saver")
  assert.deepEqual(interrupted.terminal, {
    taskComplete: true,
    turnAborted: false,
    finalEnvelopePresent: false,
  })
  assert.deepEqual(interrupted.usage, {
    inputTokens: 55,
    cachedInputTokens: 34,
    outputTokens: 8,
    reasoningTokens: 3,
    source: "codex-multi-agent-v2-transcript",
  })

  const missing = spawnSync(process.execPath, [reader, "--agent", "missing", "--codex-home", root], { encoding: "utf8" })
  assert.equal(missing.status, 1)
  assert.equal(JSON.parse(missing.stdout).ok, false)

  const validatedOrcaProfile = JSON.parse(execFileSync(process.execPath, [
    orcaRuntime,
    "validate",
    "--profile", orcaProfile,
  ], { encoding: "utf8" }))
  assert.equal(validatedOrcaProfile.ok, true)
  assert.equal(validatedOrcaProfile.profile.name, "codex-grok-pi")
  assert.match(validatedOrcaProfile.profileHash, /^[a-f0-9]{64}$/)
  assert.deepEqual(
    Object.fromEntries(Object.entries(validatedOrcaProfile.profile.roles).map(([name, role]) => [name, `${role.harness}/${role.provider}/${role.model}`])),
    {
      controller: "codex/openai-codex/gpt-5.6-sol",
      "plan-implementer": "grok-build/xai/grok-4.5",
      "plan-reviewer": "pi/kimi-coding/k3",
      "plan-judge": "pi/openai/gpt-5.6-sol",
      "plan-saver": "grok-build/xai/grok-4.5",
    },
  )
  assert.equal(validatedOrcaProfile.profile.roles["plan-reviewer"].mutates, false)
  assert.equal(validatedOrcaProfile.profile.roles["plan-judge"].mutates, false)
  assert.equal(validatedOrcaProfile.profile.roles["plan-saver"].harness, "grok-build")
  assert.equal(
    validatedOrcaProfile.profile.roles.controller.command.includes("--dangerously-bypass-approvals-and-sandbox"),
    true,
  )
  const sourceOrcaProfile = JSON.parse(await readFile(orcaProfile, "utf8"))
  const unsupportedAmpProfile = structuredClone(sourceOrcaProfile)
  unsupportedAmpProfile.roles["plan-saver"].harness = "amp"
  const unsupportedAmpProfilePath = path.join(root, "orca-unsupported-amp-profile.json")
  await writeFile(unsupportedAmpProfilePath, JSON.stringify(unsupportedAmpProfile))
  const unsupportedAmpValidation = spawnSync(process.execPath, [
    orcaRuntime,
    "validate",
    "--profile", unsupportedAmpProfilePath,
  ], { encoding: "utf8" })
  assert.notEqual(unsupportedAmpValidation.status, 0)
  assert.match(unsupportedAmpValidation.stderr, /Unsupported harness for plan-saver: "amp"/)

  const controllerLauncher = JSON.parse(execFileSync(process.execPath, [
    orcaRuntime,
    "launcher",
    "--profile", orcaProfile,
    "--role", "controller",
  ], { encoding: "utf8" }))
  assert.match(controllerLauncher.launcherSha256, /^[a-f0-9]{64}$/)

  const mismatchedProfile = structuredClone(sourceOrcaProfile)
  const reviewerModelIndex = mismatchedProfile.roles["plan-reviewer"].command.indexOf("kimi-coding/k3")
  mismatchedProfile.roles["plan-reviewer"].command[reviewerModelIndex] = "openai/gpt-5.6-sol"
  const mismatchedProfilePath = path.join(root, "orca-mismatched-profile.json")
  await writeFile(mismatchedProfilePath, JSON.stringify(mismatchedProfile))
  const mismatchedValidation = spawnSync(process.execPath, [
    orcaRuntime,
    "validate",
    "--profile", mismatchedProfilePath,
  ], { encoding: "utf8" })
  assert.notEqual(mismatchedValidation.status, 0)
  assert.match(mismatchedValidation.stderr, /must select declared Pi route/)

  const disabledKimiProviderProfile = structuredClone(sourceOrcaProfile)
  disabledKimiProviderProfile.roles["plan-reviewer"].command.push("--no-extensions")
  const disabledKimiProviderProfilePath = path.join(root, "orca-disabled-kimi-provider-profile.json")
  await writeFile(disabledKimiProviderProfilePath, JSON.stringify(disabledKimiProviderProfile))
  const disabledKimiProviderValidation = spawnSync(process.execPath, [
    orcaRuntime,
    "validate",
    "--profile", disabledKimiProviderProfilePath,
  ], { encoding: "utf8" })
  assert.notEqual(disabledKimiProviderValidation.status, 0)
  assert.match(disabledKimiProviderValidation.stderr, /must allow the installed Kimi provider extension/)

  const sandboxedControllerProfile = structuredClone(sourceOrcaProfile)
  sandboxedControllerProfile.roles.controller.command = sandboxedControllerProfile.roles.controller.command
    .filter((argument) => argument !== "--dangerously-bypass-approvals-and-sandbox")
  const sandboxedControllerProfilePath = path.join(root, "orca-sandboxed-controller-profile.json")
  await writeFile(sandboxedControllerProfilePath, JSON.stringify(sandboxedControllerProfile))
  const sandboxedControllerValidation = spawnSync(process.execPath, [
    orcaRuntime,
    "validate",
    "--profile", sandboxedControllerProfilePath,
  ], { encoding: "utf8" })
  assert.notEqual(sandboxedControllerValidation.status, 0)
  assert.match(sandboxedControllerValidation.stderr, /controller\.command must use Codex permissive mode/)

  const credentialProfile = structuredClone(sourceOrcaProfile)
  credentialProfile.roles["plan-saver"].probe = ["grok", "models", "--api-key", "do-not-print"]
  const credentialProfilePath = path.join(root, "orca-credential-profile.json")
  await writeFile(credentialProfilePath, JSON.stringify(credentialProfile))
  const credentialValidation = spawnSync(process.execPath, [
    orcaRuntime,
    "validate",
    "--profile", credentialProfilePath,
  ], { encoding: "utf8" })
  assert.notEqual(credentialValidation.status, 0)
  assert.match(credentialValidation.stderr, /probe must not embed credentials/)
  assert.doesNotMatch(credentialValidation.stdout, /do-not-print/)

  const fakeBin = path.join(root, "fake-bin")
  const fakeOrca = path.join(fakeBin, "orca")
  const fakeAgent = path.join(fakeBin, "fake-agent")
  const fakeOrcaLog = path.join(root, "fake-orca.log")
  await mkdir(fakeBin)
  await writeFile(fakeOrca, `#!/usr/bin/env node
const fs = require("node:fs")
const args = process.argv.slice(2).filter((arg) => arg !== "--json")
fs.appendFileSync(process.env.FAKE_ORCA_LOG, JSON.stringify(args) + "\\n")
if (process.env.FAKE_ORCA_FAIL === args.slice(0, 2).join(" ")) {
  process.stderr.write("forced fake Orca failure\\n")
  process.exit(7)
}
let result
if (args[0] === "status") result = { app: { running: true }, runtime: { reachable: true } }
else if (args[0] === "worktree" && args[1] === "current") result = { id: "repo::controller", path: "/tmp/orca-controller", branch: "test/controller" }
else if (args[0] === "worktree" && args[1] === "show") result = {
  id: process.env.FAKE_ORCA_WORKTREE_ID || "repo::controller",
  path: process.env.FAKE_ORCA_WORKTREE_PATH || "/tmp/orca-controller",
  branch: process.env.FAKE_ORCA_WORKTREE_BRANCH || "test/controller",
}
else if (args[0] === "terminal" && args[1] === "show") result = { handle: args[3] || "terminal:controller" }
else if (args[0] === "orchestration" && args[1] === "task-list") result = { count: 0, tasks: [] }
else if (args[0] === "terminal" && args[1] === "create") result = { terminalHandle: "terminal:worker" }
else if (args[0] === "terminal" && args[1] === "wait") result = { ready: true }
else if (args[0] === "terminal" && args[1] === "send") result = { accepted: true }
else if (args[0] === "orchestration" && args[1] === "task-create") result = { taskId: "task:001" }
else if (args[0] === "orchestration" && args[1] === "dispatch") result = { dispatchId: "dispatch:001" }
else { process.stderr.write("unexpected fake Orca command: " + args.join(" ") + "\\n"); process.exit(2) }
process.stdout.write(JSON.stringify({ ok: true, result }) + "\\n")
`)
  await writeFile(fakeAgent, `#!/usr/bin/env node
const fs = require("node:fs")
if (process.argv[1].endsWith("/codex") && process.env.FAKE_CONTROLLER_ENV_LOG) {
  fs.writeFileSync(process.env.FAKE_CONTROLLER_ENV_LOG, JSON.stringify({
    profileHash: process.env.HERDER_ORCA_PROFILE_SHA256,
    launcherHash: process.env.HERDER_ORCA_CONTROLLER_LAUNCHER_SHA256,
    terminal: process.env.HERDER_ORCA_CONTROLLER_TERMINAL,
    worktree: process.env.HERDER_ORCA_CONTROLLER_WORKTREE,
  }))
}
process.stdout.write("grok-4.5 kimi-coding/k3 openai/gpt-5.6-sol authenticated\\n")
`)
  await chmod(fakeOrca, 0o755)
  await chmod(fakeAgent, 0o755)
  for (const name of ["codex", "grok", "pi"]) await symlink(fakeAgent, path.join(fakeBin, name))
  const fakeRuntimeEnv = {
    ...process.env,
    PATH: `${fakeBin}${path.delimiter}${process.env.PATH || ""}`,
    HERDER_ORCA_BIN: fakeOrca,
    FAKE_ORCA_LOG: fakeOrcaLog,
    HERDER_ORCA_PROFILE_SHA256: validatedOrcaProfile.profileHash,
    HERDER_ORCA_CONTROLLER_LAUNCHER_SHA256: controllerLauncher.launcherSha256,
    HERDER_ORCA_CONTROLLER_TERMINAL: "terminal:controller",
    HERDER_ORCA_CONTROLLER_WORKTREE: "id:repo::controller",
  }
  const normalizeRepo = path.join(root, "normalize-repo")
  const normalizeWorktreePath = path.join(root, "normalize-worktree")
  await mkdir(normalizeRepo)
  execFileSync("git", ["init", "-q", normalizeRepo])
  await writeFile(path.join(normalizeRepo, "fixture.txt"), "fixture\n")
  execFileSync("git", ["-C", normalizeRepo, "add", "fixture.txt"])
  execFileSync("git", [
    "-C", normalizeRepo,
    "-c", "user.name=Herder Test",
    "-c", "user.email=herder@example.invalid",
    "commit", "-q", "-m", "test: initialize fixture",
  ])
  const normalizeHead = execFileSync("git", ["-C", normalizeRepo, "rev-parse", "HEAD"], { encoding: "utf8" }).trim()
  execFileSync("git", ["-C", normalizeRepo, "branch", "herder-orca-matrix-integration"])
  execFileSync("git", [
    "-C", normalizeRepo,
    "worktree", "add", "-q", normalizeWorktreePath, "herder-orca-matrix-integration",
  ])
  const normalizedWorktree = spawnSync(process.execPath, [
    orcaRuntime,
    "normalize-worktree",
    "--profile", orcaProfile,
    "--worktree", "id:repo::normalize",
    "--expected-branch", "herder/orca-matrix/integration",
    "--expected-head", normalizeHead,
  ], {
    encoding: "utf8",
    env: {
      ...fakeRuntimeEnv,
      FAKE_ORCA_WORKTREE_ID: "repo::normalize",
      FAKE_ORCA_WORKTREE_PATH: normalizeWorktreePath,
      FAKE_ORCA_WORKTREE_BRANCH: "refs/heads/herder-orca-matrix-integration",
    },
  })
  assert.equal(normalizedWorktree.status, 0, normalizedWorktree.stderr)
  const normalizedEvidence = JSON.parse(normalizedWorktree.stdout)
  assert.equal(normalizedEvidence.renamed, true)
  assert.equal(normalizedEvidence.gitBranch, "herder/orca-matrix/integration")
  assert.equal(normalizedEvidence.orcaReportedBranchAfter, "herder-orca-matrix-integration")
  assert.equal(
    execFileSync("git", ["-C", normalizeWorktreePath, "symbolic-ref", "--short", "HEAD"], { encoding: "utf8" }).trim(),
    "herder/orca-matrix/integration",
  )
  assert.equal(
    spawnSync("git", [
      "-C", normalizeRepo,
      "show-ref", "--verify", "--quiet", "refs/heads/herder-orca-matrix-integration",
    ]).status,
    1,
  )
  const preflight = spawnSync(process.execPath, [
    orcaRuntime,
    "preflight",
    "--profile", orcaProfile,
  ], { encoding: "utf8", env: fakeRuntimeEnv })
  assert.equal(preflight.status, 0, preflight.stderr)
  const preflightEvidence = JSON.parse(preflight.stdout)
  assert.equal(preflightEvidence.controllerTerminal, "terminal:controller")
  assert.equal(preflightEvidence.worktreeId, "repo::controller")
  assert.deepEqual(preflightEvidence.orchestration, { status: "available", existingTaskCount: 0 })
  assert.equal(preflightEvidence.probes["plan-implementer"].status, "passed")
  assert.equal(preflightEvidence.probes["plan-reviewer"].status, "passed")
  assert.equal(preflightEvidence.probes["plan-judge"].status, "passed")
  assert.equal(preflightEvidence.probes["plan-saver"].status, "passed")

  const unattestedPreflight = spawnSync(process.execPath, [
    orcaRuntime,
    "preflight",
    "--profile", orcaProfile,
  ], {
    encoding: "utf8",
    env: {
      ...fakeRuntimeEnv,
      HERDER_ORCA_CONTROLLER_LAUNCHER_SHA256: "0".repeat(64),
    },
  })
  assert.notEqual(unattestedPreflight.status, 0)
  assert.match(unattestedPreflight.stderr, /Controller routing is unattested/)

  const controllerEnvLog = path.join(root, "fake-controller-env.json")
  const launchedController = spawnSync(process.execPath, [
    orcaRuntime,
    "launch-controller",
    "--profile", orcaProfile,
    "--controller-terminal", "terminal:controller",
    "--controller-worktree", "id:repo::controller",
  ], {
    encoding: "utf8",
    env: {
      ...fakeRuntimeEnv,
      FAKE_CONTROLLER_ENV_LOG: controllerEnvLog,
    },
  })
  assert.equal(launchedController.status, 0, launchedController.stderr)
  assert.deepEqual(JSON.parse(await readFile(controllerEnvLog, "utf8")), {
    profileHash: validatedOrcaProfile.profileHash,
    launcherHash: controllerLauncher.launcherSha256,
    terminal: "terminal:controller",
    worktree: "id:repo::controller",
  })

  const taskFile = path.join(root, "orca-task.txt")
  await writeFile(taskFile, "ROLE: plan-implementer\nSTATUS: return the required envelope\n")
  const dispatched = spawnSync(process.execPath, [
    orcaRuntime,
    "dispatch",
    "--profile", orcaProfile,
    "--role", "plan-implementer",
    "--worktree", "id:repo::plan-001",
    "--task-file", taskFile,
    "--attempt", "plans-001-implementer-1",
    "--controller-terminal", "terminal:controller",
  ], { encoding: "utf8", env: fakeRuntimeEnv })
  assert.equal(dispatched.status, 0, dispatched.stderr)
  const dispatchEvidence = JSON.parse(dispatched.stdout)
  assert.equal(dispatchEvidence.role, "plan-implementer")
  assert.equal(dispatchEvidence.harness, "grok-build")
  assert.equal(dispatchEvidence.model, "grok-4.5")
  assert.equal(dispatchEvidence.terminalHandle, "terminal:worker")
  assert.equal(dispatchEvidence.taskId, "task:001")
  assert.equal(dispatchEvidence.dispatchId, "dispatch:001")
  assert.equal(dispatchEvidence.readiness, "tui-idle")
  assert.match(dispatchEvidence.readinessEvidenceSha256, /^[a-f0-9]{64}$/)
  assert.match(dispatchEvidence.taskSha256, /^[a-f0-9]{64}$/)
  assert.match(dispatchEvidence.launcherSha256, /^[a-f0-9]{64}$/)
  assert.equal(dispatchEvidence.delivery, "tracked-terminal-send")
  assert.match(dispatchEvidence.deliverySha256, /^[a-f0-9]{64}$/)
  const fakeOrcaCalls = (await readFile(fakeOrcaLog, "utf8")).trim().split(/\r?\n/).map((line) => JSON.parse(line))
  assert.equal(fakeOrcaCalls.some((args) => args[0] === "terminal" && args[1] === "create" && args.includes("grok --model grok-4.5 --effort high --always-approve --no-subagents --no-auto-update")), true)
  assert.equal(fakeOrcaCalls.some((args) => args[0] === "orchestration" && args[1] === "task-create"), true)
  assert.equal(fakeOrcaCalls.some((args) => args[0] === "orchestration" && args[1] === "dispatch" && !args.includes("--inject")), true)
  const trackedSend = fakeOrcaCalls.find((args) => args[0] === "terminal" && args[1] === "send")
  assert.ok(trackedSend)
  const trackedPrompt = trackedSend[trackedSend.indexOf("--text") + 1]
  assert.match(trackedPrompt, /Task ID: task:001/)
  assert.match(trackedPrompt, /Dispatch ID: dispatch:001/)
  assert.match(trackedPrompt, /ROLE: plan-implementer/)

  const saverDispatch = spawnSync(process.execPath, [
    orcaRuntime,
    "dispatch",
    "--profile", orcaProfile,
    "--role", "plan-saver",
    "--worktree", "id:repo::plan-001",
    "--task-file", taskFile,
    "--attempt", "plans-001-saver-success",
    "--controller-terminal", "terminal:controller",
  ], { encoding: "utf8", env: fakeRuntimeEnv })
  assert.equal(saverDispatch.status, 0, saverDispatch.stderr)
  const saverEvidence = JSON.parse(saverDispatch.stdout)
  assert.equal(saverEvidence.role, "plan-saver")
  assert.equal(saverEvidence.harness, "grok-build")
  assert.equal(saverEvidence.model, "grok-4.5")
  assert.equal(saverEvidence.readiness, "tui-idle")
  assert.equal(saverEvidence.delivery, "tracked-terminal-send")

  const failedReadyDispatch = spawnSync(process.execPath, [
    orcaRuntime,
    "dispatch",
    "--profile", orcaProfile,
    "--role", "plan-saver",
    "--worktree", "id:repo::plan-001",
    "--task-file", taskFile,
    "--attempt", "plans-001-saver-1",
    "--controller-terminal", "terminal:controller",
    "--ready-timeout-ms", "1000",
  ], {
    encoding: "utf8",
    env: { ...fakeRuntimeEnv, FAKE_ORCA_FAIL: "terminal wait" },
  })
  assert.notEqual(failedReadyDispatch.status, 0)
  assert.match(failedReadyDispatch.stderr, /orca terminal wait failed with exit 7/)
  assert.match(failedReadyDispatch.stderr, /terminalHandle=terminal:worker/)
  assert.match(failedReadyDispatch.stderr, /taskId=none/)

  const failedDispatch = spawnSync(process.execPath, [
    orcaRuntime,
    "dispatch",
    "--profile", orcaProfile,
    "--role", "plan-implementer",
    "--worktree", "id:repo::plan-001",
    "--task-file", taskFile,
    "--attempt", "plans-001-implementer-failed",
    "--controller-terminal", "terminal:controller",
  ], {
    encoding: "utf8",
    env: { ...fakeRuntimeEnv, FAKE_ORCA_FAIL: "orchestration task-create" },
  })
  assert.notEqual(failedDispatch.status, 0)
  assert.match(failedDispatch.stderr, /terminalHandle=terminal:worker/)
  assert.match(failedDispatch.stderr, /taskId=none/)

  const fireSkill = await readFile(path.join(scriptDir, "..", "SKILL.md"), "utf8")
  assert.match(fireSkill, /Default plan-worker parallel limit: `5`/)
  assert.match(fireSkill, /--max-parallel <n>.*positive integer/)
  assert.match(fireSkill, /Reserve one additional host child slot for the persistent Accountant/)
  assert.match(fireSkill, /min\(requested, host_child_capacity - 1\)/)
  assert.match(fireSkill, /persistent Accountant owns scheduling decisions/)
  assert.match(fireSkill, /root coordinator owns only host-agent dispatch, waits, and user interaction/)
  assert.match(fireSkill, /plan-accountant.*plan_accountant.*herder:plan-accountant/)
  assert.match(fireSkill, /Luna\/max\/Fast on Codex and Opus\/medium on Claude/)
  assert.match(fireSkill, /Only the Accountant may invoke control-plane helper modes/)
  assert.match(fireSkill, /global role-agnostic pool for Implementer, Reviewer, and Judge attempts/)
  assert.match(fireSkill, /There is no global review lane/)
  assert.match(fireSkill, /Serialize only the final compare-and-advance operation with one integration lock/)
  assert.match(fireSkill, /Preserve approval only when patch equivalence, gates, and scope still pass/)
  assert.doesNotMatch(fireSkill, /review the exact restacked base/)
  assert.match(fireSkill, /at most six substantive Implementer → gates → Reviewer rounds/)
  assert.match(fireSkill, /Reviewer approval in any round skips Judge/)
  assert.match(fireSkill, /Fresh runs never dispatch Saver/)

  const protocol = await readFile(path.join(scriptDir, "..", "references", "orchestration-protocol.md"), "utf8")
  assert.match(protocol, /requested_worker_limit.*otherwise `5`/)
  assert.match(protocol, /control_slots.*exactly `1`/)
  assert.match(protocol, /parallel_limit.*min\(requested_worker_limit, host_child_capacity - control_slots\)/)
  assert.match(protocol, /Default five-worker execution therefore requires child capacity of at least six/)
  assert.match(protocol, /one event-driven global plan-worker pool/)
  assert.match(protocol, /root coordinator owns only host-agent dispatch, waits, and user interaction/)
  assert.match(protocol, /Accountant is the exclusive control-plane owner/)
  assert.match(protocol, /EVENT_KIND: BOOTSTRAP \| RESUME \| TERMINALS \| DISPATCH_RESULTS \| STATUS \| CLEANUP \| USER_INPUT/)
  assert.match(protocol, /Process `TERMINALS` as a stable batch sorted by plan, round, and role/)
  assert.match(protocol, /DISPATCH_RESULTS.*real host handle or exact failure/)
  assert.match(protocol, /Event replay is idempotent/)
  assert.match(protocol, /Never add an event journal or second scheduler state file/)
  assert.match(protocol, /There is no global review lane/)
  assert.match(protocol, /Implementer on A, Reviewer on B, and Judge on C can all run concurrently/)
  assert.match(protocol, /Accountant occupies the separate reserved control slot/)
  assert.match(protocol, /returns ordered actions for every available worker slot/)
  assert.match(protocol, /Do not wait for an implementation wave to drain/)
  assert.match(protocol, /only cross-plan mutex is the integration lock/)
  assert.doesNotMatch(protocol, /transaction lane|transaction-lane/i)
  assert.match(protocol, /wait_agent.*timeout_ms: 1800000/)
  assert.match(protocol, /timeout caps idle wakeups, not result-delivery latency/)
  assert.match(protocol, /do not reread transcripts, request status, or call `list_agents`/)
  assert.match(protocol, /node <checkout_guard> --repo <repo_root> --exclude <plan_dir> --pretty/)
  assert.match(protocol, /--expect <checkout_state_token>/)
  assert.match(protocol, /node <assignment_manager> materialize --plan <id>/)
  assert.match(protocol, /node <assignment_manager> materialize-run --plan-dir <plan_dir>/)
  assert.match(protocol, /node <assignment_manager> verify --worktree <absolute-worktree>/)
  assert.match(protocol, /missing, writable, symlinked, moved, branch-mismatched, or hash-mismatched bundle is a containment failure/)
  assert.match(protocol, /number of changed or undeclared paths and the number of changed lines may be reported descriptively but never gate the plan/)
  assert.doesNotMatch(protocol, /files<=|N\+3|hard file|8\/3\/11/)
  assert.doesNotMatch(protocol, /sum added plus deleted lines|file\/line overflow/)
  assert.match(protocol, /Do not derive a new trusted hash from the file itself/)
  assert.match(protocol, /Never parse tool-call text to infer filesystem containment/)
  assert.match(protocol, /Both runtimes require checkout-guard and exact before\/after Git proofs/)
  assert.doesNotMatch(protocol, /mutationEvidenceComplete|unresolvedApplyPatchCalls|applyPatchPaths|forbidden command workdirs/)
  assert.match(protocol, /node <gate_runner> --cwd/)
  assert.match(protocol, /returns metadata and no command output on success or failure/)
  assert.match(protocol, /herder\/<plan-name>\/integration/)
  assert.match(protocol, /herder\/<plan-name>\/<plan-id>/)
  assert.match(protocol, /Each plan has exactly one stable branch and at most one worktree/)
  assert.match(protocol, /Never create role, candidate, retry, stage, rescue, generation, or timestamp branches/)
  assert.match(protocol, /namespace conflict is a deliberate stop/i)
  assert.match(protocol, /git rebase --onto <integration-head> <reviewed-base>/)
  assert.match(protocol, /unique immutable checkpoint ref naming the pre-restack HEAD/)
  assert.match(protocol, /completion_ref\(<id>\)/)
  assert.match(protocol, /Do not add Herder metadata to commit subjects or bodies/)
  assert.match(protocol, /A crash may occur after the integration fast-forward but before the completion ref is written/)
  assert.match(protocol, /never infer approval merely because an unmarked commit appears on integration/i)
  assert.match(protocol, /Accountant verifies the checkout token and invokes fail-closed `--finalize`/)
  assert.match(protocol, /delete private refs with exact expected targets/)
  assert.match(protocol, /already-finalized plan set with all plans terminal, no plan branches, and no private refs/)
  assert.match(protocol, /--finalize --handoff-target/)
  assert.match(protocol, /integration HEAD to be an ancestor of the local target immediately before deleting/)
  assert.doesNotMatch(protocol, /git commit --amend|git commit --allow-empty/)
  assert.match(protocol, /git merge --ff-only <plan-branch>/)
  assert.match(protocol, /git merge --ff-only herder\/<plan-name>\/integration/)
  assert.match(protocol, /P2\/P3, `FOLLOWUP`, and `INVALID` findings are advisory and never block integration/)
  assert.match(protocol, /exactly six possible substantive rounds/)
  assert.match(protocol, /This is the only broad review/)
  assert.match(protocol, /first evidence-complete review is `DISCOVERY`.*regardless of round number/)
  assert.match(protocol, /Later reviews are `VERIFICATION`/)
  assert.match(protocol, /Assign each `NEW` finding the next stable ID/)
  assert.match(protocol, /Reviewer `APPROVE`.*skip Judge/)
  assert.match(protocol, /Reviewer `REVISE`, round 1–2.*`REPAIR_DIRECT`/)
  assert.match(protocol, /Reviewer nonapproval, round 3–6.*`JUDGE`/)
  assert.match(protocol, /Judge `REPAIR`, round 6.*`BLOCKED_ROUND_LIMIT`/)
  assert.match(protocol, /Approval always bypasses Judge/)
  assert.match(protocol, /Never reopen broad discovery/)
  assert.match(protocol, /Resume or restack never resets the six-round count, review-pass count, or finding ledger/i)
  assert.match(protocol, /A `REVISE` containing only P2\/P3, `FOLLOWUP`, `INVALID`/)
  assert.match(protocol, /DECISION: DONE \| REPAIR \| NEEDS_INPUT \| BLOCKED/)
  assert.match(protocol, /<plan_dir>\/leak\/<source-plan-id>-<finding-id>-<slug>\.md/)
  assert.match(protocol, /Do not convert fresh or merely five-attempt-exhausted legacy work into Saver/)
  assert.match(protocol, /For transient capacity, do not increment any round, retry, interruption, or clarification bound/)
  assert.match(protocol, /30, 60, 120, then 300 seconds/)
  assert.match(protocol, /Never infer capacity from quiet, timeout, disconnect, or missing response/)
  assert.match(protocol, /at most two same-attempt non-capacity restarts/)
  assert.match(protocol, /git worktree lock --reason plan-herder:/)
  assert.match(protocol, /integration lock is an Accountant mutex, not a plan worker and not a pool reservation/)
  assert.match(protocol, /never resume the interrupted child conversation/i)
  assert.match(protocol, /Dirty, conflicted, or rebasing without an owner/)
  assert.match(protocol, /runner recognizes only `herder\/<plan-name>\/<indexed-id>` plan branches plus exact integration/)
  assert.match(protocol, /Preserve clean non-`DONE` branches unless the user explicitly supplied `--include-failed`/)
  assert.match(protocol, /execution_runtime.*explicit `native` or `orca`/)
  assert.match(protocol, /matching `worker_done` task\/dispatch\/pane provenance/i)
  assert.match(protocol, /Accountant alone calls `record-usage` after every terminal worker attempt/)
  assert.match(protocol, /Cleanup is Accountant-only/)

  const policy = (...args) => JSON.parse(execFileSync(process.execPath, [roundPolicy, ...args], { encoding: "utf8" }))
  assert.deepEqual(policy("review", "--round", "1", "--verdict", "APPROVE", "--scope", "PASS", "--open-blockers", "0"), {
    ok: true, event: "review", round: 1, action: "READY_TO_INTEGRATE", judgeRequired: false, nextRound: null,
  })
  assert.equal(policy("review", "--round", "2", "--verdict", "REVISE", "--scope", "PASS", "--open-blockers", "1").action, "REPAIR_DIRECT")
  assert.equal(policy("review", "--round", "3", "--verdict", "REVISE", "--scope", "PASS", "--open-blockers", "1").action, "JUDGE")
  assert.equal(policy("review", "--round", "6", "--verdict", "APPROVE", "--scope", "PASS", "--open-blockers", "0").judgeRequired, false)
  assert.equal(policy("judge", "--round", "3", "--decision", "REPAIR").nextRound, 4)
  assert.equal(policy("judge", "--round", "6", "--decision", "DONE").action, "READY_TO_INTEGRATE")
  assert.equal(policy("judge", "--round", "6", "--decision", "REPAIR").action, "BLOCKED_ROUND_LIMIT")
  const invalidEarlyJudge = spawnSync(process.execPath, [roundPolicy, "judge", "--round", "2", "--decision", "DONE"], { encoding: "utf8" })
  assert.notEqual(invalidEarlyJudge.status, 0)
  const unknownReviewOption = spawnSync(process.execPath, [roundPolicy, "review", "--round", "1", "--verdict", "APPROVE", "--scope", "PASS", "--open-blockers", "0", "--extra", "ignored"], { encoding: "utf8" })
  assert.notEqual(unknownReviewOption.status, 0)
  assert.match(unknownReviewOption.stderr, /unexpected option for review: --extra/)

  const orcaProtocol = await readFile(path.join(scriptDir, "..", "references", "orca-runtime.md"), "utf8")
  assert.match(orcaProtocol, /root controller must itself be a Codex session in an Orca-managed terminal/)
  assert.match(orcaProtocol, /Accountant \(native, not Orca-routed\).*gpt-5\.6-luna.*Fast tier/)
  assert.match(orcaProtocol, /native persistent Accountant/)
  assert.match(orcaProtocol, /Orca is the sole worktree creator and remover/)
  assert.match(orcaProtocol, /normalize-worktree/)
  assert.match(orcaProtocol, /slash-to-hyphen Orca alias/)
  assert.match(orcaProtocol, /One Orca orchestration task represents exactly one Herder role attempt/)
  assert.match(orcaProtocol, /worker_done.*active task ID and dispatch ID/)
  assert.match(orcaProtocol, /at least two independent focused plans/)
  assert.match(orcaProtocol, /round-3 nonapproval to Pi\/GPT Judge/)
  assert.match(orcaProtocol, /never dispatches Saver for the fresh generation/)

  const pluginRoot = path.resolve(scriptDir, "..", "..", "..")
  const codexAccountant = await readFile(path.join(pluginRoot, "agent-profiles", "codex", "plan_accountant.toml"), "utf8")
  const claudeAccountant = await readFile(path.join(pluginRoot, "agents", "plan-accountant.md"), "utf8")
  assert.match(codexAccountant, /^model = "gpt-5\.6-luna"$/m)
  assert.match(codexAccountant, /^model_reasoning_effort = "max"$/m)
  assert.match(codexAccountant, /^service_tier = "fast"$/m)
  assert.match(claudeAccountant, /^model: claude-opus-4-8$/m)
  assert.match(claudeAccountant, /^effort: medium$/m)
  assert.doesNotMatch(claudeAccountant, /^tools:.*\bAgent\b/m)
  for (const profile of [codexAccountant, claudeAccountant]) {
    assert.match(profile, /root exclusively owns host worker handles and user interaction/)
    assert.match(profile, /Never spawn, steer, wait for, interrupt, or inspect an agent directly/)
    assert.match(profile, /min\(requested_worker_limit, host_child_capacity - 1\)/)
    assert.match(profile, /control_reserved=1/)
    assert.match(profile, /Process duplicate events idempotently/)
    assert.match(profile, /Never create a second scheduler state file/)
    assert.match(profile, /Accountant turns are coordinator overhead/)
  }
  const codexReviewer = await readFile(path.join(pluginRoot, "agent-profiles", "codex", "plan_reviewer.toml"), "utf8")
  const claudeReviewer = await readFile(path.join(pluginRoot, "agents", "plan-reviewer.md"), "utf8")
  for (const profile of [codexReviewer, claudeReviewer]) {
    assert.match(profile, /P2\/P3, .*FOLLOWUP.* and .*INVALID.* findings are advisory and never block approval/)
    assert.match(profile, /In every later .*VERIFICATION.* round, verify the supplied open finding IDs and inspect only the repair delta/)
    assert.match(profile, /Every blocking finding must identify an exact changed file and line/)
    assert.match(profile, /Return .*REVISE.* only when at least one evidence-complete blocking finding is open/)
    assert.match(profile, /repair contract containing observed behavior, expected behavior, reproduction, constraints/)
    assert.match(profile, /rounds 1–2.*direct repair authority/)
    assert.match(profile, /Beginning with a nonapproving round 3, Judge adjudicates/)
    assert.match(profile, /APPROVE.*skips Judge/)
    assert.match(profile, /Never use the number of changed or discovered paths as verdict evidence/)
  }

  const codexJudge = await readFile(path.join(pluginRoot, "agent-profiles", "codex", "plan_judge.toml"), "utf8")
  const claudeJudge = await readFile(path.join(pluginRoot, "agents", "plan-judge.md"), "utf8")
  for (const profile of [codexJudge, claudeJudge]) {
    assert.match(profile, /nonapproving Reviewer response at round 3–6/)
    assert.match(profile, /Reviewer approval skips Judge/)
    assert.match(profile, /BLOCKING_IN_SCOPE.*NONBLOCKING_IN_SCOPE.*DEFERRED_OUT_OF_SCOPE.*REJECTED/)
    assert.match(profile, /Never override a failed required gate/)
    assert.match(profile, /round 6.*BLOCKED.*seventh mutation/)
    assert.match(profile, /DECISION: DONE \| REPAIR \| NEEDS_INPUT \| BLOCKED/)
    assert.match(profile, /herder-plans\/leak\//)
    assert.match(profile, /path count alone is never a violation/)
  }

  const codexSaver = await readFile(path.join(pluginRoot, "agent-profiles", "codex", "plan_saver.toml"), "utf8")
  const claudeSaver = await readFile(path.join(pluginRoot, "agents", "plan-saver.md"), "utf8")
  for (const profile of [codexSaver, claudeSaver]) {
    assert.match(profile, /all five normal Implementation attempts are exhausted/)
    assert.match(profile, /Verify every direct finding and reproduction command/)
    assert.match(profile, /Repair only the supplied .*BLOCKING_IN_SCOPE.* finding IDs/)
    assert.match(profile, /Do not replace a narrow repair with an unrelated audit/)
    assert.match(profile, /OUTCOME: REPAIRED \| NEEDS_INPUT \| TERMINAL/)
    assert.doesNotMatch(profile, /OUTCOME:.*REPLAN/)
    assert.match(profile, /Write every commit subject and body solely in repository and domain terms/)
    assert.match(profile, /Never mention Herder, plan IDs, worker roles/)
  }

  const codexImplementer = await readFile(path.join(pluginRoot, "agent-profiles", "codex", "plan_implementer.toml"), "utf8")
  const claudeImplementer = await readFile(path.join(pluginRoot, "agents", "plan-implementer.md"), "utf8")
  for (const profile of [codexImplementer, claudeImplementer, codexReviewer, claudeReviewer, codexJudge, claudeJudge, codexSaver, claudeSaver]) {
    assert.match(profile, /longest event-driven or blocking process wait the host supports/)
    assert.match(profile, /A quiet process is not a failure/)
    assert.match(profile, /assignment bundle inside that worktree/)
    assert.match(profile, /supplied bundle SHA-256/)
    assert.match(profile, /final .*RUN.*plans\[\]\.planText/)
    assert.match(profile, /Never modify the assignment bundle/)
    assert.match(profile, /Never search or read the coordinator checkout, source plan directory, sibling worktrees, common Git directory/)
    assert.match(profile, /provided plan worktree and branch as the only repository target/)
    assert.match(profile, /Temporary directories may be used for non-repository scratch work/)
    assert.doesNotMatch(profile, /explicit workdir|command workdir|absolute apply-patch targets/)
    assert.match(profile, /legacy .*changed_lines.*nonbinding compatibility metadata/)
  }
  for (const profile of [codexImplementer, claudeImplementer]) {
    assert.match(profile, /Write every commit subject and body solely in repository and domain terms/)
    assert.match(profile, /Never mention Herder, plan IDs, worker roles/)
    assert.match(profile, /GUIDED_REPAIR/)
    assert.match(profile, /suggested directions as non-binding/)
    assert.match(profile, /Never stop merely because of the number of changed or discovered paths/)
  }
  const gateWorktree = path.join(root, "gate-worktree")
  const gateLogs = path.join(root, "gate-logs")
  await mkdir(gateWorktree)
  const success = spawnSync(process.execPath, [
    gateRunner,
    "--cwd", gateWorktree,
    "--log-dir", gateLogs,
    "--label", "verbose-success",
    "--",
    process.execPath,
    "-e",
    'process.stdout.write("x".repeat(250000))',
  ], { encoding: "utf8", maxBuffer: 1024 * 1024 })
  assert.equal(success.status, 0)
  assert.equal(success.stderr, "")
  assert.ok(Buffer.byteLength(success.stdout) < 2_000, "successful gate leaked its verbose output")
  const successEvidence = JSON.parse(success.stdout)
  assert.equal(successEvidence.ok, true)
  assert.equal(successEvidence.exitCode, 0)
  assert.equal(successEvidence.logBytes, 250_000)
  assert.match(successEvidence.logSha256, /^[a-f0-9]{64}$/)
  assert.match(successEvidence.commandSha256, /^[a-f0-9]{64}$/)
  assert.equal("command" in successEvidence, false)
  assert.equal("failureTail" in successEvidence, false)
  assert.equal((await readFile(successEvidence.logPath)).byteLength, 250_000)

  const failure = spawnSync(process.execPath, [
    gateRunner,
    "--cwd", gateWorktree,
    "--log-dir", gateLogs,
    "--label", "bounded-failure",
    "--",
    process.execPath,
    "-e",
    'for (let i = 0; i < 200; i += 1) console.log(`line-${String(i).padStart(3, "0")}`); console.error("FINAL FAILURE"); process.exit(7)',
  ], { encoding: "utf8", maxBuffer: 1024 * 1024 })
  assert.equal(failure.status, 1)
  assert.equal(failure.stderr, "")
  assert.ok(Buffer.byteLength(failure.stdout) < 2_000, "failed gate leaked its verbose output")
  const failureEvidence = JSON.parse(failure.stdout)
  assert.equal(failureEvidence.ok, false)
  assert.equal(failureEvidence.exitCode, 7)
  assert.equal("failureTail" in failureEvidence, false)
  assert.doesNotMatch(failure.stdout, /FINAL FAILURE|line-000/)
  const fullFailureLog = await readFile(failureEvidence.logPath, "utf8")
  assert.match(fullFailureLog, /line-000/)
  assert.match(fullFailureLog, /FINAL FAILURE/)

  const worktreeAlias = path.join(root, "gate-worktree-alias")
  const hiddenLogDir = path.join(worktreeAlias, "hidden-logs")
  await symlink(gateWorktree, worktreeAlias, "dir")
  const symlinkEscape = spawnSync(process.execPath, [
    gateRunner,
    "--cwd", gateWorktree,
    "--log-dir", hiddenLogDir,
    "--label", "symlink-escape",
    "--",
    process.execPath,
    "-e",
    "process.exit(0)",
  ], { encoding: "utf8" })
  assert.equal(symlinkEscape.status, 1)
  assert.match(JSON.parse(symlinkEscape.stdout).error, /outside the command worktree/)
  await assert.rejects(stat(path.join(gateWorktree, "hidden-logs")), { code: "ENOENT" })

  const dotDotNamedLogDir = path.join(gateWorktree, "..logs")
  const dotDotNamedEscape = spawnSync(process.execPath, [
    gateRunner,
    "--cwd", gateWorktree,
    "--log-dir", dotDotNamedLogDir,
    "--label", "dot-dot-name",
    "--",
    process.execPath,
    "-e",
    "process.exit(0)",
  ], { encoding: "utf8" })
  assert.equal(dotDotNamedEscape.status, 1)
  assert.match(JSON.parse(dotDotNamedEscape.stdout).error, /outside the command worktree/)
  await assert.rejects(stat(dotDotNamedLogDir), { code: "ENOENT" })

  const invalid = spawnSync(process.execPath, [gateRunner, "--cwd", gateWorktree], { encoding: "utf8" })
  assert.equal(invalid.status, 1)
  assert.deepEqual(JSON.parse(invalid.stdout), {
    ok: false,
    phase: "arguments",
    error: "--log-dir is required",
  })

  console.log("herder Fire evidence and compact gate tests passed")
} finally {
  await rm(root, { recursive: true, force: true })
}

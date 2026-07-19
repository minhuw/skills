#!/usr/bin/env node

import assert from "node:assert/strict"
import { execFileSync, spawnSync } from "node:child_process"
import { mkdtemp, mkdir, readFile, rm, stat, symlink, writeFile } from "node:fs/promises"
import { tmpdir } from "node:os"
import path from "node:path"
import process from "node:process"
import { fileURLToPath } from "node:url"

const scriptDir = path.dirname(fileURLToPath(import.meta.url))
const reader = path.join(scriptDir, "read-codex-agent-evidence.mjs")
const gateRunner = path.join(scriptDir, "run-gate.mjs")
const root = await mkdtemp(path.join(tmpdir(), "herder-agent-evidence-test-"))
const sessions = path.join(root, "sessions", "2026", "07", "15")
const archivedSessions = path.join(root, "archived_sessions")
const candidateReal = path.join(root, "candidate-real")
const candidateAlias = path.join(root, "candidate-alias")
const agentId = "019f0000-0000-7000-8000-000000000001"
const interruptedAgentId = "019f0000-0000-7000-8000-000000000002"
const priorAgentId = "019f0000-0000-7000-8000-000000000003"

try {
  await mkdir(sessions, { recursive: true })
  await mkdir(archivedSessions, { recursive: true })
  await mkdir(candidateReal)
  await symlink(candidateReal, candidateAlias)
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
    {
      type: "response_item",
      payload: {
        type: "custom_tool_call",
        name: "exec",
        input: `const r = await tools.exec_command({ cmd: "npm test", workdir: ${JSON.stringify(candidateReal)} });`,
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
    { type: "turn_context", payload: { cwd: candidateReal, model: "gpt-5.6-sol", effort: "xhigh" } },
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
  assert.deepEqual(evidence.executionWorkdirs, [candidateReal])
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

  const byWorkdir = JSON.parse(execFileSync(process.execPath, [reader, "--workdir", candidateAlias, "--codex-home", root], { encoding: "utf8" }))
  assert.equal(byWorkdir.ok, true)
  assert.equal(byWorkdir.workdir, candidateAlias)
  assert.deepEqual(byWorkdir.agents.map((item) => item.agentId), [agentId, priorAgentId])

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

  const protocol = await readFile(path.join(scriptDir, "..", "references", "orchestration-protocol.md"), "utf8")
  assert.match(protocol, /wait_agent.*timeout_ms: 1800000/)
  assert.match(protocol, /timeout caps idle wakeups, not result-delivery latency/)
  assert.match(protocol, /do not reread transcripts, request status, or call `list_agents`/)
  assert.match(protocol, /node <gate_runner> --cwd/)
  assert.match(protocol, /returns no command output on success or failure/)
  assert.match(protocol, /herder\/<plan-name>\/integration/)
  assert.match(protocol, /herder\/<plan-name>\/<plan-id>/)
  assert.match(protocol, /Each plan has exactly one stable branch and at most one worktree/)
  assert.match(protocol, /Never create candidate, stage, rescue, retry, generation, or timestamp branches/)
  assert.match(protocol, /namespace conflict is a deliberate stop/i)
  assert.match(protocol, /git rebase --onto <integration-head> <recorded-base>/)
  assert.match(protocol, /unique immutable checkpoint ref naming the pre-restack HEAD/)
  assert.match(protocol, /completion_ref\(<id>\)/)
  assert.match(protocol, /Do not add Herder metadata to a commit subject or body/)
  assert.match(protocol, /A crash may occur after the integration fast-forward but before the completion ref is written/)
  assert.match(protocol, /Never infer approval merely because an unmarked commit is present on integration/)
  assert.match(protocol, /invoke fail-closed `--finalize`/)
  assert.match(protocol, /delete private refs with exact expected targets/)
  assert.match(protocol, /already-finalized plan set with all plans terminal, no plan branches, and no private refs/)
  assert.match(protocol, /--finalize --handoff-target <target-branch>/)
  assert.match(protocol, /integration HEAD to be an ancestor of the local target immediately before deletion/)
  assert.doesNotMatch(protocol, /git commit --amend --no-edit --no-verify --trailer "Plan-Herder-Complete: <id>"/)
  assert.doesNotMatch(protocol, /git commit --allow-empty -m "plan-herder\(<id>\): mark plan done"/)
  assert.match(protocol, /git merge --ff-only <plan-branch>/)
  assert.match(protocol, /git merge --ff-only herder\/<plan-name>\/integration/)
  assert.match(protocol, /compact failure envelope/)
  assert.match(protocol, /open blocker evidence, reproduction commands, compact gate evidence/)
  assert.match(protocol, /P2 and P3 findings are advisory and never block integration/)
  assert.match(protocol, /Allow at most two completed broad discovery passes per generation/)
  assert.match(protocol, /verify only open blocker IDs/)
  assert.match(protocol, /Assign each `NEW` finding the next stable ID/)
  assert.match(protocol, /new blocker outside that delta after the cap becomes `NEEDS_ADJUDICATION`/)
  assert.match(protocol, /Do not restart broad discovery/)
  assert.match(protocol, /Resume or restack never resets broad-pass count or ledger/i)
  assert.match(protocol, /A `REVISE` response containing only P2\/P3, dismissed, or non-qualifying findings is effective approval/)
  assert.match(protocol, /Give each generation two substantive autonomous Saver rounds/)
  assert.match(protocol, /Accept at most two `REPLAN` outcomes per plan per invocation/)
  assert.match(protocol, /same signature survives two consecutive completed generations/)
  assert.match(protocol, /does not reset review state/)
  assert.match(protocol, /For transient capacity, do not increment any retry, interruption, clarification, replan, or recovery bound/)
  assert.match(protocol, /30 seconds, 60 seconds, 120 seconds, and 300 seconds/)
  assert.match(protocol, /Never infer capacity from quiet, timeout, disconnect, or missing response/)
  assert.match(protocol, /at most two same-round non-capacity interruption restarts/)
  assert.match(protocol, /infrastructure capacity unavailable; recovery budget preserved/)
  assert.doesNotMatch(protocol, /at most two same-round interruption restarts/)
  assert.match(protocol, /git worktree lock --reason plan-herder:/)
  assert.match(protocol, /Serialize restacking, coordinator gates, review, and integration advancement/i)
  assert.match(protocol, /Never resume the interrupted child conversation/)
  assert.match(protocol, /--workdir <absolute-worktree>/)
  assert.match(protocol, /Dirty, conflicted, or rebasing with no active owner: preserve exact worktree and dispatch Saver there/)
  assert.match(protocol, /The runner recognizes only `herder\/<plan-name>\/<indexed-id>` plan branches plus exact integration/)
  assert.match(protocol, /clean non-`DONE` branches unless the user explicitly supplied `--include-failed`/)
  assert.match(protocol, /For `--finalize --handoff-target`, require integration HEAD to be an ancestor/)

  const pluginRoot = path.resolve(scriptDir, "..", "..", "..")
  const codexReviewer = await readFile(path.join(pluginRoot, "agent-profiles", "codex", "plan_reviewer.toml"), "utf8")
  const claudeReviewer = await readFile(path.join(pluginRoot, "agents", "plan-reviewer.md"), "utf8")
  for (const profile of [codexReviewer, claudeReviewer]) {
    assert.match(profile, /P2\/P3 findings are advisory and never block approval/)
    assert.match(profile, /In .*VERIFICATION.* mode, verify the supplied open finding IDs and inspect only the repair delta/)
    assert.match(profile, /Every blocking finding must identify an exact changed file and line/)
    assert.match(profile, /Return .*REVISE.* only when at least one evidence-complete blocking finding is open/)
  }

  const codexSaver = await readFile(path.join(pluginRoot, "agent-profiles", "codex", "plan_saver.toml"), "utf8")
  const claudeSaver = await readFile(path.join(pluginRoot, "agents", "plan-saver.md"), "utf8")
  for (const profile of [codexSaver, claudeSaver]) {
    assert.match(profile, /compact failure envelope/)
    assert.match(profile, /Verify every direct finding and reproduction command/)
    assert.match(profile, /Repair only the supplied open blocking finding IDs/)
    assert.match(profile, /Do not replace a narrow repair with an unrelated audit/)
    assert.match(profile, /Write every commit subject and body solely in repository and domain terms/)
    assert.match(profile, /Never mention Herder, plan IDs, worker roles/)
  }

  const codexImplementer = await readFile(path.join(pluginRoot, "agent-profiles", "codex", "plan_implementer.toml"), "utf8")
  const claudeImplementer = await readFile(path.join(pluginRoot, "agents", "plan-implementer.md"), "utf8")
  for (const profile of [codexImplementer, claudeImplementer, codexReviewer, claudeReviewer, codexSaver, claudeSaver]) {
    assert.match(profile, /longest event-driven or blocking process wait the host supports/)
    assert.match(profile, /A quiet process is not a failure/)
  }
  for (const profile of [codexImplementer, claudeImplementer]) {
    assert.match(profile, /Write every commit subject and body solely in repository and domain terms/)
    assert.match(profile, /Never mention Herder, plan IDs, worker roles/)
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

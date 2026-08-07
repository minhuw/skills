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
const roundPolicy = path.join(scriptDir, "round-policy.mjs")
const root = await mkdtemp(path.join(tmpdir(), "herder-fire-test-"))

try {
  const sessions = path.join(root, "sessions", "2026", "08", "08")
  await mkdir(sessions, { recursive: true })
  const worktree = path.join(root, "worktree")
  await mkdir(worktree)
  const agentId = "019f0000-0000-7000-8000-000000000001"
  const events = [
    {
      type: "session_meta",
      payload: {
        id: agentId,
        parent_thread_id: "parent",
        thread_source: "subagent",
        source: { subagent: { thread_spawn: { agent_path: "/root/run-001", agent_role: "eclipse_plan_implementer" } } },
      },
    },
    { type: "turn_context", payload: { cwd: worktree, model: "gpt-5.6-luna", effort: "max", multi_agent_version: "v2", sandbox_policy: { type: "workspace-write" } } },
    { type: "response_item", payload: { type: "agent_message", content: [{ type: "input_text", text: "Message Type: NEW_TASK\nTask" }] } },
    { type: "event_msg", payload: { type: "token_count", info: { total_token_usage: { input_tokens: 101, cached_input_tokens: 20, output_tokens: 31, reasoning_output_tokens: 11 } } } },
    { timestamp: "2026-08-08T12:00:00Z", type: "event_msg", payload: { type: "task_started", started_at: 1786190400 } },
    { timestamp: "2026-08-08T12:00:02Z", type: "event_msg", payload: { type: "task_complete", last_agent_message: "STATUS: COMPLETE", started_at: 1786190400, completed_at: 1786190402, duration_ms: 2000 } },
  ]
  await writeFile(path.join(sessions, "rollout.jsonl"), `${events.map(JSON.stringify).join("\n")}\n`)

  const evidence = JSON.parse(execFileSync(process.execPath, [reader, "--agent-id", agentId, "--codex-home", root], { encoding: "utf8" }))
  assert.equal(evidence.agentRole, "eclipse_plan_implementer")
  assert.equal(evidence.model, "gpt-5.6-luna")
  assert.equal(evidence.effort, "max")
  assert.equal(evidence.taskMessageCount, 1)
  assert.equal(evidence.userMessageCount, 0)
  assert.deepEqual(evidence.terminal, { taskComplete: true, turnAborted: false, finalEnvelopePresent: true })
  assert.deepEqual(evidence.usage, {
    inputTokens: 101,
    cachedInputTokens: 20,
    outputTokens: 31,
    reasoningTokens: 11,
    source: "codex-multi-agent-v2-transcript",
    startedAt: "2026-08-08T12:00:00.000Z",
    finishedAt: "2026-08-08T12:00:02.000Z",
    durationMs: 2000,
  })
  assert.equal(JSON.parse(execFileSync(process.execPath, [reader, "--agent", "/root/run-001", "--codex-home", root], { encoding: "utf8" })).agentId, agentId)
  assert.equal(spawnSync(process.execPath, [reader, "--agent", "missing", "--codex-home", root]).status, 1)

  const policy = (...args) => JSON.parse(execFileSync(process.execPath, [roundPolicy, ...args], { encoding: "utf8" }))
  assert.equal(policy("review", "--round", "1", "--verdict", "APPROVE", "--scope", "PASS", "--open-blockers", "0").action, "READY_TO_INTEGRATE")
  assert.equal(policy("review", "--round", "2", "--verdict", "REVISE", "--scope", "PASS", "--open-blockers", "1").action, "REPAIR_DIRECT")
  assert.equal(policy("review", "--round", "3", "--verdict", "REVISE", "--scope", "PASS", "--open-blockers", "1").action, "JUDGE")
  assert.equal(policy("judge", "--round", "3", "--decision", "REPAIR").nextRound, 4)
  assert.equal(policy("judge", "--round", "6", "--decision", "REPAIR").action, "BLOCKED_ROUND_LIMIT")
  assert.notEqual(spawnSync(process.execPath, [roundPolicy, "judge", "--round", "2", "--decision", "DONE"]).status, 0)

  const skill = await readFile(path.join(scriptDir, "..", "SKILL.md"), "utf8")
  const protocol = await readFile(path.join(scriptDir, "..", "references", "run-manager-protocol.md"), "utf8")
  assert.match(skill, /structured `herder_control` tool/)
  assert.match(skill, /SQLite is the only runtime lifecycle authority/)
  assert.match(skill, /Implementer, Reviewer, and Judge/)
  assert.doesNotMatch(skill, /Accountant|Saver|base64|orca-runtime/)
  assert.match(protocol, /immutable plan specification compiled into .*execution\.sqlite3/)
  assert.match(protocol, /README\.md.*projection of SQLite/)
  assert.match(protocol, /Implementer -> manager gates -> Reviewer -> integrate/)
  assert.match(protocol, /Beginning at unresolved round 3, Judge filters findings/)

  const pluginRoot = path.resolve(scriptDir, "../../..")
  const roleFiles = ["plan-implementer.md", "plan-reviewer.md", "plan-judge.md"]
  for (const roleFile of roleFiles) {
    const role = await readFile(path.join(pluginRoot, "agent-profiles", "templates", "claude", roleFile), "utf8")
    assert.match(role, /assignment bundle/)
    assert.match(role, /Never modify the assignment bundle/)
    assert.match(role, /longest event-driven or blocking process wait/)
  }

  const gateWorktree = path.join(root, "gate-worktree")
  const gateLogs = path.join(root, "gate-logs")
  await mkdir(gateWorktree)
  const success = spawnSync(process.execPath, [
    gateRunner, "--cwd", gateWorktree, "--log-dir", gateLogs, "--label", "success", "--",
    process.execPath, "-e", 'process.stdout.write("x".repeat(250000))',
  ], { encoding: "utf8", maxBuffer: 1024 * 1024 })
  assert.equal(success.status, 0)
  assert.ok(Buffer.byteLength(success.stdout) < 2_000)
  const successEvidence = JSON.parse(success.stdout)
  assert.equal(successEvidence.logBytes, 250_000)
  assert.equal((await readFile(successEvidence.logPath)).byteLength, 250_000)

  const failure = spawnSync(process.execPath, [
    gateRunner, "--cwd", gateWorktree, "--log-dir", gateLogs, "--label", "failure", "--",
    process.execPath, "-e", 'console.error("FINAL FAILURE"); process.exit(7)',
  ], { encoding: "utf8" })
  assert.equal(failure.status, 1)
  const failureEvidence = JSON.parse(failure.stdout)
  assert.equal(failureEvidence.exitCode, 7)
  assert.doesNotMatch(failure.stdout, /FINAL FAILURE/)
  assert.match(await readFile(failureEvidence.logPath, "utf8"), /FINAL FAILURE/)

  const alias = path.join(root, "gate-worktree-alias")
  await symlink(gateWorktree, alias, "dir")
  const escapedLogs = path.join(alias, "hidden-logs")
  const escaped = spawnSync(process.execPath, [
    gateRunner, "--cwd", gateWorktree, "--log-dir", escapedLogs, "--label", "escape", "--",
    process.execPath, "-e", "process.exit(0)",
  ], { encoding: "utf8" })
  assert.equal(escaped.status, 1)
  assert.match(JSON.parse(escaped.stdout).error, /outside the command worktree/)
  await assert.rejects(stat(escapedLogs), { code: "ENOENT" })

  console.log("herder Fire tests passed")
} finally {
  await rm(root, { recursive: true, force: true })
}

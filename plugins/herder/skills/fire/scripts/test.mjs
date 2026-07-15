#!/usr/bin/env node

import assert from "node:assert/strict"
import { execFileSync, spawnSync } from "node:child_process"
import { mkdtemp, mkdir, rm, writeFile } from "node:fs/promises"
import { tmpdir } from "node:os"
import path from "node:path"
import process from "node:process"
import { fileURLToPath } from "node:url"

const scriptDir = path.dirname(fileURLToPath(import.meta.url))
const reader = path.join(scriptDir, "read-codex-agent-evidence.mjs")
const root = await mkdtemp(path.join(tmpdir(), "herder-agent-evidence-test-"))
const sessions = path.join(root, "sessions", "2026", "07", "15")
const agentId = "019f0000-0000-7000-8000-000000000001"

try {
  await mkdir(sessions, { recursive: true })
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
        cwd: "/tmp/candidate",
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
        input: 'const r = await tools.exec_command({ cmd: "npm test", workdir: "/tmp/candidate" });',
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
  ]
  await writeFile(path.join(sessions, "rollout.jsonl"), `${events.map(JSON.stringify).join("\n")}\n`)

  const evidence = JSON.parse(execFileSync(process.execPath, [reader, "--agent-id", agentId, "--codex-home", root], { encoding: "utf8" }))
  assert.equal(evidence.ok, true)
  assert.equal(evidence.agentRole, "plan_implementer")
  assert.equal(evidence.model, "gpt-5.6-luna")
  assert.equal(evidence.effort, "max")
  assert.equal(evidence.multiAgentVersion, "v2")
  assert.equal(evidence.sandbox, "workspace-write")
  assert.deepEqual(evidence.executionWorkdirs, ["/tmp/candidate"])
  assert.equal(evidence.userMessageCount, 1)
  assert.equal(evidence.taskMessageCount, 0)
  assert.deepEqual(evidence.usage, {
    inputTokens: 101,
    cachedInputTokens: 20,
    outputTokens: 31,
    reasoningTokens: 11,
    source: "codex-multi-agent-v2-transcript",
  })

  const byTask = JSON.parse(execFileSync(process.execPath, [reader, "--agent", "/root/run-001", "--codex-home", root], { encoding: "utf8" }))
  assert.equal(byTask.agentId, agentId)

  const missing = spawnSync(process.execPath, [reader, "--agent", "missing", "--codex-home", root], { encoding: "utf8" })
  assert.equal(missing.status, 1)
  assert.equal(JSON.parse(missing.stdout).ok, false)
  console.log("herder Codex Multi-Agent V2 evidence tests passed")
} finally {
  await rm(root, { recursive: true, force: true })
}

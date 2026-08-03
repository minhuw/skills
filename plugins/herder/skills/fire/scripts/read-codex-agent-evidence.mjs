#!/usr/bin/env node

import { opendir, readFile } from "node:fs/promises"
import { homedir } from "node:os"
import path from "node:path"
import process from "node:process"

class UsageError extends Error {}

function parseArgs(argv) {
  const options = {
    agent: "",
    codexHome: process.env.CODEX_HOME || path.join(homedir(), ".codex"),
    pretty: false,
  }
  for (let index = 0; index < argv.length; index += 1) {
    const argument = argv[index]
    if (argument === "--pretty") options.pretty = true
    else if (["--agent", "--agent-id", "--codex-home"].includes(argument)) {
      const value = argv[index + 1]
      if (!value || value.startsWith("--")) throw new UsageError(`${argument} requires a value`)
      index += 1
      if (["--agent", "--agent-id"].includes(argument)) options.agent = value
      else options.codexHome = path.resolve(value)
    } else if (["--help", "-h"].includes(argument)) options.help = true
    else throw new UsageError(`Unknown argument: ${argument}`)
  }
  if (!options.help && !options.agent) throw new UsageError("--agent is required")
  return options
}

function usage() {
  return `Usage: read-codex-agent-evidence.mjs --agent <id-or-canonical-task-name> [--codex-home <path>] [--pretty]\n`
}

async function *jsonlFiles(directory) {
  let entries
  try {
    entries = await opendir(directory)
  } catch (error) {
    if (error.code === "ENOENT") return
    throw error
  }
  for await (const entry of entries) {
    const entryPath = path.join(directory, entry.name)
    if (entry.isDirectory()) yield *jsonlFiles(entryPath)
    else if (entry.isFile() && entry.name.endsWith(".jsonl")) yield entryPath
  }
}

function safeTokenUsage(value) {
  if (!value) return null
  const fields = ["input_tokens", "cached_input_tokens", "output_tokens", "reasoning_output_tokens"]
  if (!fields.every((field) => Number.isSafeInteger(value[field]) && value[field] >= 0)) return null
  return {
    inputTokens: value.input_tokens,
    cachedInputTokens: value.cached_input_tokens,
    outputTokens: value.output_tokens,
    reasoningTokens: value.reasoning_output_tokens,
    source: "codex-multi-agent-v2-transcript",
  }
}

function parseSession(text, options, file) {
  let meta = null
  let context = null
  let tokenUsage = null
  let lastEventAt = null
  let userMessageCount = 0
  let taskMessageCount = 0
  let taskComplete = false
  let turnAborted = false
  let finalEnvelopePresent = false
  for (const line of text.split(/\r?\n/)) {
    if (!line.trim().startsWith("{")) continue
    let event
    try {
      event = JSON.parse(line)
    } catch {
      continue
    }
    if (typeof event.timestamp === "string") lastEventAt = event.timestamp
    if (event.type === "session_meta") {
      meta = event.payload || {}
    }
    if (event.type === "turn_context") context = event.payload || null
    if (event.type === "event_msg" && event.payload?.type === "user_message") userMessageCount += 1
    if (event.type === "event_msg" && event.payload?.type === "task_complete") {
      taskComplete = true
      if (typeof event.payload.last_agent_message === "string" && event.payload.last_agent_message.trim()) {
        finalEnvelopePresent = true
      }
    }
    if (event.type === "event_msg" && event.payload?.type === "turn_aborted") turnAborted = true
    if (event.type === "event_msg" && event.payload?.type === "agent_message" && event.payload.phase === "final_answer") {
      finalEnvelopePresent = true
    }
    if (event.type === "response_item" && event.payload?.type === "message" && event.payload.phase === "final_answer") {
      finalEnvelopePresent = true
    }
    if (event.type === "response_item" && event.payload?.type === "agent_message") {
      const content = event.payload.content || []
      if (content.some((item) => item.type === "input_text" && item.text?.includes("Message Type: NEW_TASK"))) {
        taskMessageCount += 1
      }
    }
    if (event.type === "event_msg" && event.payload?.type === "token_count") {
      tokenUsage = safeTokenUsage(event.payload.info?.total_token_usage) || tokenUsage
    }
  }
  if (!meta) return null
  const spawn = meta.source?.subagent?.thread_spawn || {}
  const aliases = [meta.id, meta.session_id, meta.agent_path, spawn.agent_path]
  const cwd = context?.cwd || meta.cwd || null
  if (!aliases.includes(options.agent)) return null
  return {
    ok: true,
    lookup: options.agent,
    agentId: meta.id || meta.session_id || null,
    transcript: file,
    threadSource: meta.thread_source || null,
    parentThreadId: meta.parent_thread_id || spawn.parent_thread_id || null,
    agentPath: meta.agent_path || spawn.agent_path || null,
    agentRole: meta.agent_role || spawn.agent_role || null,
    agentNickname: meta.agent_nickname || spawn.agent_nickname || null,
    historyMode: meta.history_mode || null,
    multiAgentVersion: context?.multi_agent_version || meta.multi_agent_version || null,
    model: context?.model || null,
    effort: context?.effort || null,
    sandbox: context?.sandbox_policy?.type || null,
    approvalPolicy: context?.approval_policy || null,
    cwd,
    lastEventAt,
    userMessageCount,
    taskMessageCount,
    terminal: {
      taskComplete,
      turnAborted,
      finalEnvelopePresent,
    },
    usage: tokenUsage,
  }
}

async function findEvidence(options) {
  for (const directory of ["sessions", "archived_sessions"]) {
    for await (const file of jsonlFiles(path.join(options.codexHome, directory))) {
      const evidence = parseSession(await readFile(file, "utf8"), options, file)
      if (!evidence) continue
      return evidence
    }
  }
  return {
    ok: false,
    lookup: options.agent,
    error: "No persisted Codex session matched the agent ID or canonical task name",
  }
}

const options = parseArgs(process.argv.slice(2))
if (options.help) process.stdout.write(usage())
else {
  const evidence = await findEvidence(options)
  process.stdout.write(`${JSON.stringify(evidence, null, options.pretty ? 2 : 0)}\n`)
  if (!evidence.ok) process.exitCode = 1
}

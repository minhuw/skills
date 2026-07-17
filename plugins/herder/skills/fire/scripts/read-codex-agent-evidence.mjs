#!/usr/bin/env node

import { opendir, readFile } from "node:fs/promises"
import { realpathSync } from "node:fs"
import { homedir } from "node:os"
import path from "node:path"
import process from "node:process"

class UsageError extends Error {}

function parseArgs(argv) {
  const options = {
    agent: "",
    workdir: "",
    codexHome: process.env.CODEX_HOME || path.join(homedir(), ".codex"),
    pretty: false,
  }
  for (let index = 0; index < argv.length; index += 1) {
    const argument = argv[index]
    if (argument === "--pretty") options.pretty = true
    else if (["--agent", "--agent-id", "--workdir", "--codex-home"].includes(argument)) {
      const value = argv[index + 1]
      if (!value || value.startsWith("--")) throw new UsageError(`${argument} requires a value`)
      index += 1
      if (["--agent", "--agent-id"].includes(argument)) options.agent = value
      else if (argument === "--workdir") options.workdir = path.resolve(value)
      else options.codexHome = path.resolve(value)
    } else if (["--help", "-h"].includes(argument)) options.help = true
    else throw new UsageError(`Unknown argument: ${argument}`)
  }
  if (!options.help && Boolean(options.agent) === Boolean(options.workdir)) {
    throw new UsageError("exactly one of --agent or --workdir is required")
  }
  return options
}

function usage() {
  return `Usage: read-codex-agent-evidence.mjs (--agent <id-or-canonical-task-name> | --workdir <absolute-path>) [--codex-home <path>] [--pretty]\n`
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

function toolWorkdirs(input) {
  if (typeof input !== "string") return []
  const workdirs = []
  const pattern = /(?:"workdir"|workdir)\s*:\s*"([^"]+)"/g
  for (const match of input.matchAll(pattern)) workdirs.push(match[1])
  return workdirs
}

function canonicalPath(value) {
  const absolute = path.resolve(value)
  try {
    return realpathSync.native(absolute)
  } catch {
    return absolute
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
  const executionWorkdirs = new Set()
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
    if (event.type === "response_item" && event.payload?.type === "custom_tool_call") {
      for (const workdir of toolWorkdirs(event.payload.input)) executionWorkdirs.add(workdir)
    }
    if (event.type === "event_msg" && event.payload?.type === "token_count") {
      tokenUsage = safeTokenUsage(event.payload.info?.total_token_usage) || tokenUsage
    }
  }
  if (!meta) return null
  const spawn = meta.source?.subagent?.thread_spawn || {}
  const aliases = [meta.id, meta.session_id, meta.agent_path, spawn.agent_path]
  const cwd = context?.cwd || meta.cwd || null
  if (options.agent && !aliases.includes(options.agent)) return null
  if (options.workdir) {
    const matchingWorkdir = [cwd, ...executionWorkdirs].some((candidate) => (
      typeof candidate === "string" && canonicalPath(candidate) === canonicalPath(options.workdir)
    ))
    if (!matchingWorkdir) return null
  }
  return {
    ok: true,
    lookup: options.agent || options.workdir,
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
    executionWorkdirs: [...executionWorkdirs],
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
  const matches = []
  for (const directory of ["sessions", "archived_sessions"]) {
    for await (const file of jsonlFiles(path.join(options.codexHome, directory))) {
      const evidence = parseSession(await readFile(file, "utf8"), options, file)
      if (!evidence) continue
      if (options.agent) return evidence
      matches.push(evidence)
    }
  }
  if (options.workdir && matches.length > 0) {
    matches.sort((left, right) => String(right.lastEventAt).localeCompare(String(left.lastEventAt)))
    return { ok: true, lookup: options.workdir, workdir: options.workdir, agents: matches }
  }
  return {
    ok: false,
    lookup: options.agent || options.workdir,
    error: options.agent
      ? "No persisted Codex session matched the agent ID or canonical task name"
      : "No persisted Codex session used the requested worktree",
  }
}

const options = parseArgs(process.argv.slice(2))
if (options.help) process.stdout.write(usage())
else {
  const evidence = await findEvidence(options)
  process.stdout.write(`${JSON.stringify(evidence, null, options.pretty ? 2 : 0)}\n`)
  if (!evidence.ok) process.exitCode = 1
}

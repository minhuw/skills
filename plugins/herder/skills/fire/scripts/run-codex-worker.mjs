#!/usr/bin/env node

import { execFileSync, spawn, spawnSync } from "node:child_process"
import { access, readFile } from "node:fs/promises"
import path from "node:path"
import process from "node:process"
import readline from "node:readline"
import { fileURLToPath } from "node:url"

const scriptDir = path.dirname(fileURLToPath(import.meta.url))
const pluginRoot = path.resolve(scriptDir, "../../..")
const codexBin = process.env.HERDER_CODEX_BIN || "codex"

const roles = {
  plan_implementer: {
    profile: "plan_implementer.toml",
    sandbox: "workspace-write",
  },
  plan_reviewer: {
    profile: "plan_reviewer.toml",
    sandbox: "read-only",
  },
  plan_saver: {
    profile: "plan_saver.toml",
    sandbox: "workspace-write",
  },
}

class UsageError extends Error {}

function usage() {
  return `Usage:
  run-codex-worker.mjs --check [--role <role>] [--pretty]
  run-codex-worker.mjs --role <role> --worktree <path> --prompt-file <path> [--pretty]

Roles: plan_implementer, plan_reviewer, plan_saver
`
}

function normalizeRole(value) {
  return value?.replaceAll("-", "_")
}

function parseArgs(argv) {
  const options = {
    check: false,
    pretty: false,
    promptFile: "",
    role: "",
    worktree: "",
  }

  for (let index = 0; index < argv.length; index += 1) {
    const argument = argv[index]
    if (argument === "--check") options.check = true
    else if (argument === "--pretty") options.pretty = true
    else if (["--prompt-file", "--role", "--worktree"].includes(argument)) {
      const value = argv[index + 1]
      if (!value || value.startsWith("--")) throw new UsageError(`${argument} requires a value`)
      index += 1
      if (argument === "--prompt-file") options.promptFile = path.resolve(value)
      if (argument === "--role") options.role = normalizeRole(value)
      if (argument === "--worktree") options.worktree = path.resolve(value)
    } else if (["--help", "-h"].includes(argument)) {
      options.help = true
    } else throw new UsageError(`Unknown argument: ${argument}`)
  }

  if (options.help) return options
  if (options.role && !roles[options.role]) throw new UsageError(`Unknown role: ${options.role}`)
  if (!options.check && !options.role) throw new UsageError("--role is required")
  if (!options.check && (!options.worktree || !options.promptFile)) {
    throw new UsageError("--worktree and --prompt-file are required for a worker run")
  }
  return options
}

function profileValue(text, key) {
  const match = text.match(new RegExp(`^${key}\\s*=\\s*"([^"\\n]+)"\\s*$`, "m"))
  if (!match) throw new Error(`Profile is missing ${key}`)
  return match[1]
}

async function loadRole(role) {
  const definition = roles[role]
  const profilePath = path.join(pluginRoot, "agent-profiles/codex", definition.profile)
  const text = await readFile(profilePath, "utf8")
  const instructions = text.match(/^developer_instructions\s*=\s*"""\n([\s\S]*?)\n"""\s*$/m)?.[1]
  if (!instructions) throw new Error("Profile is missing developer_instructions")
  return {
    role,
    model: profileValue(text, "model"),
    effort: profileValue(text, "model_reasoning_effort"),
    instructions,
    profilePath,
    sandbox: definition.sandbox,
  }
}

function modelCatalog() {
  const result = spawnSync(codexBin, ["debug", "models"], {
    encoding: "utf8",
    maxBuffer: 20 * 1024 * 1024,
  })
  if (result.error) throw new Error(`Could not start Codex: ${result.error.message}`)
  if (result.status !== 0) throw new Error(`codex debug models failed (${result.status}): ${result.stderr.trim()}`)
  try {
    return JSON.parse(result.stdout).models
  } catch (error) {
    throw new Error(`Codex returned an invalid model catalog: ${error.message}`)
  }
}

async function checkRoles(selectedRole) {
  const catalog = modelCatalog()
  const selected = selectedRole ? [selectedRole] : Object.keys(roles)
  const checked = []
  for (const role of selected) {
    const profile = await loadRole(role)
    const model = catalog.find((candidate) => candidate.slug === profile.model)
    if (!model) throw new Error(`${role} requests unavailable Codex model ${profile.model}`)
    const efforts = (model.supported_reasoning_levels || []).map((item) => item.effort)
    if (!efforts.includes(profile.effort)) {
      throw new Error(`${role} requests unsupported effort ${profile.effort} for ${profile.model}`)
    }
    checked.push({
      role,
      model: profile.model,
      effort: profile.effort,
      sandbox: profile.sandbox,
      profile: profile.profilePath,
    })
  }
  return { ok: true, mode: "check", roles: checked }
}

function gitCommonDir(worktree) {
  const value = execFileSync("git", ["-C", worktree, "rev-parse", "--git-common-dir"], {
    encoding: "utf8",
    stdio: ["ignore", "pipe", "pipe"],
  }).trim()
  return path.resolve(worktree, value)
}

function normalizeUsage(value) {
  if (!value) return null
  const fields = ["input_tokens", "cached_input_tokens", "output_tokens", "reasoning_output_tokens"]
  if (!fields.every((field) => Number.isSafeInteger(value[field]) && value[field] >= 0)) return null
  return {
    inputTokens: value.input_tokens,
    cachedInputTokens: value.cached_input_tokens,
    outputTokens: value.output_tokens,
    reasoningTokens: value.reasoning_output_tokens,
    totalTokens: value.input_tokens + value.output_tokens,
    source: "codex-exec-jsonl",
  }
}

async function runWorker(options) {
  const profile = await loadRole(options.role)
  await access(options.worktree)
  const prompt = await readFile(options.promptFile, "utf8")
  if (!prompt.trim()) throw new Error("Prompt file is empty")

  const args = [
    "--ask-for-approval", "never",
    "exec",
    "--disable", "multi_agent",
    "--json",
    "--color", "never",
    "--sandbox", profile.sandbox,
    "-C", options.worktree,
    "--model", profile.model,
    "--config", `model_reasoning_effort=${JSON.stringify(profile.effort)}`,
    "--config", `developer_instructions=${JSON.stringify(profile.instructions)}`,
  ]
  if (profile.sandbox === "workspace-write") args.push("--add-dir", gitCommonDir(options.worktree))
  args.push("-")

  const child = spawn(codexBin, args, {
    cwd: options.worktree,
    env: process.env,
    stdio: ["pipe", "pipe", "pipe"],
  })

  let finalMessage = ""
  let threadId = ""
  let usageValue = null
  let diagnostics = ""

  child.stderr.on("data", (chunk) => {
    const text = chunk.toString()
    process.stderr.write(text)
    diagnostics = `${diagnostics}${text}`.slice(-8000)
  })

  const lines = readline.createInterface({ input: child.stdout })
  lines.on("line", (line) => {
    try {
      const event = JSON.parse(line)
      if (event.type === "thread.started" && event.thread_id) threadId = event.thread_id
      if (event.type === "item.completed" && event.item?.type === "agent_message") {
        finalMessage = event.item.text || ""
      }
      if (event.type === "turn.completed") usageValue = event.usage
    } catch {
      // Codex diagnostics may appear beside JSONL. Stderr and the exit code remain authoritative.
    }
  })

  child.stdin.end(prompt)
  const exitCode = await new Promise((resolve, reject) => {
    child.once("error", reject)
    child.once("close", resolve)
  })
  const workerUsage = normalizeUsage(usageValue)
  const ok = exitCode === 0 && Boolean(finalMessage)
  return {
    ok,
    mode: "run",
    role: profile.role,
    model: profile.model,
    effort: profile.effort,
    sandbox: profile.sandbox,
    threadId: threadId || null,
    exitCode,
    message: finalMessage || null,
    usage: workerUsage,
    diagnostics: ok ? null : diagnostics.trim() || null,
  }
}

function print(value, pretty) {
  process.stdout.write(`${JSON.stringify(value, null, pretty ? 2 : 0)}\n`)
}

async function main() {
  const options = parseArgs(process.argv.slice(2))
  if (options.help) {
    process.stdout.write(usage())
    return
  }
  const result = options.check ? await checkRoles(options.role) : await runWorker(options)
  print(result, options.pretty)
  if (!result.ok) process.exitCode = 1
}

main().catch((error) => {
  if (error instanceof UsageError) {
    process.stderr.write(`${error.message}\n${usage()}`)
    process.exitCode = 2
    return
  }
  print({ ok: false, error: error.message }, process.argv.includes("--pretty"))
  process.exitCode = 1
})

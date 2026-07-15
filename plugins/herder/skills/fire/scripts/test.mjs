#!/usr/bin/env node

import assert from "node:assert/strict"
import { execFileSync, spawnSync } from "node:child_process"
import { chmod, mkdtemp, mkdir, readFile, rm, writeFile } from "node:fs/promises"
import { tmpdir } from "node:os"
import path from "node:path"
import process from "node:process"
import { fileURLToPath } from "node:url"

const scriptDir = path.dirname(fileURLToPath(import.meta.url))
const runner = path.join(scriptDir, "run-codex-worker.mjs")
const fixture = await mkdtemp(path.join(tmpdir(), "herder-codex-worker-test-"))
const worktree = path.join(fixture, "repo")
const promptFile = path.join(fixture, "prompt.md")
const logFile = path.join(fixture, "codex-call.json")
const fakeCodex = path.join(fixture, "codex")

function invoke(args, extraEnv = {}) {
  return spawnSync(process.execPath, [runner, ...args], {
    encoding: "utf8",
    env: {
      ...process.env,
      HERDER_CODEX_BIN: fakeCodex,
      HERDER_FAKE_LOG: logFile,
      ...extraEnv,
    },
  })
}

try {
  await mkdir(worktree)
  execFileSync("git", ["init", "-q"], { cwd: worktree })
  await writeFile(promptFile, "Return the required worker envelope.\n")
  await writeFile(fakeCodex, `#!/usr/bin/env node
import fs from "node:fs"
const args = process.argv.slice(2)
if (args[0] === "debug" && args[1] === "models") {
  console.log(JSON.stringify({ models: [
    { slug: "gpt-5.6-luna", supported_reasoning_levels: [{ effort: "max" }] },
    { slug: "gpt-5.6-sol", supported_reasoning_levels: [{ effort: "xhigh" }, { effort: "max" }] },
  ] }))
  process.exit(0)
}
let prompt = ""
process.stdin.setEncoding("utf8")
process.stdin.on("data", (chunk) => { prompt += chunk })
process.stdin.on("end", () => {
  fs.writeFileSync(process.env.HERDER_FAKE_LOG, JSON.stringify({ args, prompt }))
  if (process.env.HERDER_FAKE_FAIL) {
    console.error("synthetic worker failure")
    process.exit(9)
  }
  console.log(JSON.stringify({ type: "thread.started", thread_id: "thread-test" }))
  console.log(JSON.stringify({ type: "item.completed", item: { type: "agent_message", text: "STATUS: COMPLETE" } }))
  console.log(JSON.stringify({ type: "turn.completed", usage: {
    input_tokens: 100,
    cached_input_tokens: 40,
    output_tokens: 25,
    reasoning_output_tokens: 10,
  } }))
})
`)
  await chmod(fakeCodex, 0o755)

  const checked = invoke(["--check", "--pretty"])
  assert.equal(checked.status, 0, checked.stderr)
  const checkResult = JSON.parse(checked.stdout)
  assert.deepEqual(checkResult.roles.map((item) => item.role), [
    "plan_implementer",
    "plan_reviewer",
    "plan_saver",
  ])
  assert.deepEqual(checkResult.roles.map((item) => `${item.model}/${item.effort}`), [
    "gpt-5.6-luna/max",
    "gpt-5.6-sol/xhigh",
    "gpt-5.6-sol/xhigh",
  ])

  const implemented = invoke([
    "--role", "plan_implementer",
    "--worktree", worktree,
    "--prompt-file", promptFile,
    "--pretty",
  ])
  assert.equal(implemented.status, 0, implemented.stderr)
  const implementation = JSON.parse(implemented.stdout)
  assert.equal(implementation.model, "gpt-5.6-luna")
  assert.equal(implementation.effort, "max")
  assert.equal(implementation.message, "STATUS: COMPLETE")
  assert.deepEqual(implementation.usage, {
    inputTokens: 100,
    cachedInputTokens: 40,
    outputTokens: 25,
    reasoningTokens: 10,
    totalTokens: 125,
    source: "codex-exec-jsonl",
  })
  const implementationCall = JSON.parse(await readFile(logFile, "utf8"))
  assert.equal(implementationCall.prompt, "Return the required worker envelope.\n")
  assert.equal(implementationCall.args[implementationCall.args.indexOf("--model") + 1], "gpt-5.6-luna")
  assert.equal(implementationCall.args[implementationCall.args.indexOf("--sandbox") + 1], "workspace-write")
  assert.equal(implementationCall.args.includes("--add-dir"), true)
  assert.equal(implementationCall.args.includes("model_reasoning_effort=\"max\""), true)
  assert.equal(implementationCall.args.includes("--disable"), true)
  assert.equal(implementationCall.args.includes("multi_agent"), true)
  assert.equal(implementationCall.args.some((item) => item.startsWith("developer_instructions=")), true)
  assert.equal(implementationCall.args.at(-1), "-")

  const reviewed = invoke([
    "--role", "plan-reviewer",
    "--worktree", worktree,
    "--prompt-file", promptFile,
  ])
  assert.equal(reviewed.status, 0, reviewed.stderr)
  const reviewCall = JSON.parse(await readFile(logFile, "utf8"))
  assert.equal(reviewCall.args[reviewCall.args.indexOf("--model") + 1], "gpt-5.6-sol")
  assert.equal(reviewCall.args[reviewCall.args.indexOf("--sandbox") + 1], "read-only")
  assert.equal(reviewCall.args.includes("--add-dir"), false)
  assert.equal(reviewCall.args.includes("model_reasoning_effort=\"xhigh\""), true)

  const failed = invoke([
    "--role", "plan_saver",
    "--worktree", worktree,
    "--prompt-file", promptFile,
  ], { HERDER_FAKE_FAIL: "1" })
  assert.equal(failed.status, 1)
  const failure = JSON.parse(failed.stdout)
  assert.equal(failure.ok, false)
  assert.equal(failure.exitCode, 9)
  assert.equal(failure.usage, null)
  assert.match(failure.diagnostics, /synthetic worker failure/)

  console.log("herder Codex worker runner tests passed")
} finally {
  await rm(fixture, { recursive: true, force: true })
}

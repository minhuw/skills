#!/usr/bin/env node

import assert from "node:assert/strict"
import fs from "node:fs"
import os from "node:os"
import path from "node:path"
import process from "node:process"
import { spawnSync } from "node:child_process"
import { fileURLToPath } from "node:url"

const scriptDir = path.dirname(fileURLToPath(import.meta.url))
const pluginRoot = path.resolve(scriptDir, "..")
const marketplaceRoot = path.resolve(pluginRoot, "../..")

function fail(message) {
  throw new Error(message)
}

function parseArgs(argv) {
  const options = {
    live: false,
    liveFire: false,
    liveGrill: false,
    keep: false,
    workspace: "",
    authFile: process.env.HERDER_SMOKE_AUTH || path.join(os.homedir(), ".codex", "auth.json"),
  }
  for (let index = 0; index < argv.length; index += 1) {
    const argument = argv[index]
    if (argument === "--live") options.live = true
    else if (argument === "--live-fire") options.liveFire = true
    else if (argument === "--live-grill") options.liveGrill = true
    else if (argument === "--keep") options.keep = true
    else if (["--workspace", "--auth-file"].includes(argument)) {
      if (index === argv.length - 1) fail(`${argument} requires a value`)
      const key = argument === "--workspace" ? "workspace" : "authFile"
      options[key] = path.resolve(argv[++index])
    } else if (["-h", "--help"].includes(argument)) {
      process.stdout.write(`Usage: node smoke-test.mjs [--live | --live-fire | --live-grill] [--keep] [--workspace <empty-dir>] [--auth-file <file>]\n`)
      process.exit(0)
    } else fail(`Unknown argument: ${argument}`)
  }
  if ([options.live, options.liveFire, options.liveGrill].filter(Boolean).length > 1) {
    fail("--live, --live-fire, and --live-grill are separate test modes")
  }
  if (options.workspace) options.keep = true
  return options
}

function run(command, args, { cwd, env = process.env, allowFailure = false } = {}) {
  const result = spawnSync(command, args, { cwd, env, encoding: "utf8", input: "" })
  if (result.error) fail(`${command} failed to start: ${result.error.message}`)
  if (result.status !== 0 && !allowFailure) {
    fail(`${command} ${args.join(" ")} failed (${result.status})\n${result.stdout}${result.stderr}`)
  }
  return result
}

function parseJson(output, label) {
  try {
    return JSON.parse(output)
  } catch (error) {
    fail(`${label} did not return JSON: ${error.message}\n${output}`)
  }
}

function ensureEmptyDirectory(directory) {
  if (fs.existsSync(directory) && fs.readdirSync(directory).length > 0) {
    fail(`Smoke workspace must be empty: ${directory}`)
  }
  fs.mkdirSync(directory, { recursive: true })
}

function writeFixture(project) {
  fs.mkdirSync(path.join(project, "src"), { recursive: true })
  fs.mkdirSync(path.join(project, "test"), { recursive: true })
  fs.writeFileSync(path.join(project, "package.json"), `${JSON.stringify({
    name: "herder-smoke-cli",
    private: true,
    type: "module",
    scripts: { test: "node --test" },
  }, null, 2)}\n`)
  fs.writeFileSync(path.join(project, "README.md"), `# Herder Smoke CLI

A tiny dependency-free Node.js CLI. Run it with \`node src/cli.mjs\` and test it with \`npm test\`.
`)
  fs.writeFileSync(path.join(project, "AGENTS.md"), `# Repository instructions

- Keep the CLI dependency-free.
- Run \`npm test\` for verification.
- Follow the existing Node.js ESM style.
`)
  fs.writeFileSync(path.join(project, "src", "cli.mjs"), `export function message() {
  return "herder-smoke"
}

if (import.meta.url === \`file://\${process.argv[1]}\`) {
  process.stdout.write(\`\${message()}\\n\`)
}
`)
  fs.writeFileSync(path.join(project, "test", "cli.test.mjs"), `import assert from "node:assert/strict"
import test from "node:test"
import { message } from "../src/cli.mjs"

test("prints the application name", () => {
  assert.equal(message(), "herder-smoke")
})
`)

  run("git", ["init", "-q"], { cwd: project })
  run("git", ["config", "user.name", "Herder Smoke"], { cwd: project })
  run("git", ["config", "user.email", "herder-smoke@example.invalid"], { cwd: project })
  run("git", ["add", "."], { cwd: project })
  run("git", ["commit", "-q", "-m", "test: add smoke fixture"], { cwd: project })
}

function writeCodexConfig(codexHome, project, fireRoot) {
  const tomlString = (value) => JSON.stringify(value)
  fs.writeFileSync(path.join(codexHome, "config.toml"), `model = "gpt-5.6-sol"
model_reasoning_effort = "max"
approval_policy = "never"
sandbox_mode = "workspace-write"

[features.multi_agent_v2]
enabled = true
hide_spawn_agent_metadata = false
max_concurrent_threads_per_session = 4
tool_namespace = "herder_agents"

[agents]
max_depth = 1

[sandbox_workspace_write]
writable_roots = [${tomlString(path.join(project, ".git"))}, ${tomlString(fireRoot)}]
`)
}

function finalAgentMessage(jsonl) {
  let message = ""
  for (const line of jsonl.split(/\r?\n/)) {
    if (!line.trim().startsWith("{")) continue
    try {
      const event = JSON.parse(line)
      if (event.type === "item.completed" && event.item?.type === "agent_message") message = event.item.text
    } catch {
      // Non-JSON diagnostics are preserved in the transcript and ignored here.
    }
  }
  return message
}

function startedThreadId(jsonl) {
  for (const line of jsonl.split(/\r?\n/)) {
    if (!line.trim().startsWith("{")) continue
    try {
      const event = JSON.parse(line)
      if (event.type === "thread.started" && event.thread_id) return event.thread_id
    } catch {
      // Ignore non-JSON diagnostics.
    }
  }
  return ""
}

function finishCodexStep(name, result, context) {
  fs.mkdirSync(context.transcripts, { recursive: true })
  fs.writeFileSync(path.join(context.transcripts, `${name}.jsonl`), result.stdout)
  fs.writeFileSync(path.join(context.transcripts, `${name}.stderr.log`), result.stderr)
  if (result.status !== 0) {
    fail(`Live Codex step ${name} failed (${result.status}); see ${context.transcripts}`)
  }
  const message = finalAgentMessage(result.stdout)
  if (!message) fail(`Live Codex step ${name} returned no final agent message`)
  return { message, threadId: startedThreadId(result.stdout) }
}

function runCodex(name, prompt, context, { ephemeral = true } = {}) {
  const args = [
    "exec",
    "--json",
    "-C", context.project,
    prompt,
  ]
  if (ephemeral) args.splice(1, 0, "--ephemeral")
  return finishCodexStep(name, run("codex", args, { cwd: context.project, env: context.env, allowFailure: true }), context)
}

function jsonlFiles(directory) {
  if (!fs.existsSync(directory)) return []
  const files = []
  for (const entry of fs.readdirSync(directory, { withFileTypes: true })) {
    const entryPath = path.join(directory, entry.name)
    if (entry.isDirectory()) files.push(...jsonlFiles(entryPath))
    else if (entry.isFile() && entry.name.endsWith(".jsonl")) files.push(entryPath)
  }
  return files
}

function nativeAgentEvidence(codexHome, evidenceReader) {
  const evidence = []
  for (const file of jsonlFiles(path.join(codexHome, "sessions"))) {
    const firstLine = fs.readFileSync(file, "utf8").split(/\r?\n/, 1)[0]
    let meta
    try {
      const event = JSON.parse(firstLine)
      if (event.type !== "session_meta") continue
      meta = event.payload || {}
    } catch {
      continue
    }
    const role = meta.agent_role || meta.source?.subagent?.thread_spawn?.agent_role
    if (!role?.startsWith("plan_")) continue
    const agentId = meta.id || meta.session_id
    const result = run("node", [evidenceReader, "--agent-id", agentId, "--codex-home", codexHome], { cwd: codexHome })
    evidence.push(parseJson(result.stdout, `agent evidence ${agentId}`))
  }
  return evidence
}

function nativeSpawnEvidence(codexHome) {
  const evidence = []
  for (const file of jsonlFiles(path.join(codexHome, "sessions"))) {
    let context = null
    for (const line of fs.readFileSync(file, "utf8").split(/\r?\n/)) {
      if (!line.trim().startsWith("{")) continue
      let event
      try {
        event = JSON.parse(line)
      } catch {
        continue
      }
      if (event.type === "turn_context") context = event.payload || null
      if (event.type !== "response_item" || event.payload?.type !== "function_call") continue
      if (event.payload.name !== "spawn_agent" || event.payload.namespace !== "herder_agents") continue
      const parsedArguments = JSON.parse(event.payload.arguments)
      const { message, ...routingArguments } = parsedArguments
      evidence.push({
        transcript: file,
        namespace: event.payload.namespace,
        arguments: routingArguments,
        encryptedMessagePresent: typeof message === "string" && message.length > 0,
        coordinatorModel: context?.model || null,
        coordinatorEffort: context?.effort || null,
        multiAgentVersion: context?.multi_agent_version || null,
      })
    }
  }
  return evidence
}

function worktreeForBranch(repo, branch) {
  const lines = run("git", ["worktree", "list", "--porcelain"], { cwd: repo }).stdout.split(/\r?\n/)
  let current = ""
  for (const line of lines) {
    if (line.startsWith("worktree ")) current = line.slice("worktree ".length)
    if (line === `branch refs/heads/${branch}`) return current
  }
  fail(`No worktree found for ${branch}`)
}

function resumeCodex(name, threadId, prompt, context) {
  if (!threadId) fail(`Cannot resume ${name} without a thread ID`)
  const result = run("codex", ["exec", "resume", "--json", threadId, prompt], {
    cwd: context.project,
    env: context.env,
    allowFailure: true,
  })
  return finishCodexStep(name, result, context)
}

function writeGrillPlan(project) {
  const planDir = path.join(project, "herder-plans")
  const plannedAt = run("git", ["rev-parse", "--short", "HEAD"], { cwd: project }).stdout.trim()
  const plannedDate = new Date().toISOString().slice(0, 10)
  const readme = path.join(planDir, "README.md")
  const currentReadme = fs.readFileSync(readme, "utf8")
  const usageStart = currentReadme.indexOf("<!-- herder-usage:start -->")
  if (usageStart === -1) fail("Initialized Grill fixture has no usage ledger")
  const usageSection = currentReadme.slice(usageStart).trim()
  fs.writeFileSync(readme, `# Herder Plans

## Execution order & status

| Plan | Title | Priority | Effort | Depends on | Status |
|------|-------|----------|--------|------------|--------|
| [001](001-add-version-flag.md) | Add a --version flag | P2 | S | — | TODO |

## Dependency notes

None.

## Considered and rejected

None.

${usageSection}
`)
  const plan = path.join(planDir, "001-add-version-flag.md")
  fs.writeFileSync(plan, `# Plan 001: Add a --version flag

## Status

- **Priority**: P2
- **Effort**: S
- **Risk**: LOW
- **Depends on**: none
- **Category**: dx
- **Planned at**: commit \`${plannedAt}\`, ${plannedDate}

## Why this matters

Users need a deterministic way to identify the installed CLI version in bug reports and scripts. The no-argument greeting must remain unchanged.

## Current state

- \`src/cli.mjs\` prints \`herder-smoke\` and has no argument handling.
- \`package.json\` is the single source of package metadata.
- \`test/cli.test.mjs\` uses Node's built-in test runner.

## Commands you will need

| Purpose | Command | Expected on success |
|---|---|---|
| Tests | \`npm test\` | all tests pass |
| Version | \`node src/cli.mjs --version\` | exits 0 with the chosen format |

## Scope

**In scope**: \`package.json\`, \`src/cli.mjs\`, and \`test/cli.test.mjs\`.

**Out of scope**: dependencies, a general argument parser, aliases, and changes to no-argument output.

## Steps

### Step 1: Define the output contract

[DECISION NEEDED: choose plain version text or a JSON object.] All other behavior is fixed by this plan.

### Step 2: Implement the flag

Add package version metadata, print the chosen representation for the exact \`--version\` argument, and preserve the current no-argument path.

### Step 3: Add black-box coverage

Test the exact version output, exit code, and unchanged no-argument behavior with Node's built-in test tools.

## Test plan

Add tests for exact \`--version\` output, successful exit, and the existing no-argument greeting. Run \`npm test\` and the direct version command.

## Done criteria

- [ ] \`npm test\` exits 0.
- [ ] \`node src/cli.mjs --version\` exits 0 and matches the confirmed output contract exactly.
- [ ] \`node src/cli.mjs\` still prints \`herder-smoke\`.
- [ ] No dependency or general argument parser is added.

## STOP conditions

Stop if package metadata cannot be loaded without adding a dependency, or if the change requires a general argument parser.

## Maintenance notes

Keep package metadata as the version source of truth. Reviewers should reject duplicated version constants.
`)
  return plan
}

function installPlugin(codexHome, project) {
  const env = { ...process.env, CODEX_HOME: codexHome }
  const marketplace = run("codex", ["plugin", "marketplace", "add", marketplaceRoot, "--json"], { cwd: project, env })
  const addedMarketplace = parseJson(marketplace.stdout, "marketplace add")
  assert.equal(addedMarketplace.marketplaceName, "herder")

  const install = run("codex", ["plugin", "add", "herder@herder", "--json"], { cwd: project, env })
  const installed = parseJson(install.stdout, "plugin add")
  assert.equal(installed.name, "herder")
  assert.equal(installed.marketplaceName, "herder")
  return { env, installed }
}

function main() {
  const options = parseArgs(process.argv.slice(2))
  const root = options.workspace || fs.mkdtempSync(path.join(os.tmpdir(), "herder-plugin-smoke-"))
  if (options.workspace) ensureEmptyDirectory(root)
  const project = path.join(root, "project")
  const codexHome = path.join(root, "codex-home")
  const transcripts = path.join(root, "transcripts")
  const reports = path.join(root, "reports")
  const fireRoot = path.join(root, "fire-worktrees")
  fs.mkdirSync(project, { recursive: true })
  fs.mkdirSync(codexHome, { recursive: true })
  writeCodexConfig(codexHome, project, fireRoot)

  let succeeded = false
  let createdAuthLink = ""
  try {
    writeFixture(project)
    const { env, installed } = installPlugin(codexHome, project)
    const installedPath = installed.installedPath
    const expectedSkills = ["fire", "grill", "improve", "install", "plans"]
    for (const skill of expectedSkills) {
      assert.equal(fs.existsSync(path.join(installedPath, "skills", skill, "SKILL.md")), true, `missing installed skill ${skill}`)
    }
    const sharedTemplate = path.join(installedPath, "skills", "plans", "references", "plan-template.md")
    assert.equal(fs.existsSync(sharedTemplate), true, "missing shared plan template")
    assert.equal(fs.existsSync(path.join(installedPath, "skills", "improve", "references", "plan-template.md")), false, "Improve still owns a private plan template")
    const sharedTemplateText = fs.readFileSync(sharedTemplate, "utf8")
    assert.match(sharedTemplateText, /### Accepted decisions/)
    assert.match(sharedTemplateText, /CONTEXT\.md/)
    assert.match(sharedTemplateText, /Producer self-review/)
    assert.match(sharedTemplateText, /Mechanical validation complements self-review/)
    assert.doesNotMatch(sharedTemplateText, /\*\*Issue\*\*/)
    const grillText = fs.readFileSync(path.join(installedPath, "skills", "grill", "SKILL.md"), "utf8")
    const improveText = fs.readFileSync(path.join(installedPath, "skills", "improve", "SKILL.md"), "utf8")
    assert.match(grillText, /herder:grill <change-description>/)
    assert.match(grillText, /Producer self-review/)
    assert.match(grillText, /resume the one-question interview/)
    assert.match(improveText, /Route user intent to .*herder:grill/)
    assert.match(improveText, /Producer self-review/)
    const evidenceReader = path.join(installedPath, "skills", "fire", "scripts", "read-codex-agent-evidence.mjs")
    assert.equal(fs.existsSync(evidenceReader), true, "missing installed Codex Multi-Agent V2 evidence reader")

    const manager = path.join(installedPath, "skills", "plans", "scripts", "herder-plans.mjs")
    const initialized = parseJson(run("node", [manager, "init", "herder-plans", "--pretty"], { cwd: project }).stdout, "plans init")
    assert.equal(initialized.tracking, "local")
    assert.equal(run("git", ["check-ignore", "-q", "herder-plans/README.md"], { cwd: project, allowFailure: true }).status, 0)
    const emptyGraph = parseJson(run("node", [manager, "validate", "herder-plans", "--pretty"], { cwd: project }).stdout, "empty validation")
    assert.equal(emptyGraph.counts.total, 0)
    const recordedUsage = parseJson(run("node", [
      manager,
      "record-usage", "RUN", "plan-reviewer", "herder-plans",
      "--attempt", "smoke-run-reviewer-1",
      "--model", "gpt-5.6-sol",
      "--effort", "xhigh",
      "--outcome", "AVAILABLE",
      "--source", "unknown",
      "--pretty",
    ], { cwd: project }).stdout, "usage recording")
    assert.equal(recordedUsage.recorded, true)
    const usage = parseJson(run("node", [manager, "usage", "herder-plans", "--pretty"], { cwd: project }).stdout, "usage report")
    assert.equal(usage.attempts, 1)
    assert.equal(usage.byRole[0].key, "plan-reviewer")
    assert.equal(usage.byRole[0].tokenAttempts, 0)

    run("npm", ["test"], { cwd: project })

    if (options.live || options.liveFire || options.liveGrill) {
      if (!fs.existsSync(options.authFile)) fail(`Codex auth file not found: ${options.authFile}`)
      const authTarget = path.join(codexHome, "auth.json")
      if (!fs.existsSync(authTarget)) {
        fs.symlinkSync(options.authFile, authTarget)
        createdAuthLink = authTarget
      }
      const context = { project, env, transcripts }

      const installMessage = runCodex("00-install", `Use $herder:install --host codex --scope user. Install the native Herder profiles into this isolated Codex home, verify Multi-Agent V2, and do not change repository source.`, context).message
      assert.match(installMessage, /multi.agent.v2|multi_agent_v2|enabled/i)
      for (const profile of ["plan_implementer", "plan_reviewer", "plan_saver"]) {
        assert.equal(fs.existsSync(path.join(codexHome, "agents", `${profile}.toml`)), true, `missing installed profile ${profile}`)
      }
      assert.match(fs.readFileSync(path.join(codexHome, "agents", "plan_reviewer.toml"), "utf8"), /sandbox_mode = "read-only"/)

      if (options.live) {
        const opened = runCodex("01-grill-intake", `Use $herder:grill to plan a --version flag for this tiny CLI. Print only the package version followed by one newline, preserve the no-argument output, and add no dependencies. Use your recommendations for any remaining decisions. Follow the skill exactly: inspect the repository, summarize the shared understanding, ask for final confirmation, and do not edit yet.`, context, { ephemeral: false })
        assert.match(opened.message, /confirm|shared understanding|write|plan/i)

        const emptyBeforeConfirmation = parseJson(run("node", [manager, "validate", "herder-plans", "--pretty"], { cwd: project }).stdout, "pre-confirmation validation")
        assert.equal(emptyBeforeConfirmation.counts.total, 0)

        const confirmed = resumeCodex("02-grill-confirm", opened.threadId, `Yes. That summary is accurate. Create exactly one plan and validate the backlog.`, context)
        assert.match(confirmed.message, /herder-plans|valid|created|plan 001/i)

        const graph = parseJson(run("node", [manager, "validate", "herder-plans", "--pretty"], { cwd: project }).stdout, "generated validation")
        assert.equal(graph.counts.total, 1)
        assert.deepEqual(graph.ready, ["001"])
        assert.equal(parseJson(run("node", [manager, "usage", "herder-plans", "--pretty"], { cwd: project }).stdout, "preserved usage report").attempts, 1)
        assert.equal(run("git", ["status", "--short"], { cwd: project }).stdout.trim(), "")

        const plansMessage = runCodex("03-plans-status", `Use $herder:plans status herder-plans. Stay read-only and report the ready plan IDs.`, context).message
        assert.match(plansMessage, /001/)

        const fireMessage = runCodex("04-fire-status", `Use $herder:fire status herder-plans. Stay read-only, do not spawn workers, and report the ready plan IDs.`, context).message
        assert.match(fireMessage, /001/)
      } else if (options.liveFire) {
        const improveMessage = runCodex("01-improve", `Use $herder:improve plan to add a --version flag to this tiny CLI. Write exactly one self-contained plan under herder-plans/, do not modify source code, do not ask questions, and validate the backlog before finishing.`, context).message
        assert.match(improveMessage, /herder-plans|plan/i)

        const graph = parseJson(run("node", [manager, "validate", "herder-plans", "--pretty"], { cwd: project }).stdout, "generated validation")
        assert.equal(graph.counts.total, 1)
        assert.deepEqual(graph.ready, ["001"])
        assert.equal(parseJson(run("node", [manager, "usage", "herder-plans", "--pretty"], { cwd: project }).stdout, "preserved usage report").attempts, 1)
        assert.equal(run("git", ["status", "--short"], { cwd: project }).stdout.trim(), "")

        const originalHead = run("git", ["rev-parse", "HEAD"], { cwd: project }).stdout.trim()
        const fireMessage = runCodex("02-fire-run", `Use $herder:fire herder-plans --max-parallel 1. Execute the validated backlog end to end in this disposable repository. Use ${fireRoot} as the worktree root. Do not push or merge into the current branch. Follow the skill exactly and report the integration branch, verification, and token usage.`, context, {
          ephemeral: false,
        }).message
        assert.match(fireMessage, /completed|done|integration/i)
        fs.mkdirSync(reports, { recursive: true })
        fs.writeFileSync(path.join(reports, "final-fire-report.md"), `${fireMessage.trim()}\n`)

        const completedGraph = parseJson(run("node", [manager, "validate", "herder-plans", "--pretty"], { cwd: project }).stdout, "completed validation")
        assert.equal(completedGraph.complete, true)
        assert.equal(completedGraph.counts.done, 1)
        const completedUsage = parseJson(run("node", [manager, "usage", "herder-plans", "--pretty"], { cwd: project }).stdout, "completed usage report")
        const fireAttempts = completedUsage.records.filter((record) => record.attempt !== "smoke-run-reviewer-1")
        assert.equal(fireAttempts.length >= 3, true)
        assert.equal(fireAttempts.every((record) => Number.isSafeInteger(record.inputTokens)), true)
        assert.equal(fireAttempts.every((record) => Number.isSafeInteger(record.outputTokens)), true)
        assert.equal(fireAttempts.every((record) => record.source === "codex-multi-agent-v2-transcript"), true)
        assert.equal(fireAttempts.some((record) => record.model === "gpt-5.6-luna" && record.effort === "max"), true)
        assert.equal(fireAttempts.some((record) => record.model === "gpt-5.6-sol" && record.effort === "xhigh"), true)

        const agentEvidence = nativeAgentEvidence(codexHome, evidenceReader)
        assert.equal(agentEvidence.length >= 3, true, "expected native implementer and reviewer sessions")
        assert.equal(agentEvidence.every((item) => item.multiAgentVersion === "v2"), true)
        assert.equal(agentEvidence.every((item) => item.userMessageCount === 0 && item.taskMessageCount === 1), true, "child context was not isolated")
        assert.equal(agentEvidence.every((item) => item.cwd === project), true, "child session did not inherit the intended repository context")
        assert.equal(agentEvidence.every((item) => item.executionWorkdirs.length > 0 && item.executionWorkdirs.every((workdir) => workdir.startsWith(fireRoot))), true, "child command escaped the disposable Fire worktree root")
        assert.equal(agentEvidence.every((item) => item.usage && Number.isSafeInteger(item.usage.inputTokens)), true)
        const implementers = agentEvidence.filter((item) => item.agentRole === "plan_implementer")
        const reviewers = agentEvidence.filter((item) => item.agentRole === "plan_reviewer")
        assert.equal(implementers.length >= 1, true)
        assert.equal(reviewers.length >= 2, true)
        assert.equal(implementers.every((item) => item.model === "gpt-5.6-luna" && item.effort === "max" && item.sandbox === "workspace-write"), true)
        assert.equal(reviewers.every((item) => item.model === "gpt-5.6-sol" && item.effort === "xhigh" && item.sandbox === "workspace-write"), true)
        fs.writeFileSync(path.join(reports, "native-agent-evidence.json"), `${JSON.stringify(agentEvidence, null, 2)}\n`)

        const spawnEvidence = nativeSpawnEvidence(codexHome)
        assert.equal(spawnEvidence.length >= 3, true)
        assert.equal(spawnEvidence.every((item) => item.namespace === "herder_agents"), true)
        assert.equal(spawnEvidence.every((item) => item.encryptedMessagePresent), true)
        assert.equal(spawnEvidence.every((item) => item.arguments.fork_turns === "none"), true)
        assert.equal(spawnEvidence.every((item) => ["plan_implementer", "plan_reviewer", "plan_saver"].includes(item.arguments.agent_type)), true)
        assert.equal(spawnEvidence.every((item) => !("model" in item.arguments) && !("reasoning_effort" in item.arguments) && !("service_tier" in item.arguments)), true)
        assert.equal(spawnEvidence.every((item) => item.coordinatorModel === "gpt-5.6-sol" && item.coordinatorEffort === "max" && item.multiAgentVersion === "v2"), true)
        fs.writeFileSync(path.join(reports, "native-spawn-evidence.json"), `${JSON.stringify(spawnEvidence, null, 2)}\n`)

        const fireTranscript = fs.readFileSync(path.join(transcripts, "02-fire-run.jsonl"), "utf8")
        assert.doesNotMatch(fireTranscript, /run-codex-worker\.mjs/)

        const integrationBranches = run("git", ["branch", "--list", "plan-herder/integration-*", "--format=%(refname:short)"], { cwd: project }).stdout.trim().split(/\r?\n/).filter(Boolean)
        assert.equal(integrationBranches.length, 1)
        const integrationWorktree = worktreeForBranch(project, integrationBranches[0])
        run("npm", ["test"], { cwd: integrationWorktree })
        assert.equal(run("git", ["rev-parse", "HEAD"], { cwd: project }).stdout.trim(), originalHead)
        assert.equal(run("git", ["status", "--short"], { cwd: project }).stdout.trim(), "")
      } else {
        const plan = writeGrillPlan(project)
        parseJson(run("node", [manager, "validate", "herder-plans", "--pretty"], { cwd: project }).stdout, "grill fixture validation")
        const before = fs.readFileSync(plan, "utf8")

        const opened = runCodex("01-grill-question", `Use $herder:grill --plan 001. The only intentional unresolved decision is the marked output format. Follow the skill exactly: ask one question, wait, and do not edit the plan yet.`, context, { ephemeral: false })
        assert.match(opened.message, /plain|json|format|output/i)
        assert.equal(fs.readFileSync(plan, "utf8"), before, "Grill edited before receiving an answer")

        const answered = resumeCodex("02-grill-answer", opened.threadId, `Choose plain text: print only the package version followed by one newline, with no label and no JSON. Record this answer, summarize the shared understanding, and ask for final confirmation without editing yet.`, context)
        assert.match(answered.message, /confirm|apply|update|shared understanding/i)
        assert.equal(fs.readFileSync(plan, "utf8"), before, "Grill edited before final confirmation")

        const confirmed = resumeCodex("03-grill-confirm", opened.threadId, `Yes. That summary is accurate. Apply it to plan 001 and validate the backlog.`, context)
        assert.match(confirmed.message, /valid|updated|refined|plan 001/i)
        const after = fs.readFileSync(plan, "utf8")
        assert.notEqual(after, before, "Grill did not update the confirmed plan")
        assert.match(after, /plain text|package version followed by one newline/i)
        assert.doesNotMatch(after, /DECISION NEEDED/)
        parseJson(run("node", [manager, "validate", "herder-plans", "--pretty"], { cwd: project }).stdout, "refined plan validation")
        assert.equal(run("git", ["status", "--short"], { cwd: project }).stdout.trim(), "")
      }
    }

    succeeded = true
    process.stdout.write(`Herder smoke test passed\n`)
    process.stdout.write(`Plugin: ${installed.name}@${installed.version}\n`)
    process.stdout.write(`Fixture: ${options.keep ? project : "temporary (removed after success)"}\n`)
    if (options.live || options.liveFire || options.liveGrill) process.stdout.write(`Transcripts: ${transcripts}\n`)
    if (options.liveFire) process.stdout.write(`Reports: ${reports}\n`)
  } finally {
    if (createdAuthLink) {
      try {
        if (fs.lstatSync(createdAuthLink).isSymbolicLink()) fs.unlinkSync(createdAuthLink)
      } catch (error) {
        if (error.code !== "ENOENT") throw error
      }
    }
    if (succeeded && !options.keep) fs.rmSync(root, { recursive: true, force: true })
    else if (!succeeded) process.stderr.write(`Smoke artifacts preserved for debugging: ${root}\n`)
  }
}

try {
  main()
} catch (error) {
  process.stderr.write(`herder-smoke: ${error.stack || error.message}\n`)
  process.exitCode = 1
}

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
    liveShape: false,
    liveValidate: false,
    keep: false,
    workspace: "",
    authFile: process.env.HERDER_SMOKE_AUTH || path.join(os.homedir(), ".codex", "auth.json"),
  }
  for (let index = 0; index < argv.length; index += 1) {
    const argument = argv[index]
    if (argument === "--live") options.live = true
    else if (argument === "--live-fire") options.liveFire = true
    else if (argument === "--live-grill") options.liveGrill = true
    else if (argument === "--live-shape") options.liveShape = true
    else if (argument === "--live-validate") options.liveValidate = true
    else if (argument === "--keep") options.keep = true
    else if (["--workspace", "--auth-file"].includes(argument)) {
      if (index === argv.length - 1) fail(`${argument} requires a value`)
      const key = argument === "--workspace" ? "workspace" : "authFile"
      options[key] = path.resolve(argv[++index])
    } else if (["-h", "--help"].includes(argument)) {
      process.stdout.write(`Usage: node smoke-test.mjs [--live | --live-fire | --live-grill | --live-shape | --live-validate] [--keep] [--workspace <empty-dir>] [--auth-file <file>]\n`)
      process.exit(0)
    } else fail(`Unknown argument: ${argument}`)
  }
  if ([options.live, options.liveFire, options.liveGrill, options.liveShape, options.liveValidate].filter(Boolean).length > 1) {
    fail("--live, --live-fire, --live-grill, --live-shape, and --live-validate are separate test modes")
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

function writeShapeFixture(project) {
  for (const cohort of ["core", "admin"]) {
    const sourceDir = path.join(project, "src", cohort)
    const testDir = path.join(project, "test", cohort)
    fs.mkdirSync(sourceDir, { recursive: true })
    fs.mkdirSync(testDir, { recursive: true })
    for (let index = 1; index <= 6; index += 1) {
      const name = `${cohort}-${index}`
      fs.writeFileSync(path.join(sourceDir, `handler-${index}.mjs`), `export function handle() {
  return ${JSON.stringify(name)}
}
`)
    }
    fs.writeFileSync(path.join(testDir, `${cohort}.test.mjs`), `import assert from "node:assert/strict"
import test from "node:test"
${Array.from({ length: 6 }, (_, index) => `import { handle as handle${index + 1} } from "../../src/${cohort}/handler-${index + 1}.mjs"`).join("\n")}
import { dispatch } from "../../src/dispatcher.mjs"

test(${JSON.stringify(`${cohort} handlers preserve text output`)}, () => {
  const handlers = [${Array.from({ length: 6 }, (_, index) => `handle${index + 1}`).join(", ")}]
  assert.deepEqual(handlers.map(dispatch), ${JSON.stringify(Array.from({ length: 6 }, (_, index) => `${cohort}-${index + 1}`))})
})
`)
  }
  fs.writeFileSync(path.join(project, "src", "dispatcher.mjs"), `export function normalizeResult(result) {
  return typeof result === "string" ? { text: result } : result
}

export function dispatch(handler) {
  return normalizeResult(handler()).text
}
`)
  run("git", ["add", "."], { cwd: project })
  run("git", ["commit", "-q", "-m", "test: add handler migration fixture"], { cwd: project })
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
max_concurrent_threads_per_session = 6
tool_namespace = "herder_agents"

[agents]
max_depth = 1

[sandbox_workspace_write]
writable_roots = [${tomlString(codexHome)}, ${tomlString(path.join(project, ".git"))}, ${tomlString(fireRoot)}]
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
  fs.writeFileSync(readme, `# Herder Plans

## Execution order & status

| Plan | Title | Priority | Effort | Depends on | Status |
|------|-------|----------|--------|------------|--------|
| [001](001-add-version-flag.md) | Add a --version flag | P2 | S | — | TODO |

## Dependency notes

None.

## Considered and rejected

None.
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
- **Kind**: behavioral
- **Parent objective**: Expose package version metadata without changing default CLI behavior.

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

## Dependency contract

- **Consumes**: none.
- **Provides**: one exact version-output contract with unchanged default output.
- **Safe intermediate state**: the complete repository test command passes.

## Scope

**In scope**: \`package.json\`, \`src/cli.mjs\`, and \`test/cli.test.mjs\`.

**Out of scope**: dependencies, a general argument parser, aliases, and changes to no-argument output.

## Git workflow

- Branch: use the exact branch/worktree assigned by Herder Fire; never create or switch branches.
- Use one focused conventional commit.
- Do not push or open a pull request.

## Steps

### Step 1: Define the output contract

[DECISION NEEDED: choose plain version text or a JSON object.] All other behavior is fixed by this plan.

### Step 2: Implement the flag

Add package version metadata, print the chosen representation for the exact \`--version\` argument, and preserve the current no-argument path.

### Step 3: Add black-box coverage

Test the exact version output, exit code, and unchanged no-argument behavior with Node's built-in test tools.

## Test plan

Add tests for exact \`--version\` output, successful exit, and the existing no-argument greeting. Run \`npm test\` and the direct version command.

## Review map

- **Outcome**: exact version output with unchanged default output.
- **Modified symbols**: package metadata, direct CLI dispatch, and subprocess tests.
- **Direct contracts**: both supported CLI invocations.
- **Expected unchanged behavior**: the no-argument greeting.
- **Proof**: \`npm test\` and both direct commands.
- **Expected diff**: package metadata, CLI dispatch, and direct black-box coverage.

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

function writeValidatePlan(project) {
  const plan = writeGrillPlan(project)
  const plannedAt = run("git", ["rev-parse", "--short", "HEAD"], { cwd: project }).stdout.trim()
  const plannedDate = new Date().toISOString().slice(0, 10)
  fs.writeFileSync(plan, `# Plan 001: Add a --version flag

> **Executor instructions**: Follow this plan step by step. Run every verification command and confirm its expected result before continuing. Stop and report if a STOP condition occurs; do not improvise. Do not edit \`herder-plans/README.md\`; the persistent Accountant owns status transitions.
>
> **Drift check (run first)**: \`git diff --stat ${plannedAt}..HEAD -- package.json src/cli.mjs test/cli.test.mjs\`
> If an in-scope file changed, compare the Current state excerpts with the live file. Stop on a mismatch.

## Status

- **Priority**: P2
- **Effort**: S
- **Risk**: LOW
- **Depends on**: none
- **Category**: dx
- **Planned at**: commit \`${plannedAt}\`, ${plannedDate}
- **Kind**: behavioral
- **Parent objective**: Expose package version metadata without changing default CLI behavior.

## Why this matters

Users need a deterministic version string for bug reports and scripts. The exact \`--version\` output becomes a small public CLI contract while the existing no-argument greeting remains unchanged.

### Accepted decisions

- Print only \`1.0.0\` followed by exactly one newline; do not add a label or JSON wrapper.
- Store \`1.0.0\` in \`package.json\` as the single version source of truth.
- Keep the CLI dependency-free and do not introduce a general argument parser or aliases.
- Preserve the no-argument output exactly. These are explicit non-goals, not deferred work.

## Current state

- \`src/cli.mjs:1-7\` exports \`message()\`, prints \`herder-smoke\` when invoked directly, and does not inspect arguments:

  \`\`\`js
  export function message() {
    return "herder-smoke"
  }
  \`\`\`

- \`package.json:1-8\` defines an ESM, dependency-free package with \`npm test\`; it has no \`version\` field.
- \`test/cli.test.mjs:1-7\` uses \`node:test\` and strict assertions to cover \`message()\`. Match that style for new tests.
- Repository instructions in \`AGENTS.md\` require ESM style, no dependencies, and \`npm test\` verification.
- The repository has no domain glossary, context map, or ADR obligation for this isolated CLI flag.

## Commands you will need

| Purpose | Command | Expected on success |
|---|---|---|
| Tests | \`npm test\` | exits 0 and all tests pass |
| Version | \`node src/cli.mjs --version\` | prints exactly \`1.0.0\` and exits 0 |
| Greeting | \`node src/cli.mjs\` | prints exactly \`herder-smoke\` and exits 0 |

## Dependency contract

- **Consumes**: none.
- **Provides**: exact \`--version\` output with unchanged default output.
- **Safe intermediate state**: this plan owns implementation and tests, and \`npm test\` passes.

## Scope

**In scope** (the only files to modify):

- \`package.json\`
- \`src/cli.mjs\`
- \`test/cli.test.mjs\`

**Out of scope**:

- Dependencies, a general argument parser, aliases, JSON output, and labels.
- Any change to the no-argument greeting or exported \`message()\` behavior.
- Project documentation or context/ADR files; no durable terminology or architecture decision changes.

## Git workflow

- Branch: use the exact branch/worktree assigned by Herder Fire; never create or switch branches.
- Make one logical commit using the repository's observed conventional style, for example \`feat: add version flag\`.
- Do not push or open a pull request.

## Steps

### Step 1: Add the version source and exact CLI branch

Add \`"version": "1.0.0"\` to \`package.json\`. In \`src/cli.mjs\`, load that package metadata using a dependency-free ESM mechanism and, only when the sole argument is exactly \`--version\`, print the version plus one newline. Preserve the existing direct no-argument path and \`message()\` export.

**Verify**: \`node src/cli.mjs --version\` → exactly \`1.0.0\` followed by one newline; \`node src/cli.mjs\` → exactly \`herder-smoke\` followed by one newline.

### Step 2: Add black-box regression coverage

Extend \`test/cli.test.mjs\` with child-process assertions for the exact \`--version\` stdout and exit code and the unchanged no-argument stdout. Follow the file's existing \`node:test\` and strict-assertion style; add no test dependency.

**Verify**: \`npm test\` → exits 0 with the existing test and both CLI invocation cases passing.

## Test plan

- Extend \`test/cli.test.mjs\`, following its existing \`node:test\` structure.
- Cover exact version stdout \`1.0.0\\n\`, successful version exit, exact no-argument stdout \`herder-smoke\\n\`, and successful no-argument exit.
- Run \`npm test\` and both direct CLI commands; all must exit 0 with the outputs above.

## Review map

- **Outcome**: exact \`1.0.0\\n\` version output.
- **Modified symbols**: package version, direct CLI dispatch, and subprocess tests.
- **Direct contracts**: version and no-argument process behavior.
- **Expected unchanged behavior**: \`message()\` and default output.
- **Proof**: \`npm test\` plus both direct commands.
- **Expected diff**: package metadata, CLI dispatch, and direct black-box coverage.

## Done criteria

- [ ] \`npm test\` exits 0 and covers both CLI invocation paths.
- [ ] \`node src/cli.mjs --version\` exits 0 with stdout exactly \`1.0.0\\n\`.
- [ ] \`node src/cli.mjs\` exits 0 with stdout exactly \`herder-smoke\\n\`.
- [ ] \`package.json\` is the only version source and no dependency is added.
- [ ] \`git status --short\` names no modified file outside \`package.json\`, \`src/cli.mjs\`, and \`test/cli.test.mjs\`.

## STOP conditions

Stop and report rather than improvise if the drift check changes any Current state fact, package metadata cannot be loaded without a dependency, the change requires a general parser, an in-scope command fails twice after a reasonable repair, or any out-of-scope file appears necessary.

## Maintenance notes

Keep \`package.json\` as the version source of truth. Reviewers should reject duplicated version constants, extra output decoration, changes to no-argument behavior, and new parsing dependencies. Revisit these tests if the CLI later adopts a deliberate argument parser.
`)
  return plan
}

function configureSemanticDiscoveryFixture(graph) {
  assert.equal(graph.plans.length, 1)
  const plan = graph.plans[0].file
  let text = fs.readFileSync(plan, "utf8")
  const scopeStart = text.search(/^## Scope\s*$/m)
  const workflowStart = text.search(/^## Git workflow\s*$/m)
  if (scopeStart === -1 || workflowStart <= scopeStart) fail("Generated live-Fire plan has no replaceable Scope section")
  const scope = `## Scope

**In scope** (expected paths):

- \`package.json\`
- \`src/cli.mjs\`

Implementation may discover directly necessary companion documentation and
existing black-box test coverage in this same CLI subsystem. The Implementer
must justify each discovered path against the plan's documented usage and
regression-proof requirements for review.

**Out of scope**:

- Dependencies, a general argument parser, aliases, unrelated packages or
  subsystems, and changes to no-argument behavior.

`
  text = `${text.slice(0, scopeStart)}${scope}${text.slice(workflowStart)}`
  fs.writeFileSync(plan, text)
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
    if (options.liveShape) writeShapeFixture(project)
    const { env, installed } = installPlugin(codexHome, project)
    const installedPath = installed.installedPath
    const expectedSkills = ["configure", "fire", "grill", "improve", "install", "plans", "validate"]
    for (const skill of expectedSkills) {
      assert.equal(fs.existsSync(path.join(installedPath, "skills", skill, "SKILL.md")), true, `missing installed skill ${skill}`)
    }
    const expectedNicknames = {
      plan_accountant: ["Ledger", "Tally", "Abacus", "Quill", "Keeper", "Scribe", "Balance", "Audit", "Count", "Record"],
      plan_implementer: ["Mocha", "Latte", "Cortado", "Piccolo", "Doppio", "Affogato", "Espresso", "Macchiato", "Cappuccino", "Ristretto"],
      plan_reviewer: ["Kiwi", "Mango", "Peach", "Fig", "Lychee", "Yuzu", "Guava", "Cherry", "Plum", "Papaya"],
      plan_judge: ["Sage", "Atlas", "Solon", "Themis", "Verity", "Justus", "Minerva", "Cato", "Portia", "Astraea"],
      plan_saver: ["Daisy", "Poppy", "Iris", "Peony", "Aster", "Violet", "Zinnia", "Dahlia", "Lotus", "Marigold"],
    }
    for (const [profile, nicknames] of Object.entries(expectedNicknames)) {
      const profileText = fs.readFileSync(path.join(installedPath, "agent-profiles", "codex", `${profile}.toml`), "utf8")
      const declaration = `nickname_candidates = [${nicknames.map((nickname) => JSON.stringify(nickname)).join(", ")}]`
      assert.equal(profileText.includes(declaration), true, `wrong packaged nicknames for ${profile}`)
    }
    const sharedTemplate = path.join(installedPath, "skills", "plans", "references", "plan-template.md")
    assert.equal(fs.existsSync(sharedTemplate), true, "missing shared plan template")
    assert.equal(fs.existsSync(path.join(installedPath, "skills", "improve", "references", "plan-template.md")), false, "Improve still owns a private plan template")
    const sharedTemplateText = fs.readFileSync(sharedTemplate, "utf8")
    assert.match(sharedTemplateText, /### Accepted decisions/)
    assert.match(sharedTemplateText, /CONTEXT\.md/)
    assert.match(sharedTemplateText, /Producer self-review/)
    assert.match(sharedTemplateText, /never exceed 1,200/)
    assert.match(sharedTemplateText, /Mechanical validation complements self-review/)
    assert.match(sharedTemplateText, /File and line counts are never scope or reviewability criteria/)
    assert.doesNotMatch(sharedTemplateText, /files<=|file ceiling|three-file contingency/)
    assert.doesNotMatch(sharedTemplateText, /\*\*Issue\*\*/)
    const grillText = fs.readFileSync(path.join(installedPath, "skills", "grill", "SKILL.md"), "utf8")
    const improveText = fs.readFileSync(path.join(installedPath, "skills", "improve", "SKILL.md"), "utf8")
    const fireText = fs.readFileSync(path.join(installedPath, "skills", "fire", "SKILL.md"), "utf8")
    const configureText = fs.readFileSync(path.join(installedPath, "skills", "configure", "SKILL.md"), "utf8")
    const configureScript = path.join(installedPath, "skills", "configure", "scripts", "configure-herder.mjs")
    const fireProtocolText = fs.readFileSync(path.join(installedPath, "skills", "fire", "references", "orchestration-protocol.md"), "utf8")
    const validateText = fs.readFileSync(path.join(installedPath, "skills", "validate", "SKILL.md"), "utf8")
    assert.match(grillText, /herder:grill <change-description>/)
    assert.match(grillText, /Producer self-review/)
    assert.match(grillText, /resume the one-question interview/)
    assert.match(grillText, /Shape the Plan Graph/)
    assert.match(grillText, /path count alone never does/)
    assert.doesNotMatch(grillText, /files<=|file budget|three-file/)
    assert.match(improveText, /Route user intent to .*herder:grill/)
    assert.match(improveText, /Producer self-review/)
    assert.match(improveText, /impact graph/)
    assert.match(fireText, /herder:fire cleanup \[<plan-dir>\]/)
    assert.match(fireText, /--runtime native\|orca/)
    assert.match(fireText, /references\/orca-runtime\.md/)
    assert.match(fireText, /--include-failed/)
    assert.match(fireText, /--finalize/)
    assert.match(fireText, /Only the Accountant may invoke control-plane helper modes/)
    assert.match(fireText, /root coordinator owns only host-agent dispatch, waits, and user interaction/)
    assert.match(fireText, /persistent Accountant/)
    assert.match(fireText, /Keep integration history linear/)
    assert.match(fireText, /Default plan-worker parallel limit: `5`/)
    assert.match(fireText, /Reserve one additional host child slot for the persistent Accountant/)
    assert.match(fireText, /global role-agnostic pool for Implementer, Reviewer, and Judge attempts/)
    assert.match(fireText, /There is no global review lane/)
    assert.match(fireText, /one integration lock/)
    assert.match(fireText, /never as a numeric gate/)
    assert.doesNotMatch(fireText, /files<=|hard ceiling `N\+3`|three-file contingency/)
    assert.match(configureText, /Ask one focused question at a time/)
    assert.match(configureText, /live validation makes one minimal call per unique/)
    assert.match(configureText, /Do not accept an API key in chat/)
    assert.equal(fs.existsSync(configureScript), true, "missing installed Configure generator")
    assert.match(fireProtocolText, /Each plan has exactly one stable branch and at most one worktree/)
    assert.match(fireProtocolText, /herder\/<plan-name>\/integration/)
    assert.match(fireProtocolText, /git rebase --onto <integration-head> <reviewed-base>/)
    assert.match(fireProtocolText, /wait_agent.*timeout_ms: 1800000/)
    assert.match(fireProtocolText, /refs\/plan-herder\/<plan_name>\/completed\/<id>/)
    assert.match(fireProtocolText, /Do not add Herder metadata to commit subjects or bodies/)
    assert.doesNotMatch(fireProtocolText, /git commit --amend --no-edit --no-verify --trailer/)
    assert.match(fireProtocolText, /git merge --ff-only <plan-branch>/)
    assert.match(fireProtocolText, /git merge --ff-only herder\/<plan-name>\/integration/)
    assert.match(fireProtocolText, /For transient capacity, do not increment any round, retry, interruption, or clarification bound/)
    assert.match(fireProtocolText, /30, 60, 120, then 300 seconds/)
    assert.match(fireProtocolText, /at most two same-attempt non-capacity restarts/)
    assert.match(fireProtocolText, /P2\/P3, `FOLLOWUP`, and `INVALID` findings are advisory and never block integration/)
    assert.match(fireProtocolText, /exactly six possible substantive rounds/)
    assert.match(fireProtocolText, /first evidence-complete review is `DISCOVERY`.*regardless of round number/)
    assert.match(fireProtocolText, /This is the only broad review/)
    assert.match(fireProtocolText, /Assign each `NEW` finding the next stable ID/)
    assert.match(fireProtocolText, /Never reopen broad discovery/)
    assert.match(fireProtocolText, /Approval always bypasses Judge/)
    assert.match(fireProtocolText, /Reviewer nonapproval, round 3–6.*`JUDGE`/)
    assert.match(fireProtocolText, /<plan_dir>\/leak\/<source-plan-id>-<finding-id>-<slug>\.md/)
    assert.match(fireProtocolText, /DECISION: DONE \| REPAIR \| NEEDS_INPUT \| BLOCKED/)
    assert.match(fireProtocolText, /DISCOVERED_PATHS:/)
    assert.match(fireProtocolText, /number of changed or undeclared paths.*never gate the plan/)
    assert.doesNotMatch(fireProtocolText, /files<=|N\+3|hard file|8\/3\/11/)
    assert.match(fireProtocolText, /matching `worker_done` task\/dispatch\/pane provenance/)
    assert.match(fireProtocolText, /Accountant is the exclusive control-plane owner/)
    assert.match(fireProtocolText, /Default five-worker execution therefore requires child capacity of at least six/)
    assert.match(fireProtocolText, /Process `TERMINALS` as a stable batch sorted by plan, round, and role/)
    assert.match(validateText, /herder:validate \[<plan-dir>\] \[--fix\]/)
    assert.match(validateText, /herder-plans\.mjs/)
    assert.match(validateText, /strictly read-only/)
    assert.match(validateText, /Producer self-review/)
    assert.match(validateText, /Never alter `\.herder\/execution\.sqlite3`/)
    assert.match(validateText, /Never change lifecycle status/)
    const evidenceReader = path.join(installedPath, "skills", "fire", "scripts", "read-codex-agent-evidence.mjs")
    assert.equal(fs.existsSync(evidenceReader), true, "missing installed Codex Multi-Agent V2 evidence reader")
    const roundPolicy = path.join(installedPath, "skills", "fire", "scripts", "round-policy.mjs")
    assert.equal(fs.existsSync(roundPolicy), true, "missing installed six-round policy helper")
    const orcaRuntime = path.join(installedPath, "skills", "fire", "scripts", "orca-runtime.mjs")
    assert.equal(fs.existsSync(orcaRuntime), true, "missing installed Orca runtime adapter")
    const orcaProtocol = path.join(installedPath, "skills", "fire", "references", "orca-runtime.md")
    assert.equal(fs.existsSync(orcaProtocol), true, "missing installed Orca runtime protocol")
    const orcaProfile = path.join(installedPath, "skills", "fire", "references", "orca-heterogeneous-profile.json")
    assert.equal(fs.existsSync(orcaProfile), true, "missing installed heterogeneous Orca profile")
    const validatedOrcaProfile = parseJson(run("node", [
      orcaRuntime,
      "validate",
      "--profile", orcaProfile,
      "--pretty",
    ], { cwd: project }).stdout, "installed Orca profile validation")
    assert.equal(validatedOrcaProfile.profile.name, "codex-grok-pi")
    assert.equal(validatedOrcaProfile.profile.roles["plan-implementer"].model, "grok-4.5")
    assert.equal(validatedOrcaProfile.profile.roles["plan-reviewer"].model, "k3")
    assert.equal(validatedOrcaProfile.profile.roles["plan-judge"].model, "gpt-5.6-sol")
    assert.equal(validatedOrcaProfile.profile.roles["plan-saver"].harness, "grok-build")
    const configureAnswers = path.join(root, "configure-answers.json")
    fs.writeFileSync(configureAnswers, JSON.stringify({
      schemaVersion: 1,
      backend: "orca",
      name: "smoke-routing",
      roles: {
        controller: { harness: "codex", model: "gpt-5.6-sol", effort: "max" },
        "plan-implementer": { harness: "grok-build", model: "grok-4.5", effort: "high" },
        "plan-reviewer": { harness: "pi", model: "kimi-coding/k3", effort: "max" },
        "plan-judge": { harness: "pi", model: "openai/gpt-5.6-sol", effort: "max" },
        "plan-saver": { harness: "grok-build", model: "grok-4.5", effort: "high" },
      },
    }))
    const configuredRouting = parseJson(run("node", [
      configureScript,
      "validate",
      "--answers", configureAnswers,
      "--pretty",
    ], { cwd: project }).stdout, "installed Configure validation")
    assert.equal(configuredRouting.ok, true)
    assert.equal(configuredRouting.uniqueRoutes, 5)
    const checkoutGuard = path.join(installedPath, "skills", "fire", "scripts", "checkout-state.mjs")
    assert.equal(fs.existsSync(checkoutGuard), true, "missing installed Fire checkout-state guard")
    const cleanupRunner = path.join(installedPath, "skills", "fire", "scripts", "cleanup-run.mjs")
    assert.equal(fs.existsSync(cleanupRunner), true, "missing installed Fire cleanup runner")
    const namespaceRunner = path.join(installedPath, "skills", "fire", "scripts", "namespace-run.mjs")
    assert.equal(fs.existsSync(namespaceRunner), true, "missing installed Fire namespace runner")

    const manager = path.join(installedPath, "skills", "plans", "scripts", "herder-plans.mjs")
    const initialized = parseJson(run("node", [manager, "init", "herder-plans", "--pretty"], { cwd: project }).stdout, "plans init")
    assert.equal(initialized.tracking, "local")
    assert.equal(run("git", ["check-ignore", "-q", "herder-plans/README.md"], { cwd: project, allowFailure: true }).status, 0)
    const emptyGraph = parseJson(run("node", [manager, "validate", "herder-plans", "--pretty"], { cwd: project }).stdout, "empty validation")
    assert.equal(emptyGraph.counts.total, 0)
    const emptyShape = parseJson(run("node", [manager, "shape", "herder-plans", "--pretty"], { cwd: project }).stdout, "empty shape")
    assert.equal(emptyShape.shapeReady, true)
    const readmeBeforeUsage = fs.readFileSync(path.join(project, "herder-plans", "README.md"), "utf8")
    const recordedUsage = parseJson(run("node", [
      manager,
      "record-usage", "RUN", "plan-reviewer", "herder-plans",
      "--attempt", "smoke-run-reviewer-1",
      "--model", "gpt-5.6-sol",
      "--effort", "xhigh",
      "--outcome", "AVAILABLE",
      "--source", "unknown",
      "--round", "1",
      "--generation", "smoke-generation-1",
      "--runtime", "native",
      "--harness", "codex",
      "--service-tier", "standard",
      "--started-at", "2026-08-03T00:00:00Z",
      "--finished-at", "2026-08-03T00:00:01Z",
      "--duration-ms", "1000",
      "--pretty",
    ], { cwd: project }).stdout, "usage recording")
    assert.equal(recordedUsage.recorded, true)
    const usage = parseJson(run("node", [manager, "usage", "herder-plans", "--pretty"], { cwd: project }).stdout, "usage report")
    assert.equal(usage.attempts, 1)
    assert.equal(usage.byRole[0].key, "plan-reviewer")
    assert.equal(usage.byRole[0].tokenAttempts, 0)
    assert.equal(usage.storage, "sqlite")
    assert.equal(fs.readFileSync(path.join(project, "herder-plans", "README.md"), "utf8"), readmeBeforeUsage)
    assert.equal(fs.existsSync(path.join(project, "herder-plans", ".herder", "execution.sqlite3")), true)
    const executionReport = parseJson(run("node", [manager, "report", "RUN", "herder-plans", "--pretty"], { cwd: project }).stdout, "execution report")
    assert.equal(executionReport.attempts, 1)
    assert.deepEqual(executionReport.rounds, [1])
    assert.equal(executionReport.timing.attemptDurationMs, 1000)

    run("npm", ["test"], { cwd: project })

    if (options.live || options.liveFire || options.liveGrill || options.liveShape || options.liveValidate) {
      if (!fs.existsSync(options.authFile)) fail(`Codex auth file not found: ${options.authFile}`)
      const authTarget = path.join(codexHome, "auth.json")
      if (!fs.existsSync(authTarget)) {
        fs.symlinkSync(options.authFile, authTarget)
        createdAuthLink = authTarget
      }
      const context = { project, env, transcripts }

      const installMessage = runCodex("00-install", `Use $herder:install --host codex --scope user. Install the native Herder profiles into this isolated Codex home, verify Multi-Agent V2, and do not change repository source.`, context).message
      assert.match(installMessage, /multi.agent.v2|multi_agent_v2|enabled/i)
      for (const profile of ["plan_accountant", "plan_implementer", "plan_reviewer", "plan_judge", "plan_saver"]) {
        assert.equal(fs.existsSync(path.join(codexHome, "agents", `${profile}.toml`)), true, `missing installed profile ${profile}`)
      }
      const installedAccountant = fs.readFileSync(path.join(codexHome, "agents", "plan_accountant.toml"), "utf8")
      assert.match(installedAccountant, /^model = "gpt-5\.6-luna"$/m)
      assert.match(installedAccountant, /^model_reasoning_effort = "max"$/m)
      assert.match(installedAccountant, /^service_tier = "fast"$/m)
      assert.match(installedAccountant, /root exclusively owns host worker handles/)
      const installedImplementer = fs.readFileSync(path.join(codexHome, "agents", "plan_implementer.toml"), "utf8")
      assert.match(installedImplementer, /^service_tier = "fast"$/m)
      const installedReviewer = fs.readFileSync(path.join(codexHome, "agents", "plan_reviewer.toml"), "utf8")
      assert.match(installedReviewer, /sandbox_mode = "read-only"/)
      assert.match(installedReviewer, /P2\/P3, FOLLOWUP, and INVALID findings are advisory and never block approval/)
      assert.match(installedReviewer, /In every later VERIFICATION round, verify the supplied open finding IDs and inspect only the repair delta/)
      assert.match(installedReviewer, /assignment bundle inside that worktree/)
      const installedJudge = fs.readFileSync(path.join(codexHome, "agents", "plan_judge.toml"), "utf8")
      assert.match(installedJudge, /DECISION: DONE \| REPAIR \| NEEDS_INPUT \| BLOCKED/)
      assert.match(installedJudge, /Never search or read the coordinator checkout, source plan directory/)

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
        assert.equal(graph.shapeReady, true, "Grill generated a plan without the bounded review shape")
        assert.equal(parseJson(run("node", [manager, "usage", "herder-plans", "--pretty"], { cwd: project }).stdout, "preserved usage report").attempts, 1)
        assert.equal(run("git", ["status", "--short"], { cwd: project }).stdout.trim(), "")

        const plansMessage = runCodex("03-plans-status", `Use $herder:plans status herder-plans. Stay read-only and report the ready plan IDs.`, context).message
        assert.match(plansMessage, /001/)

        const fireMessage = runCodex("04-fire-status", `Use $herder:fire status herder-plans. Stay read-only, do not spawn workers, and report the ready plan IDs.`, context).message
        assert.match(fireMessage, /001/)
      } else if (options.liveFire) {
        const improveMessage = runCodex("01-improve", `Use $herder:improve plan to add a --version flag to this tiny CLI, update its existing black-box tests, and document the flag in the README usage. Write exactly one self-contained plan under herder-plans/, do not modify source code, do not ask questions, and validate the backlog before finishing.`, context).message
        assert.match(improveMessage, /herder-plans|plan/i)

        const graph = parseJson(run("node", [manager, "validate", "herder-plans", "--pretty"], { cwd: project }).stdout, "generated validation")
        assert.equal(graph.counts.total, 1)
        assert.deepEqual(graph.ready, ["001"])
        assert.equal(graph.shapeReady, true, "Improve generated a plan without the bounded semantic shape")
        configureSemanticDiscoveryFixture(graph)
        const semanticGraph = parseJson(run("node", [manager, "validate", "herder-plans", "--pretty"], { cwd: project }).stdout, "semantic-scope validation")
        assert.equal(Object.hasOwn(semanticGraph.plans[0], "reviewBudget"), false)
        assert.deepEqual(semanticGraph.plans[0].inScopePaths, ["package.json", "src/cli.mjs"])
        assert.equal(parseJson(run("node", [manager, "usage", "herder-plans", "--pretty"], { cwd: project }).stdout, "preserved usage report").attempts, 1)
        assert.equal(run("git", ["status", "--short"], { cwd: project }).stdout.trim(), "")

        const originalHead = run("git", ["rev-parse", "HEAD"], { cwd: project }).stdout.trim()
        const fireMessage = runCodex("02-fire-run", `Use $herder:fire herder-plans. Exercise the default parallel limit and execute the validated backlog end to end in this disposable repository. Use ${fireRoot} as the worktree root. Do not push or merge into the current branch. Follow the skill exactly and report the integration branch, verification, and token usage.`, context, {
          ephemeral: false,
        }).message
        assert.match(fireMessage, /completed|done|integration/i)
        assert.match(fireMessage, /ff-only|fast-forward/i, "Fire did not report the linear handoff command")
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
        assert.equal(agentEvidence.length >= 4, true, "expected persistent accountant, implementer, and reviewer sessions")
        assert.equal(agentEvidence.every((item) => item.multiAgentVersion === "v2"), true)
        assert.equal(agentEvidence.every((item) => item.userMessageCount === 0), true, "child context was not isolated")
        assert.equal(agentEvidence.every((item) => item.cwd === project), true, "child session did not inherit the intended repository context")
        assert.equal(agentEvidence.every((item) => item.usage && Number.isSafeInteger(item.usage.inputTokens)), true)
        const accountants = agentEvidence.filter((item) => item.agentRole === "plan_accountant")
        const implementers = agentEvidence.filter((item) => item.agentRole === "plan_implementer")
        const reviewers = agentEvidence.filter((item) => item.agentRole === "plan_reviewer")
        const judges = agentEvidence.filter((item) => item.agentRole === "plan_judge")
        const savers = agentEvidence.filter((item) => item.agentRole === "plan_saver")
        assert.equal(accountants.length, 1, "Fire must use exactly one persistent Accountant thread")
        assert.equal(accountants[0].taskMessageCount >= 2, true, "Accountant must receive repeated task envelopes on one persistent thread")
        assert.equal(accountants[0].model === "gpt-5.6-luna" && accountants[0].effort === "max" && accountants[0].sandbox === "workspace-write", true)
        assert.equal([...implementers, ...reviewers, ...judges, ...savers].every((item) => item.taskMessageCount === 1), true, "plan workers must receive one isolated task")
        assert.equal(implementers.length >= 1, true)
        assert.equal(reviewers.length >= 2, true)
        assert.equal(judges.length, 0, "an approving review should skip Judge")
        assert.equal(savers.length, 0, "a fresh six-round generation must not dispatch Saver")
        assert.equal(implementers.every((item) => item.model === "gpt-5.6-luna" && item.effort === "max" && item.sandbox === "workspace-write"), true)
        assert.equal(reviewers.every((item) => item.model === "gpt-5.6-sol" && item.effort === "xhigh" && item.sandbox === "workspace-write"), true)
        fs.writeFileSync(path.join(reports, "native-agent-evidence.json"), `${JSON.stringify(agentEvidence, null, 2)}\n`)

        const spawnEvidence = nativeSpawnEvidence(codexHome)
        assert.equal(spawnEvidence.length >= 4, true)
        assert.equal(spawnEvidence.every((item) => item.namespace === "herder_agents"), true)
        assert.equal(spawnEvidence.every((item) => item.encryptedMessagePresent), true)
        assert.equal(spawnEvidence.every((item) => item.arguments.fork_turns === "none"), true)
        assert.equal(spawnEvidence.every((item) => ["plan_accountant", "plan_implementer", "plan_reviewer", "plan_judge", "plan_saver"].includes(item.arguments.agent_type)), true)
        assert.equal(spawnEvidence.filter((item) => item.arguments.agent_type === "plan_accountant").length, 1)
        assert.equal(spawnEvidence.every((item) => !("model" in item.arguments) && !("reasoning_effort" in item.arguments) && !("service_tier" in item.arguments)), true)
        assert.equal(spawnEvidence.every((item) => item.coordinatorModel === "gpt-5.6-sol" && item.coordinatorEffort === "max" && item.multiAgentVersion === "v2"), true)
        fs.writeFileSync(path.join(reports, "native-spawn-evidence.json"), `${JSON.stringify(spawnEvidence, null, 2)}\n`)

        const fireTranscript = fs.readFileSync(path.join(transcripts, "02-fire-run.jsonl"), "utf8")
        assert.doesNotMatch(fireTranscript, /run-codex-worker\.mjs/)
        assert.match(fireTranscript, /plan_accountant/, "Fire did not spawn the persistent Accountant")
        const accountantTranscript = fs.readFileSync(accountants[0].transcript, "utf8")
        assert.match(accountantTranscript, /assignment-bundle\.mjs/, "Accountant did not materialize and verify worktree-local assignment context")
        assert.match(accountantTranscript, /run-gate\.mjs/, "Accountant did not isolate gate output")
        assert.match(accountantTranscript, /namespace-run\.mjs/, "Accountant did not run deterministic namespace preflight")
        assert.match(fireTranscript, /DISCOVERED_PATHS:/, "Fire did not collect implementation-discovered path evidence")

        const integrationBranches = run("git", ["branch", "--list", "herder/herder-plans/integration", "--format=%(refname:short)"], { cwd: project }).stdout.trim().split(/\r?\n/).filter(Boolean)
        assert.equal(integrationBranches.length, 1)
        const integrationBranch = integrationBranches[0]
        const changedPaths = run("git", ["diff", "--name-only", `${originalHead}..${integrationBranch}`], { cwd: project }).stdout.trim().split(/\r?\n/).filter(Boolean)
        const discoveredPaths = changedPaths.filter((changedPath) => !["package.json", "src/cli.mjs"].includes(changedPath))
        assert.equal(changedPaths.length > 2, true, "live Fire did not exercise semantic discovered-path review")
        assert.equal(discoveredPaths.length > 0, true, "live Fire did not retain a justified discovered path")
        const integrationMergeNodes = run("git", ["rev-list", "--min-parents=2", `${originalHead}..${integrationBranch}`], { cwd: project }).stdout.trim()
        assert.equal(integrationMergeNodes, "", "Fire created a merge node in the integration history")
        const integrationWorktree = worktreeForBranch(project, integrationBranch)
        run("npm", ["test"], { cwd: integrationWorktree })
        assert.equal(run("git", ["rev-parse", "HEAD"], { cwd: project }).stdout.trim(), originalHead)
        assert.equal(run("git", ["status", "--short"], { cwd: project }).stdout.trim(), "")
      } else if (options.liveGrill) {
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
        assert.match(after, /version[\s\S]{0,240}followed by\s+(?:exactly\s+)?one newline/i)
        assert.match(after, /no label|without (?:a )?label/i)
        assert.match(after, /(?:no|without)[^\n.]{0,80}JSON/i)
        assert.doesNotMatch(after, /DECISION NEEDED/)
        const refinedGraph = parseJson(run("node", [manager, "validate", "herder-plans", "--pretty"], { cwd: project }).stdout, "refined plan validation")
        assert.equal(refinedGraph.shapeReady, true, "Grill refinement lost the bounded plan shape")
        assert.equal(run("git", ["status", "--short"], { cwd: project }).stdout.trim(), "")
      } else if (options.liveShape) {
        const opened = runCodex("01-shape-intake", `Use $herder:grill to plan a safe migration in this fixture: every handler under src/core/ and src/admin/ must directly return an object with a text field, dispatch(handler) must preserve its current public string output, and the compatibility normalizer must be removed only after both caller cohorts migrate. Treat core and admin as separate independently testable cohorts, keep every subplan semantically focused on one cohort or transition, use your recommendations for remaining decisions, and do not modify source. Follow the skill exactly: inspect the repository, propose the focused plan DAG, ask for final confirmation, and do not write plans yet.`, context, { ephemeral: false })
        assert.match(opened.message, /confirm|graph|plan|cohort/i)
        const emptyBeforeConfirmation = parseJson(run("node", [manager, "validate", "herder-plans", "--pretty"], { cwd: project }).stdout, "shape pre-confirmation validation")
        assert.equal(emptyBeforeConfirmation.counts.total, 0)

        const confirmed = resumeCodex("02-shape-confirm", opened.threadId, `Yes. The objective and proposed dependency graph are accurate. Write the focused subplans, run shape and validation, and do not modify source code.`, context)
        assert.match(confirmed.message, /valid|shape|plan|graph/i)
        const graph = parseJson(run("node", [manager, "validate", "herder-plans", "--pretty"], { cwd: project }).stdout, "shape graph validation")
        assert.equal(graph.counts.total >= 3, true, "large migration was not split into focused cohort and cleanup plans")
        assert.equal(graph.shapeReady, true, "generated subplan graph is not shape-ready")
        assert.equal(graph.plans.every((plan) => plan.planWords <= 1200), true, "generated subplan exceeded prose budget")
        assert.equal(graph.plans.every((plan) => !Object.hasOwn(plan, "reviewBudget")), true, "generated graph retained numeric file budgets")
        assert.equal(graph.plans.every((plan) => plan.inScopePaths.length > 0), true, "generated subplan lacks semantic write scope")
        assert.equal(graph.plans.some((plan) => plan.dependencies.length > 0), true, "generated graph has no dependency edges")
        assert.equal(graph.overlaps.every((overlap) => overlap.ordered), true, "generated graph has unordered write-scope overlap")
        assert.equal(run("git", ["status", "--short"], { cwd: project }).stdout.trim(), "")
      } else {
        const plan = writeValidatePlan(project)
        const readme = path.join(project, "herder-plans", "README.md")
        const validGraph = parseJson(run("node", [manager, "validate", "herder-plans", "--pretty"], { cwd: project }).stdout, "Validate fixture validation")
        assert.equal(validGraph.counts.total, 1)
        assert.deepEqual(validGraph.ready, ["001"])

        const beforePlan = fs.readFileSync(plan, "utf8")
        const beforeReadme = fs.readFileSync(readme, "utf8")
        const beforeSourceStatus = run("git", ["status", "--short"], { cwd: project }).stdout
        const auditMessage = runCodex("01-validate-read-only", `Use $herder:validate herder-plans. Audit the backlog against the complete Herder contract, stay strictly read-only, and report manager status, issue counts, and Fire-readiness.`, context).message
        assert.match(auditMessage, /Fire.ready|manager|valid/i)
        assert.equal(fs.readFileSync(plan, "utf8"), beforePlan, "Validate edited a plan without --fix")
        assert.equal(fs.readFileSync(readme, "utf8"), beforeReadme, "Validate edited the index without --fix")
        assert.equal(run("git", ["status", "--short"], { cwd: project }).stdout, beforeSourceStatus, "Validate changed source without --fix")

        const brokenPlan = beforePlan.replace("## Maintenance notes", "## Maintenance guidance")
        assert.notEqual(brokenPlan, beforePlan, "Validate fixture did not contain the heading to corrupt")
        fs.writeFileSync(plan, brokenPlan)
        const brokenValidation = run("node", [manager, "validate", "herder-plans", "--pretty"], { cwd: project, allowFailure: true })
        assert.notEqual(brokenValidation.status, 0, "Corrupted Validate fixture unexpectedly passed manager validation")

        const fixMessage = runCodex("02-validate-fix", `Use $herder:validate herder-plans --fix. Repair every safe issue, preserve lifecycle status and execution-accounting data, do not touch source files, rerun validation, and report before/after counts plus Fire-readiness.`, context).message
        assert.match(fixMessage, /repair|fixed|Fire.ready|valid/i)
        const repairedPlan = fs.readFileSync(plan, "utf8")
        assert.notEqual(repairedPlan, brokenPlan, "Validate --fix did not repair the malformed plan")
        assert.match(repairedPlan, /^## Maintenance notes$/m)
        assert.doesNotMatch(repairedPlan, /^## Maintenance guidance$/m)
        const repairedGraph = parseJson(run("node", [manager, "validate", "herder-plans", "--pretty"], { cwd: project }).stdout, "repaired Validate fixture validation")
        assert.equal(repairedGraph.counts.total, 1)
        assert.deepEqual(repairedGraph.ready, ["001"])
        assert.equal(repairedGraph.shapeReady, true, "Validate repair lost the bounded plan shape")
        assert.equal(parseJson(run("node", [manager, "usage", "herder-plans", "--pretty"], { cwd: project }).stdout, "Validate usage preservation").attempts, 1)
        assert.equal(fs.readFileSync(readme, "utf8"), beforeReadme, "Validate --fix changed the plan index")
        assert.equal(run("git", ["status", "--short"], { cwd: project }).stdout, beforeSourceStatus, "Validate --fix changed source files")
      }
    }

    succeeded = true
    process.stdout.write(`Herder smoke test passed\n`)
    process.stdout.write(`Plugin: ${installed.name}@${installed.version}\n`)
    process.stdout.write(`Fixture: ${options.keep ? project : "temporary (removed after success)"}\n`)
    if (options.live || options.liveFire || options.liveGrill || options.liveShape || options.liveValidate) process.stdout.write(`Transcripts: ${transcripts}\n`)
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

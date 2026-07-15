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
    liveGrill: false,
    keep: false,
    workspace: "",
    authFile: process.env.HERDER_SMOKE_AUTH || path.join(os.homedir(), ".codex", "auth.json"),
  }
  for (let index = 0; index < argv.length; index += 1) {
    const argument = argv[index]
    if (argument === "--live") options.live = true
    else if (argument === "--live-grill") options.liveGrill = true
    else if (argument === "--keep") options.keep = true
    else if (["--workspace", "--auth-file"].includes(argument)) {
      if (index === argv.length - 1) fail(`${argument} requires a value`)
      const key = argument === "--workspace" ? "workspace" : "authFile"
      options[key] = path.resolve(argv[++index])
    } else if (["-h", "--help"].includes(argument)) {
      process.stdout.write(`Usage: node smoke-test.mjs [--live | --live-grill] [--keep] [--workspace <empty-dir>] [--auth-file <file>]\n`)
      process.exit(0)
    } else fail(`Unknown argument: ${argument}`)
  }
  if (options.live && options.liveGrill) fail("--live and --live-grill are separate test modes")
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
    "--sandbox", "workspace-write",
    "--json",
    "-C", context.project,
    prompt,
  ]
  if (ephemeral) args.splice(1, 0, "--ephemeral")
  return finishCodexStep(name, run("codex", args, { cwd: context.project, env: context.env, allowFailure: true }), context)
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
  fs.writeFileSync(path.join(planDir, "README.md"), `# Herder Plans

## Execution order & status

| Plan | Title | Priority | Effort | Depends on | Status |
|------|-------|----------|--------|------------|--------|
| [001](001-add-version-flag.md) | Add a --version flag | P2 | S | — | TODO |

## Dependency notes

None.

## Findings considered and rejected

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
  fs.mkdirSync(project, { recursive: true })
  fs.mkdirSync(codexHome, { recursive: true })

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

    const manager = path.join(installedPath, "skills", "plans", "scripts", "herder-plans.mjs")
    const initialized = parseJson(run("node", [manager, "init", "herder-plans", "--pretty"], { cwd: project }).stdout, "plans init")
    assert.equal(initialized.tracking, "local")
    assert.equal(run("git", ["check-ignore", "-q", "herder-plans/README.md"], { cwd: project, allowFailure: true }).status, 0)
    const emptyGraph = parseJson(run("node", [manager, "validate", "herder-plans", "--pretty"], { cwd: project }).stdout, "empty validation")
    assert.equal(emptyGraph.counts.total, 0)

    run("npm", ["test"], { cwd: project })

    if (options.live || options.liveGrill) {
      if (!fs.existsSync(options.authFile)) fail(`Codex auth file not found: ${options.authFile}`)
      const authTarget = path.join(codexHome, "auth.json")
      if (!fs.existsSync(authTarget)) {
        fs.symlinkSync(options.authFile, authTarget)
        createdAuthLink = authTarget
      }
      const context = { project, env, transcripts }

      if (options.live) {
        const improveMessage = runCodex("01-improve", `Use $herder:improve plan to add a --version flag to this tiny CLI. Write exactly one self-contained plan under herder-plans/, do not modify source code, do not ask questions, and validate the backlog before finishing.`, context).message
        assert.match(improveMessage, /herder-plans|plan/i)

        const graph = parseJson(run("node", [manager, "validate", "herder-plans", "--pretty"], { cwd: project }).stdout, "generated validation")
        assert.equal(graph.counts.total, 1)
        assert.deepEqual(graph.ready, ["001"])
        assert.equal(run("git", ["status", "--short"], { cwd: project }).stdout.trim(), "")

        const plansMessage = runCodex("02-plans-status", `Use $herder:plans status herder-plans. Stay read-only and report the ready plan IDs.`, context).message
        assert.match(plansMessage, /001/)

        const fireMessage = runCodex("03-fire-status", `Use $herder:fire status herder-plans. Stay read-only, do not spawn workers, and report the ready plan IDs.`, context).message
        assert.match(fireMessage, /001/)
      } else {
        const plan = writeGrillPlan(project)
        parseJson(run("node", [manager, "validate", "herder-plans", "--pretty"], { cwd: project }).stdout, "grill fixture validation")
        const before = fs.readFileSync(plan, "utf8")

        const opened = runCodex("01-grill-question", `Use $herder:grill 001. The only intentional unresolved decision is the marked output format. Follow the skill exactly: ask one question, wait, and do not edit the plan yet.`, context, { ephemeral: false })
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
    if (options.live || options.liveGrill) process.stdout.write(`Transcripts: ${transcripts}\n`)
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

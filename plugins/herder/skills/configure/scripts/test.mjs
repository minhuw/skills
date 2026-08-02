#!/usr/bin/env node

import assert from "node:assert/strict"
import { execFileSync, spawnSync } from "node:child_process"
import { chmod, mkdir, mkdtemp, readFile, readdir, rm, symlink, writeFile } from "node:fs/promises"
import { tmpdir } from "node:os"
import path from "node:path"
import process from "node:process"
import { fileURLToPath } from "node:url"

const scriptDir = path.dirname(fileURLToPath(import.meta.url))
const configure = path.join(scriptDir, "configure-herder.mjs")
const orcaRuntime = path.resolve(scriptDir, "../../fire/scripts/orca-runtime.mjs")
const root = await mkdtemp(path.join(tmpdir(), "herder-configure-test-"))
const fakeBin = path.join(root, "bin")
const fakeAgent = path.join(fakeBin, "fake-agent")

function run(args, env, options = {}) {
  return execFileSync(process.execPath, [configure, ...args], {
    encoding: "utf8",
    env,
    ...options,
  })
}

try {
  await mkdir(fakeBin)
  await writeFile(fakeAgent, `#!/usr/bin/env node
const path = require("node:path")
const name = path.basename(process.argv[1])
const args = process.argv.slice(2)
if (process.env.HERDER_TEST_FAIL === name && !args.includes("--version") && !args.includes("models") && !args.includes("--list-models")) {
  process.stdout.write("SUPERSECRET-MUST-NOT-LEAK\\n")
  process.exit(9)
}
if (name === "codex" && args.includes("--version")) process.stdout.write("codex-cli 1.0.0\\n")
else if (name === "codex") process.stdout.write('{"type":"item.completed","text":"HERDER_CONFIG_OK"}\\n')
else if (name === "grok" && args[0] === "models") process.stdout.write("grok-4.5\\n")
else if (name === "grok") process.stdout.write("HERDER_CONFIG_OK\\n")
else if (name === "pi" && args.includes("--list-models")) process.stdout.write(args.at(-1) + "\\n")
else if (name === "pi") process.stdout.write("HERDER_CONFIG_OK\\n")
else process.exit(2)
`)
  await chmod(fakeAgent, 0o700)
  for (const name of ["codex", "grok", "pi"]) await symlink(fakeAgent, path.join(fakeBin, name))
  const env = {
    ...process.env,
    HERDER_CONFIG_CODEX_BIN: path.join(fakeBin, "codex"),
    HERDER_CONFIG_GROK_BIN: path.join(fakeBin, "grok"),
    HERDER_CONFIG_PI_BIN: path.join(fakeBin, "pi"),
  }

  const orcaAnswers = {
    schemaVersion: 1,
    backend: "orca",
    name: "test-routing",
    roles: {
      controller: { harness: "codex", model: "gpt-5.6-sol", effort: "max" },
      "plan-implementer": { harness: "grok-build", model: "grok-4.5", effort: "high" },
      "plan-reviewer": { harness: "pi", model: "kimi-coding/k3", effort: "max" },
      "plan-judge": { harness: "pi", model: "openai/gpt-5.6-sol", effort: "max" },
      "plan-saver": { harness: "grok-build", model: "grok-4.5", effort: "high" },
    },
  }
  const orcaAnswersPath = path.join(root, "orca-answers.json")
  await writeFile(orcaAnswersPath, JSON.stringify(orcaAnswers))

  const validated = JSON.parse(run(["validate", "--answers", orcaAnswersPath], env))
  assert.equal(validated.ok, true)
  assert.equal(validated.backend, "orca")
  assert.equal(validated.uniqueRoutes, 4)

  const availability = JSON.parse(run(["probe", "--answers", orcaAnswersPath], env))
  assert.equal(availability.ok, true)
  assert.equal(availability.results.length, 4)
  assert.equal(availability.results.every((result) => /^[a-f0-9]{64}$/.test(result.outputSha256)), true)

  const live = JSON.parse(run(["probe", "--answers", orcaAnswersPath, "--live"], env))
  assert.equal(live.ok, true)
  assert.equal(live.results.every((result) => result.mode === "live"), true)

  const profilePath = path.join(root, ".herder", "orca-runtime.json")
  const generated = JSON.parse(run(["generate", "--answers", orcaAnswersPath, "--output", profilePath], env))
  assert.equal(generated.ok, true)
  assert.equal(generated.backend, "orca")
  assert.equal(generated.changed, true)
  const profile = JSON.parse(await readFile(profilePath, "utf8"))
  assert.equal(profile.roles["plan-saver"].harness, "grok-build")
  assert.deepEqual(profile.roles["plan-reviewer"].command.slice(-2), ["--tools", "read,bash,grep,find,ls"])
  assert.equal(profile.roles["plan-implementer"].command.includes("--always-approve"), true)
  execFileSync(process.execPath, [orcaRuntime, "validate", "--profile", profilePath])

  const alternateAnswers = structuredClone(orcaAnswers)
  alternateAnswers.name = "alternate-routing"
  alternateAnswers.roles.controller = { harness: "codex", model: "gpt-5.6-luna", effort: "max" }
  alternateAnswers.roles["plan-reviewer"] = { harness: "codex", model: "gpt-5.6-luna", effort: "xhigh" }
  alternateAnswers.roles["plan-judge"] = { harness: "grok-build", model: "grok-4.5", effort: "high" }
  alternateAnswers.roles["plan-saver"] = { harness: "pi", model: "openai/gpt-5.6-sol", effort: "max" }
  const alternateAnswersPath = path.join(root, "alternate-answers.json")
  const alternateProfilePath = path.join(root, ".herder", "alternate-runtime.json")
  await writeFile(alternateAnswersPath, JSON.stringify(alternateAnswers))
  run(["generate", "--answers", alternateAnswersPath, "--output", alternateProfilePath], env)
  const alternateProfile = JSON.parse(await readFile(alternateProfilePath, "utf8"))
  assert.equal(alternateProfile.roles.controller.command.includes('service_tier="fast"'), false)
  assert.equal(alternateProfile.roles["plan-reviewer"].command.includes("read-only"), true)
  assert.equal(alternateProfile.roles["plan-reviewer"].command.includes('service_tier="fast"'), true)
  assert.equal(alternateProfile.roles["plan-judge"].command.includes("plan"), true)
  assert.equal(alternateProfile.roles["plan-saver"].command.some((argument) => argument.includes("edit,write")), true)
  execFileSync(process.execPath, [orcaRuntime, "validate", "--profile", alternateProfilePath])

  const unchanged = JSON.parse(run(["generate", "--answers", orcaAnswersPath, "--output", profilePath], env))
  assert.equal(unchanged.changed, false)
  await writeFile(profilePath, "{}\n")
  const conflict = spawnSync(process.execPath, [configure, "generate", "--answers", orcaAnswersPath, "--output", profilePath], {
    encoding: "utf8",
    env,
  })
  assert.equal(conflict.status, 1)
  assert.match(conflict.stderr, /Destination differs/)
  const replaced = JSON.parse(run(["generate", "--answers", orcaAnswersPath, "--output", profilePath, "--force"], env))
  assert.equal(replaced.backups.length, 1)
  assert.equal(await readFile(replaced.backups[0], "utf8"), "{}\n")

  const unsupported = structuredClone(orcaAnswers)
  unsupported.roles["plan-saver"].harness = "amp"
  const unsupportedPath = path.join(root, "unsupported.json")
  await writeFile(unsupportedPath, JSON.stringify(unsupported))
  const unsupportedResult = spawnSync(process.execPath, [configure, "validate", "--answers", unsupportedPath], {
    encoding: "utf8",
    env,
  })
  assert.equal(unsupportedResult.status, 1)
  assert.match(unsupportedResult.stderr, /Unsupported harness/)

  const wrongController = structuredClone(orcaAnswers)
  wrongController.roles.controller = { harness: "grok-build", model: "grok-4.5", effort: "high" }
  const wrongControllerPath = path.join(root, "wrong-controller.json")
  await writeFile(wrongControllerPath, JSON.stringify(wrongController))
  const wrongControllerResult = spawnSync(process.execPath, [configure, "validate", "--answers", wrongControllerPath], {
    encoding: "utf8",
    env,
  })
  assert.equal(wrongControllerResult.status, 1)
  assert.match(wrongControllerResult.stderr, /controller harness must be codex/)

  const barePi = structuredClone(orcaAnswers)
  barePi.roles["plan-reviewer"].model = "k3"
  const barePiPath = path.join(root, "bare-pi.json")
  await writeFile(barePiPath, JSON.stringify(barePi))
  const barePiResult = spawnSync(process.execPath, [configure, "validate", "--answers", barePiPath], {
    encoding: "utf8",
    env,
  })
  assert.equal(barePiResult.status, 1)
  assert.match(barePiResult.stderr, /provider\/model/)

  const failedProbe = spawnSync(process.execPath, [configure, "probe", "--answers", orcaAnswersPath, "--live"], {
    encoding: "utf8",
    env: { ...env, HERDER_TEST_FAIL: "grok" },
  })
  assert.equal(failedProbe.status, 4)
  assert.doesNotMatch(`${failedProbe.stdout}\n${failedProbe.stderr}`, /SUPERSECRET/)
  const failedEvidence = JSON.parse(failedProbe.stdout)
  assert.equal(failedEvidence.ok, false)
  assert.equal(failedEvidence.results.find((result) => result.harness === "grok-build").status, "failed")

  const nativeAnswers = structuredClone(orcaAnswers)
  nativeAnswers.backend = "native-codex"
  delete nativeAnswers.name
  for (const role of Object.keys(nativeAnswers.roles)) {
    const luna = ["plan-reviewer", "plan-judge"].includes(role)
    nativeAnswers.roles[role] = {
      harness: "codex",
      model: luna ? "gpt-5.6-luna" : "gpt-5.6-sol",
      effort: luna ? "high" : "max",
    }
  }
  const nativeAnswersPath = path.join(root, "native-answers.json")
  await writeFile(nativeAnswersPath, JSON.stringify(nativeAnswers))
  const nativeValidated = JSON.parse(run(["validate", "--answers", nativeAnswersPath], env))
  assert.equal(nativeValidated.backend, "native-codex")
  assert.equal(nativeValidated.uniqueRoutes, 2)
  assert.equal(JSON.parse(run(["probe", "--answers", nativeAnswersPath, "--live"], env)).ok, true)

  const agentDir = path.join(root, "project", ".codex", "agents")
  const nativeGenerated = JSON.parse(run(["generate", "--answers", nativeAnswersPath, "--output", agentDir], env))
  assert.equal(nativeGenerated.files.length, 4)
  assert.equal(nativeGenerated.newSessionRequired, true)
  const implementer = await readFile(path.join(agentDir, "plan_implementer.toml"), "utf8")
  const reviewer = await readFile(path.join(agentDir, "plan_reviewer.toml"), "utf8")
  const judge = await readFile(path.join(agentDir, "plan_judge.toml"), "utf8")
  assert.match(implementer, /^model = "gpt-5\.6-sol"$/m)
  assert.match(implementer, /^model_reasoning_effort = "max"$/m)
  assert.doesNotMatch(implementer, /^service_tier\s*=/m)
  assert.match(reviewer, /^model = "gpt-5\.6-luna"$/m)
  assert.match(reviewer, /^service_tier = "fast"$/m)
  assert.match(judge, /^service_tier = "fast"$/m)

  await writeFile(path.join(agentDir, "plan_saver.toml"), "custom\n")
  const nativeConflict = spawnSync(process.execPath, [
    configure,
    "generate",
    "--answers", nativeAnswersPath,
    "--output", agentDir,
  ], { encoding: "utf8", env })
  assert.equal(nativeConflict.status, 1)
  const nativeForced = JSON.parse(run([
    "generate",
    "--answers", nativeAnswersPath,
    "--output", agentDir,
    "--force",
  ], env))
  assert.equal(nativeForced.backups.length, 1)
  assert.equal(await readFile(nativeForced.backups[0], "utf8"), "custom\n")
  assert.deepEqual((await readdir(agentDir)).sort(), [
    "plan_implementer.toml",
    "plan_judge.toml",
    "plan_reviewer.toml",
    "plan_saver.toml",
  ])

  console.log("herder Configure tests passed")
} finally {
  await rm(root, { recursive: true, force: true })
}

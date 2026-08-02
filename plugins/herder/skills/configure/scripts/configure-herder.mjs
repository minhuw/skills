#!/usr/bin/env node

import { createHash, randomBytes } from "node:crypto"
import { spawnSync } from "node:child_process"
import {
  accessSync,
  constants as fsConstants,
  copyFileSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  renameSync,
  rmSync,
  writeFileSync,
} from "node:fs"
import { tmpdir } from "node:os"
import path from "node:path"
import process from "node:process"
import { fileURLToPath } from "node:url"

const SCRIPT_DIR = path.dirname(fileURLToPath(import.meta.url))
const PLUGIN_ROOT = path.resolve(SCRIPT_DIR, "../../..")
const ORCA_RUNTIME = path.join(PLUGIN_ROOT, "skills/fire/scripts/orca-runtime.mjs")
const ROLES = ["controller", "plan-implementer", "plan-reviewer", "plan-judge", "plan-saver"]
const CHILD_ROLES = ROLES.filter((role) => role !== "controller")
const MUTATES = {
  controller: true,
  "plan-implementer": true,
  "plan-reviewer": false,
  "plan-judge": false,
  "plan-saver": true,
}
const AGENT_FILES = {
  "plan-implementer": "plan_implementer.toml",
  "plan-reviewer": "plan_reviewer.toml",
  "plan-judge": "plan_judge.toml",
  "plan-saver": "plan_saver.toml",
}
const EFFORTS = {
  codex: new Set(["low", "medium", "high", "xhigh", "max"]),
  "grok-build": new Set(["low", "medium", "high"]),
  pi: new Set(["off", "minimal", "low", "medium", "high", "xhigh", "max"]),
}
const BINARIES = {
  codex: process.env.HERDER_CONFIG_CODEX_BIN || "codex",
  "grok-build": process.env.HERDER_CONFIG_GROK_BIN || "grok",
  pi: process.env.HERDER_CONFIG_PI_BIN || "pi",
}
const MARKER = "HERDER_CONFIG_OK"
const MODEL_PATTERN = /^[A-Za-z0-9][A-Za-z0-9._:+/-]*$/

class UsageError extends Error {}

function fail(message) {
  throw new Error(message)
}

function sha256(value) {
  return createHash("sha256").update(value).digest("hex")
}

function stableJson(value) {
  if (Array.isArray(value)) return `[${value.map(stableJson).join(",")}]`
  if (value && typeof value === "object") {
    return `{${Object.keys(value).sort().map((key) => `${JSON.stringify(key)}:${stableJson(value[key])}`).join(",")}}`
  }
  return JSON.stringify(value)
}

function exists(file) {
  try {
    accessSync(file, fsConstants.F_OK)
    return true
  } catch {
    return false
  }
}

function parseArgs(argv) {
  const command = argv[0]
  if (!command || ["-h", "--help"].includes(command)) return { help: true }
  if (!["validate", "probe", "generate"].includes(command)) throw new UsageError(`Unknown command: ${command}`)
  const options = {
    command,
    answers: "",
    output: "",
    force: false,
    live: false,
    pretty: false,
  }
  for (let index = 1; index < argv.length; index += 1) {
    const argument = argv[index]
    if (argument === "--force") options.force = true
    else if (argument === "--live") options.live = true
    else if (argument === "--pretty") options.pretty = true
    else if (["--answers", "--output"].includes(argument)) {
      const value = argv[index + 1]
      if (!value || value.startsWith("--")) throw new UsageError(`${argument} requires a value`)
      index += 1
      if (argument === "--answers") options.answers = value
      else options.output = value
    } else throw new UsageError(`Unknown argument: ${argument}`)
  }
  if (!options.answers) throw new UsageError("--answers is required")
  if (command === "generate" && !options.output) throw new UsageError("--output is required for generate")
  if (command !== "generate" && options.force) throw new UsageError("--force is valid only with generate")
  if (command !== "probe" && options.live) throw new UsageError("--live is valid only with probe")
  return options
}

function usage() {
  return `Usage:
  configure-herder.mjs validate --answers <json> [--pretty]
  configure-herder.mjs probe --answers <json> [--live] [--pretty]
  configure-herder.mjs generate --answers <json> --output <path> [--force] [--pretty]
`
}

function readAnswers(file) {
  const answersPath = path.resolve(file)
  let parsed
  try {
    parsed = JSON.parse(readFileSync(answersPath, "utf8"))
  } catch (error) {
    fail(`Cannot read answers file ${answersPath}: ${error.message}`)
  }
  if (parsed.schemaVersion !== 1) fail(`Unsupported answers schema: ${JSON.stringify(parsed.schemaVersion)}`)
  if (!["orca", "native-codex"].includes(parsed.backend)) {
    fail('backend must be "orca" or "native-codex"')
  }
  if (parsed.backend === "orca" && (typeof parsed.name !== "string" || !/^[a-z0-9][a-z0-9-]{0,63}$/.test(parsed.name))) {
    fail("Orca profile name must be lowercase Git-safe text with at most 64 characters")
  }
  if (!parsed.roles || typeof parsed.roles !== "object" || Array.isArray(parsed.roles)) fail("roles must be an object")
  const unknownRoles = Object.keys(parsed.roles).filter((role) => !ROLES.includes(role))
  if (unknownRoles.length > 0) fail(`Unknown roles: ${unknownRoles.join(", ")}`)
  const roles = {}
  for (const roleName of ROLES) {
    const input = parsed.roles[roleName]
    if (!input || typeof input !== "object" || Array.isArray(input)) fail(`Missing role: ${roleName}`)
    const { harness, model, effort } = input
    if (!Object.hasOwn(EFFORTS, harness)) fail(`Unsupported harness for ${roleName}: ${JSON.stringify(harness)}`)
    if (parsed.backend === "native-codex" && harness !== "codex") {
      fail(`native-codex requires harness codex for ${roleName}`)
    }
    if (parsed.backend === "orca" && roleName === "controller" && harness !== "codex") {
      fail("Orca controller harness must be codex")
    }
    if (typeof model !== "string" || !MODEL_PATTERN.test(model)) fail(`Invalid model for ${roleName}`)
    if (!EFFORTS[harness].has(effort)) fail(`Invalid ${harness} effort for ${roleName}: ${JSON.stringify(effort)}`)
    if (harness === "pi" && !/^[^/]+\/[^/]+$/.test(model)) {
      fail(`${roleName} Pi model must be provider/model`)
    }
    roles[roleName] = { harness, model, effort }
  }
  const normalized = {
    schemaVersion: 1,
    backend: parsed.backend,
    ...(parsed.backend === "orca" ? { name: parsed.name } : {}),
    roles,
  }
  return {
    answers: normalized,
    answersPath,
    answersHash: sha256(stableJson(normalized)),
  }
}

function piRoute(model) {
  const slash = model.indexOf("/")
  return { provider: model.slice(0, slash), model: model.slice(slash + 1) }
}

function isLunaModel(model) {
  return model.toLowerCase().endsWith("-luna")
}

function childUsesFastTier(roleName, mapping) {
  return roleName !== "controller" && mapping.harness === "codex" && isLunaModel(mapping.model)
}

function orcaRole(roleName, mapping) {
  const mutates = MUTATES[roleName]
  if (mapping.harness === "codex") {
    const command = [
      "codex",
      "--model", mapping.model,
      "-c", `model_reasoning_effort="${mapping.effort}"`,
    ]
    if (childUsesFastTier(roleName, mapping)) command.push("-c", 'service_tier="fast"')
    if (mutates) command.push("--dangerously-bypass-approvals-and-sandbox")
    else command.push("--sandbox", "read-only", "--ask-for-approval", "never")
    return {
      harness: "codex",
      provider: "openai-codex",
      model: mapping.model,
      effort: mapping.effort,
      mutates,
      command,
      ...(roleName === "controller" ? {} : {
        probe: ["codex", "--version"],
        probeIncludes: "codex-cli",
      }),
    }
  }
  if (mapping.harness === "grok-build") {
    const command = [
      "grok",
      "--model", mapping.model,
      "--effort", mapping.effort,
      ...(mutates ? ["--always-approve"] : ["--permission-mode", "plan"]),
      "--no-subagents",
      "--no-auto-update",
    ]
    return {
      harness: "grok-build",
      provider: "xai",
      model: mapping.model,
      effort: mapping.effort,
      mutates,
      command,
      probe: ["grok", "models"],
      probeIncludes: mapping.model,
    }
  }
  const route = piRoute(mapping.model)
  return {
    harness: "pi",
    provider: route.provider,
    model: route.model,
    effort: mapping.effort,
    mutates,
    command: [
      "pi",
      "--model", mapping.model,
      "--thinking", mapping.effort,
      "--approve",
      "--no-skills",
      "--no-prompt-templates",
      "--tools", mutates ? "read,bash,edit,write,grep,find,ls" : "read,bash,grep,find,ls",
    ],
    probe: ["pi", "--list-models", mapping.model],
    probeIncludes: route.model,
  }
}

function buildOrcaProfile(answers) {
  return {
    schemaVersion: 1,
    name: answers.name,
    runtime: "orca",
    controllerInOrca: true,
    roles: Object.fromEntries(ROLES.map((role) => [role, orcaRole(role, answers.roles[role])])),
  }
}

function validateOrcaProfile(profile) {
  const root = mkdtempSync(path.join(tmpdir(), "herder-config-profile-"))
  try {
    const candidate = path.join(root, "profile.json")
    writeFileSync(candidate, `${JSON.stringify(profile, null, 2)}\n`, { flag: "wx", mode: 0o600 })
    const result = spawnSync(process.execPath, [ORCA_RUNTIME, "validate", "--profile", candidate], {
      encoding: "utf8",
      stdio: ["ignore", "pipe", "pipe"],
    })
    if (result.status !== 0) fail(`Generated Orca profile is invalid; validator_output_sha256=${sha256(`${result.stdout}\0${result.stderr}`)}`)
  } finally {
    rmSync(root, { recursive: true, force: true })
  }
}

function replaceTomlValue(text, key, value, label) {
  const expression = new RegExp(`^${key}\\s*=.*$`, "m")
  const matches = text.match(new RegExp(expression.source, "gm")) || []
  if (matches.length !== 1) fail(`Bundled ${label} must contain exactly one ${key}`)
  return text.replace(expression, `${key} = ${JSON.stringify(value)}`)
}

function setNativeServiceTier(text, model, label) {
  const expression = /^service_tier\s*=.*$/gm
  const matches = text.match(expression) || []
  if (matches.length > 1) fail(`Bundled ${label} must contain at most one service_tier`)
  if (!isLunaModel(model)) {
    return text.replace(/^service_tier\s*=.*(?:\r?\n|$)/m, "")
  }
  if (matches.length === 1) return text.replace(/^service_tier\s*=.*$/m, 'service_tier = "fast"')
  return text.replace(/^model\s*=.*$/m, (line) => `${line}\nservice_tier = "fast"`)
}

function buildNativeProfiles(answers) {
  const files = {}
  for (const role of CHILD_ROLES) {
    const filename = AGENT_FILES[role]
    const source = path.join(PLUGIN_ROOT, "agent-profiles/codex", filename)
    let text = readFileSync(source, "utf8")
    text = replaceTomlValue(text, "model", answers.roles[role].model, filename)
    text = replaceTomlValue(text, "model_reasoning_effort", answers.roles[role].effort, filename)
    text = setNativeServiceTier(text, answers.roles[role].model, filename)
    files[filename] = text
  }
  const controller = answers.roles.controller
  return {
    files,
    controllerCommand: [
      "codex",
      "--model", controller.model,
      "-c", `model_reasoning_effort="${controller.effort}"`,
    ],
  }
}

function routeIdentity(mapping) {
  const provider = mapping.harness === "pi" ? piRoute(mapping.model).provider : (
    mapping.harness === "codex" ? "openai-codex" : "xai"
  )
  return `${mapping.harness}\0${provider}\0${mapping.model}\0${mapping.effort}`
}

function uniqueRoutes(answers) {
  const routes = new Map()
  for (const role of ROLES) {
    const mapping = answers.roles[role]
    const key = routeIdentity(mapping)
    if (!routes.has(key)) routes.set(key, { ...mapping, roles: [] })
    routes.get(key).roles.push(role)
  }
  return [...routes.values()]
}

function runProbe(route, live) {
  const binary = BINARIES[route.harness]
  let args
  let expected
  if (!live && route.harness === "codex") {
    args = ["--version"]
    expected = /codex/i
  } else if (!live && route.harness === "grok-build") {
    args = ["models"]
    expected = route.model
  } else if (!live) {
    args = ["--list-models", route.model]
    expected = piRoute(route.model).model
  } else if (route.harness === "codex") {
    args = [
      "exec",
      "--ephemeral",
      "--skip-git-repo-check",
      "--ignore-rules",
      "--sandbox", "read-only",
      "--ask-for-approval", "never",
      "--model", route.model,
      "-c", `model_reasoning_effort="${route.effort}"`,
      ...(route.roles.some((role) => role !== "controller") && isLunaModel(route.model)
        ? ["-c", 'service_tier="fast"']
        : []),
      "--json",
      `Return exactly ${MARKER}.`,
    ]
    expected = MARKER
  } else if (route.harness === "grok-build") {
    args = [
      "--model", route.model,
      "--effort", route.effort,
      "--single", `Return exactly ${MARKER}.`,
      "--permission-mode", "plan",
      "--no-subagents",
      "--no-memory",
      "--disable-web-search",
      "--verbatim",
      "--output-format", "plain",
    ]
    expected = MARKER
  } else {
    args = [
      "--model", route.model,
      "--thinking", route.effort,
      "--approve",
      "--no-skills",
      "--no-prompt-templates",
      "--no-context-files",
      "--tools", "read,grep,find,ls",
      "--no-session",
      "--print",
      `Return exactly ${MARKER}.`,
    ]
    expected = MARKER
  }
  const probeRoot = live ? mkdtempSync(path.join(tmpdir(), "herder-route-probe-")) : process.cwd()
  let result
  try {
    result = spawnSync(binary, args, {
      cwd: probeRoot,
      encoding: "utf8",
      stdio: ["ignore", "pipe", "pipe"],
      timeout: live ? 300000 : 60000,
    })
  } finally {
    if (live) rmSync(probeRoot, { recursive: true, force: true })
  }
  const output = `${result.stdout || ""}\0${result.stderr || ""}`
  const matched = expected instanceof RegExp ? expected.test(output) : output.includes(expected)
  const ok = result.status === 0 && !result.error && matched
  const provider = route.harness === "pi" ? piRoute(route.model).provider : (
    route.harness === "codex" ? "openai-codex" : "xai"
  )
  return {
    harness: route.harness,
    provider,
    model: route.model,
    effort: route.effort,
    roles: route.roles,
    mode: live ? "live" : "availability",
    status: ok ? "passed" : "failed",
    exitCode: Number.isInteger(result.status) ? result.status : null,
    outputSha256: sha256(output),
    ...(ok ? {} : {
      remediation: route.harness === "codex"
        ? "Run codex login and verify the selected account/model."
        : route.harness === "grok-build"
          ? "Run grok login, then grok models."
          : `Run pi, use /login, then verify pi list and pi --list-models ${route.model}.`,
    }),
  }
}

function probe(answers, live) {
  const results = uniqueRoutes(answers).map((route) => runProbe(route, live))
  return {
    ok: results.every((result) => result.status === "passed"),
    backend: answers.backend,
    mode: live ? "live" : "availability",
    results,
  }
}

function backupStamp() {
  return new Date().toISOString().replace(/[:.]/g, "-")
}

function atomicWrite(file, content, mode = 0o600) {
  mkdirSync(path.dirname(file), { recursive: true })
  const temporary = path.join(path.dirname(file), `.${path.basename(file)}.tmp-${process.pid}-${randomBytes(5).toString("hex")}`)
  writeFileSync(temporary, content, { flag: "wx", mode })
  renameSync(temporary, file)
}

function writeOrcaProfile(profile, output, force) {
  const destination = path.resolve(output)
  const content = `${JSON.stringify(profile, null, 2)}\n`
  const backups = []
  if (exists(destination)) {
    const current = readFileSync(destination, "utf8")
    if (current === content) return { files: [destination], backups, changed: false }
    if (!force) fail(`Destination differs; rerun only after explicit overwrite approval: ${destination}`)
    const backup = `${destination}.backup-${backupStamp()}`
    copyFileSync(destination, backup, fsConstants.COPYFILE_EXCL)
    backups.push(backup)
  }
  atomicWrite(destination, content)
  return { files: [destination], backups, changed: true }
}

function writeNativeProfiles(rendered, output, force) {
  const destination = path.resolve(output)
  const entries = Object.entries(rendered.files)
  const conflicts = entries.filter(([filename, content]) => {
    const target = path.join(destination, filename)
    return exists(target) && readFileSync(target, "utf8") !== content
  })
  if (conflicts.length > 0 && !force) {
    fail(`Native Codex profiles differ; rerun only after explicit overwrite approval: ${conflicts.map(([name]) => name).join(", ")}`)
  }
  const backups = []
  if (conflicts.length > 0) {
    const backupRoot = path.join(path.dirname(destination), ".plan-herder-backups", `configure-${backupStamp()}`)
    mkdirSync(backupRoot, { recursive: true })
    for (const [filename] of conflicts) {
      const backup = path.join(backupRoot, filename)
      copyFileSync(path.join(destination, filename), backup, fsConstants.COPYFILE_EXCL)
      backups.push(backup)
    }
  }
  const files = []
  let changed = false
  for (const [filename, content] of entries) {
    const target = path.join(destination, filename)
    files.push(target)
    if (exists(target) && readFileSync(target, "utf8") === content) continue
    atomicWrite(target, content)
    changed = true
  }
  return { files, backups, changed }
}

function generate(loaded, output, force) {
  if (loaded.answers.backend === "orca") {
    const profile = buildOrcaProfile(loaded.answers)
    validateOrcaProfile(profile)
    return {
      ok: true,
      backend: "orca",
      answersHash: loaded.answersHash,
      profileHash: sha256(stableJson(profile)),
      ...writeOrcaProfile(profile, output, force),
      controllerCommand: profile.roles.controller.command,
    }
  }
  const rendered = buildNativeProfiles(loaded.answers)
  return {
    ok: true,
    backend: "native-codex",
    answersHash: loaded.answersHash,
    ...writeNativeProfiles(rendered, output, force),
    controllerCommand: rendered.controllerCommand,
    newSessionRequired: true,
  }
}

function emit(value, pretty) {
  process.stdout.write(`${JSON.stringify(value, null, pretty ? 2 : 0)}\n`)
}

function main() {
  const options = parseArgs(process.argv.slice(2))
  if (options.help) {
    process.stdout.write(usage())
    return
  }
  const loaded = readAnswers(options.answers)
  if (options.command === "validate") {
    if (loaded.answers.backend === "orca") validateOrcaProfile(buildOrcaProfile(loaded.answers))
    else buildNativeProfiles(loaded.answers)
    emit({
      ok: true,
      backend: loaded.answers.backend,
      answersHash: loaded.answersHash,
      roles: loaded.answers.roles,
      uniqueRoutes: uniqueRoutes(loaded.answers).length,
    }, options.pretty)
    return
  }
  if (options.command === "probe") {
    const result = probe(loaded.answers, options.live)
    emit(result, options.pretty)
    if (!result.ok) process.exitCode = 4
    return
  }
  emit(generate(loaded, options.output, options.force), options.pretty)
}

try {
  main()
} catch (error) {
  const prefix = error instanceof UsageError ? "Usage error" : "Error"
  process.stderr.write(`${prefix}: ${error.message}\n`)
  if (error instanceof UsageError) process.stderr.write(usage())
  process.exitCode = error instanceof UsageError ? 2 : 1
}

#!/usr/bin/env node

import fs from "node:fs"
import path from "node:path"
import process from "node:process"
import { spawnSync } from "node:child_process"
import { fileURLToPath } from "node:url"

const DEFAULT_PLAN_DIR = "herder-plans"
const TERMINAL = new Set(["DONE", "REJECTED"])
const ACTIONABLE = new Set(["TODO", "IN PROGRESS", "BLOCKED"])
const SUPPORTED_STATUSES = new Set([...TERMINAL, ...ACTIONABLE])
const REQUIRED_PLAN_HEADINGS = [
  "Status",
  "Why this matters",
  "Current state",
  "Commands you will need",
  "Scope",
  "Steps",
  "Test plan",
  "Done criteria",
  "STOP conditions",
  "Maintenance notes",
]
const REQUIRED_PLAN_METADATA = ["Priority", "Effort", "Risk", "Depends on", "Category", "Planned at"]
const REQUIRED_INDEX_HEADERS = ["plan", "title", "priority", "effort", "depends on", "status"]
const TRANSITIONS = new Map([
  ["TODO", new Set(["IN PROGRESS", "BLOCKED", "REJECTED"])],
  ["IN PROGRESS", new Set(["TODO", "DONE", "BLOCKED", "REJECTED"])],
  ["BLOCKED", new Set(["TODO", "IN PROGRESS", "REJECTED"])],
  ["DONE", new Set(["BLOCKED"])],
  ["REJECTED", new Set(["TODO"])],
])

function fail(message) {
  throw new Error(message)
}

function parseTableRow(line) {
  const trimmed = line.trim()
  if (!trimmed.includes("|")) return null
  const body = trimmed.replace(/^\|/, "").replace(/\|$/, "")
  return body.split("|").map((cell) => cell.trim())
}

function normalizeHeader(value) {
  return value.toLowerCase().replace(/[`*_]/g, "").replace(/\s+/g, " ").trim()
}

function isSeparatorRow(cells) {
  return cells.length > 0 && cells.every((cell) => /^:?-{3,}:?$/.test(cell.replace(/\s/g, "")))
}

function canonicalId(value, context = "plan ID") {
  const match = String(value).match(/\b(\d+)\b/)
  if (!match) fail(`Cannot find a numeric plan ID in ${context}: ${JSON.stringify(value)}`)
  const numeric = Number.parseInt(match[1], 10)
  if (!Number.isSafeInteger(numeric)) fail(`Invalid plan ID in ${context}: ${JSON.stringify(value)}`)
  return String(numeric).padStart(3, "0")
}

function parseDependencies(value) {
  const plain = String(value)
    .replace(/<!--.*?-->/g, " ")
    .replace(/[`*_]/g, " ")
    .trim()
  if (!plain || /^(?:none|n\/a|na|—|-|–)$/i.test(plain)) return []
  const ids = [...plain.matchAll(/\b\d+\b/g)].map((match) => canonicalId(match[0], "dependency"))
  if (ids.length === 0) fail(`Cannot parse dependencies: ${JSON.stringify(value)}`)
  return [...new Set(ids)]
}

function parseStatus(value, id) {
  const normalized = String(value).replace(/[`*_]/g, "").trim()
  const match = normalized.match(/^(TODO|IN\s+PROGRESS|DONE|BLOCKED|REJECTED)\b(?:\s*[:—–-]\s*|\s+)?(.*)$/i)
  if (!match) fail(`Plan ${id} has unsupported status: ${JSON.stringify(value)}`)
  const status = match[1].toUpperCase().replace(/\s+/g, " ")
  const statusDetail = match[2].trim()
  if (statusDetail && !new Set(["BLOCKED", "REJECTED"]).has(status)) {
    fail(`Plan ${id} may include a status detail only when BLOCKED or REJECTED`)
  }
  if (!statusDetail && new Set(["BLOCKED", "REJECTED"]).has(status)) {
    fail(`Plan ${id} must explain why it is ${status}`)
  }
  return { status, statusDetail }
}

function extractLink(value) {
  const match = String(value).match(/\[[^\]]+\]\(([^)]+)\)/)
  return match ? match[1].trim().replace(/^<|>$/g, "") : null
}

function escapeRegex(value) {
  return value.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")
}

function isInside(parent, child) {
  const relative = path.relative(parent, child)
  return relative !== "" && !relative.startsWith(`..${path.sep}`) && relative !== ".." && !path.isAbsolute(relative)
}

function resolvePlanFile(planDir, planCell, id) {
  const link = extractLink(planCell)
  if (link) {
    if (/^[a-z][a-z0-9+.-]*:/i.test(link) || link.startsWith("#")) {
      fail(`Plan ${id} must link to a local Markdown file, not ${JSON.stringify(link)}`)
    }
    const withoutFragment = link.split("#", 1)[0]
    const resolved = path.resolve(planDir, decodeURIComponent(withoutFragment))
    if (!isInside(planDir, resolved) || path.extname(resolved).toLowerCase() !== ".md") {
      fail(`Plan ${id} link escapes the plan directory or is not Markdown: ${JSON.stringify(link)}`)
    }
    if (!fs.existsSync(resolved) || !fs.statSync(resolved).isFile()) {
      fail(`Plan ${id} file does not exist: ${resolved}`)
    }
    if (!new RegExp(`^${id}-.*\\.md$`, "i").test(path.basename(resolved))) {
      fail(`Plan ${id} link must target an ${id}-*.md file: ${resolved}`)
    }
    const realPlanDir = fs.realpathSync(planDir)
    const realResolved = fs.realpathSync(resolved)
    if (!isInside(realPlanDir, realResolved)) {
      fail(`Plan ${id} resolves outside the plan directory through a symlink: ${resolved}`)
    }
    return resolved
  }

  const matches = fs.readdirSync(planDir)
    .filter((name) => name !== "README.md" && new RegExp(`^${id}-.*\\.md$`, "i").test(name))
    .map((name) => path.join(planDir, name))
  if (matches.length !== 1) {
    fail(`Plan ${id} must resolve to exactly one ${id}-*.md file; found ${matches.length}`)
  }
  const resolved = matches[0]
  if (!fs.statSync(resolved).isFile() || !isInside(fs.realpathSync(planDir), fs.realpathSync(resolved))) {
    fail(`Plan ${id} resolves outside the plan directory or is not a file: ${resolved}`)
  }
  return resolved
}

function parsePlanFile(file, id) {
  const text = fs.readFileSync(file, "utf8")
  const title = text.match(/^#\s+Plan\s+(\d+)\b/i)
  if (!title || canonicalId(title[1], "plan title") !== id) {
    fail(`Plan ${id} must start with a matching "# Plan ${id}:" title: ${file}`)
  }
  for (const heading of REQUIRED_PLAN_HEADINGS) {
    if (!new RegExp(`^##\\s+${escapeRegex(heading)}\\s*$`, "im").test(text)) {
      fail(`Plan ${id} is missing required heading "## ${heading}": ${file}`)
    }
  }
  const metadata = new Map()
  for (const field of REQUIRED_PLAN_METADATA) {
    const match = text.match(new RegExp(`^\\s*[-*]\\s+\\*\\*${escapeRegex(field)}\\*\\*:\\s*(.+?)\\s*$`, "im"))
    if (!match) fail(`Plan ${id} is missing required metadata "- **${field}**:": ${file}`)
    metadata.set(field, match[1])
  }
  return { dependencies: parseDependencies(metadata.get("Depends on")), text }
}

function findIndexTable(markdown, readme) {
  const lines = markdown.split(/\r?\n/)
  for (let index = 0; index < lines.length - 1; index += 1) {
    const header = parseTableRow(lines[index])
    const separator = parseTableRow(lines[index + 1])
    if (!header || !separator || !isSeparatorRow(separator)) continue
    const normalized = header.map(normalizeHeader)
    if (!REQUIRED_INDEX_HEADERS.every((name) => normalized.includes(name))) continue

    const rows = []
    for (let rowIndex = index + 2; rowIndex < lines.length; rowIndex += 1) {
      const cells = parseTableRow(lines[rowIndex])
      if (!cells || cells.length < header.length) break
      rows.push({ cells: cells.slice(0, header.length), lineIndex: rowIndex })
    }
    return { header, normalized, rows, lines }
  }
  fail(`${readme} has no Markdown table containing the required columns: Plan, Title, Priority, Effort, Depends on, Status`)
}

function detectCycle(plansById) {
  const visiting = new Set()
  const visited = new Set()
  const stack = []

  function visit(id) {
    if (visiting.has(id)) {
      const start = stack.indexOf(id)
      return [...stack.slice(start), id]
    }
    if (visited.has(id)) return null
    visiting.add(id)
    stack.push(id)
    for (const dependency of plansById.get(id).dependencies) {
      const cycle = visit(dependency)
      if (cycle) return cycle
    }
    stack.pop()
    visiting.delete(id)
    visited.add(id)
    return null
  }

  for (const id of plansById.keys()) {
    const cycle = visit(id)
    if (cycle) return cycle
  }
  return null
}

function buildWaves(plans) {
  const remaining = new Map(plans.map((plan) => [plan.id, new Set(plan.dependencies)]))
  const waves = []
  while (remaining.size > 0) {
    const wave = [...remaining.entries()]
      .filter(([, dependencies]) => [...dependencies].every((dependency) => !remaining.has(dependency)))
      .map(([id]) => id)
      .sort()
    if (wave.length === 0) fail("Cannot build dependency waves; the graph contains a cycle")
    waves.push(wave)
    for (const id of wave) remaining.delete(id)
  }
  return waves
}

export function buildGraph(inputDir = DEFAULT_PLAN_DIR) {
  const planDir = path.resolve(inputDir)
  if (!fs.existsSync(planDir) || !fs.statSync(planDir).isDirectory()) {
    fail(`Plan directory does not exist: ${planDir}`)
  }
  const readme = path.join(planDir, "README.md")
  if (!fs.existsSync(readme) || !fs.statSync(readme).isFile()) {
    fail(`Plan directory has no README.md: ${planDir}`)
  }

  const table = findIndexTable(fs.readFileSync(readme, "utf8"), readme)
  const column = Object.fromEntries(table.normalized.map((name, index) => [name, index]))
  const plans = []
  const seen = new Set()

  for (const row of table.rows) {
    const id = canonicalId(row.cells[column.plan], "Plan column")
    if (seen.has(id)) fail(`Duplicate plan ID in ${readme}: ${id}`)
    seen.add(id)
    const file = resolvePlanFile(planDir, row.cells[column.plan], id)
    const indexDependencies = parseDependencies(row.cells[column["depends on"]])
    const fileDependencies = parsePlanFile(file, id).dependencies
    if (JSON.stringify([...indexDependencies].sort()) !== JSON.stringify([...fileDependencies].sort())) {
      fail(`Plan ${id} dependency mismatch: README has [${indexDependencies.join(", ")}], file has [${fileDependencies.join(", ")}]`)
    }
    const parsedStatus = parseStatus(row.cells[column.status], id)
    plans.push({
      id,
      title: column.title === undefined ? "" : row.cells[column.title].replace(/[`*_]/g, "").trim(),
      priority: column.priority === undefined ? "" : row.cells[column.priority].trim(),
      effort: column.effort === undefined ? "" : row.cells[column.effort].trim(),
      dependencies: indexDependencies,
      status: parsedStatus.status,
      statusDetail: parsedStatus.statusDetail,
      file,
    })
  }

  const filesById = new Map()
  for (const name of fs.readdirSync(planDir).filter((entry) => /^\d{3,}-.*\.md$/i.test(entry))) {
    const id = canonicalId(name, "numbered plan filename")
    const entries = filesById.get(id) ?? []
    entries.push(name)
    filesById.set(id, entries)
  }
  for (const [id, names] of filesById) {
    if (names.length > 1) fail(`Multiple numbered plan files use ID ${id}: ${names.join(", ")}`)
    if (!seen.has(id)) fail(`Numbered plan file is missing from ${readme}: ${names[0]}`)
  }

  plans.sort((left, right) => left.id.localeCompare(right.id, undefined, { numeric: true }))
  const plansById = new Map(plans.map((plan) => [plan.id, plan]))
  for (const plan of plans) {
    for (const dependency of plan.dependencies) {
      if (!plansById.has(dependency)) fail(`Plan ${plan.id} depends on unknown plan ${dependency}`)
      if (dependency === plan.id) fail(`Plan ${plan.id} depends on itself`)
    }
  }

  const cycle = detectCycle(plansById)
  if (cycle) fail(`Dependency cycle: ${cycle.join(" -> ")}`)

  const warnings = []
  for (const plan of plans) {
    if (plan.status === "DONE") {
      const unfinished = plan.dependencies.filter((id) => plansById.get(id).status !== "DONE")
      if (unfinished.length > 0) warnings.push(`Plan ${plan.id} is DONE but dependencies are not DONE: ${unfinished.join(", ")}`)
    }
  }

  const ready = []
  const waiting = []
  for (const plan of plans) {
    if (!ACTIONABLE.has(plan.status)) continue
    const unsatisfied = plan.dependencies.filter((id) => plansById.get(id).status !== "DONE")
    const rejected = unsatisfied.filter((id) => plansById.get(id).status === "REJECTED")
    if (plan.status === "TODO" && unsatisfied.length === 0) ready.push(plan.id)
    else if (unsatisfied.length > 0) waiting.push({ id: plan.id, unsatisfied, rejected })
  }

  return {
    planDir,
    readme,
    counts: {
      total: plans.length,
      done: plans.filter((plan) => plan.status === "DONE").length,
      rejected: plans.filter((plan) => plan.status === "REJECTED").length,
      actionable: plans.filter((plan) => ACTIONABLE.has(plan.status)).length,
    },
    plans,
    ready,
    inProgress: plans.filter((plan) => plan.status === "IN PROGRESS").map((plan) => plan.id),
    blocked: plans.filter((plan) => plan.status === "BLOCKED").map((plan) => plan.id),
    waiting,
    waves: buildWaves(plans),
    complete: plans.every((plan) => TERMINAL.has(plan.status)),
    warnings,
  }
}

function runGit(startDir, args, { allowFailure = false } = {}) {
  const result = spawnSync("git", ["-C", startDir, ...args], { encoding: "utf8" })
  if (result.error) fail(`Cannot run git: ${result.error.message}`)
  if (result.status !== 0 && !allowFailure) {
    fail(`git ${args.join(" ")} failed: ${(result.stderr || result.stdout).trim()}`)
  }
  return result
}

function repoContext(planDir) {
  const start = fs.existsSync(planDir) ? planDir : path.dirname(planDir)
  const repoRoot = runGit(start, ["rev-parse", "--show-toplevel"]).stdout.trim()
  const resolvedRoot = fs.realpathSync(repoRoot)
  const resolvedPlanDir = fs.existsSync(planDir) ? fs.realpathSync(planDir) : path.resolve(planDir)
  if (!isInside(resolvedRoot, resolvedPlanDir)) {
    fail(`Plan directory must be inside the Git repository: ${resolvedPlanDir}`)
  }
  const relative = path.relative(resolvedRoot, resolvedPlanDir).split(path.sep).join("/")
  const excludeResult = runGit(resolvedRoot, ["rev-parse", "--git-path", "info/exclude"])
  const excludeValue = excludeResult.stdout.trim()
  const excludeFile = path.isAbsolute(excludeValue) ? excludeValue : path.resolve(resolvedRoot, excludeValue)
  return { repoRoot: resolvedRoot, planDir: resolvedPlanDir, relative, excludeFile, ignorePattern: `/${relative}/` }
}

function readLines(file) {
  if (!fs.existsSync(file)) return []
  return fs.readFileSync(file, "utf8").split(/\r?\n/)
}

function addLocalIgnore(context) {
  const lines = readLines(context.excludeFile)
  if (lines.includes(context.ignorePattern)) return false
  fs.mkdirSync(path.dirname(context.excludeFile), { recursive: true })
  const existing = fs.existsSync(context.excludeFile) ? fs.readFileSync(context.excludeFile, "utf8").replace(/\s*$/, "") : ""
  const prefix = existing ? `${existing}\n\n` : ""
  fs.writeFileSync(context.excludeFile, `${prefix}# Herder local coordination plans\n${context.ignorePattern}\n`)
  return true
}

function removeLocalIgnore(context) {
  if (!fs.existsSync(context.excludeFile)) return false
  const original = fs.readFileSync(context.excludeFile, "utf8")
  const lines = original.split(/\r?\n/)
  const filtered = lines.filter((line, index) => {
    if (line === context.ignorePattern) return false
    if (line === "# Herder local coordination plans" && lines[index + 1] === context.ignorePattern) return false
    return true
  })
  const next = `${filtered.join("\n").replace(/\n{3,}/g, "\n\n").replace(/\s*$/, "")}\n`
  if (next === original) return false
  fs.writeFileSync(context.excludeFile, next)
  return true
}

function ensureRuntimeIgnore(planDir) {
  const file = path.join(planDir, ".gitignore")
  const pattern = ".herder/"
  const lines = readLines(file)
  if (lines.includes(pattern)) return false
  const existing = fs.existsSync(file) ? fs.readFileSync(file, "utf8").replace(/\s*$/, "") : ""
  fs.writeFileSync(file, `${existing ? `${existing}\n` : ""}${pattern}\n`)
  return true
}

function initialReadme() {
  return `# Herder Plans

Implementation plans managed by Herder. Each plan must be self-contained and safe to execute from a fresh integration commit.

## Execution order & status

| Plan | Title | Priority | Effort | Depends on | Status |
|------|-------|----------|--------|------------|--------|

Status values: TODO | IN PROGRESS | DONE | BLOCKED — <reason> | REJECTED — <reason>

## Dependency notes

Add one line for each non-obvious dependency.

## Findings considered and rejected

Record rejected findings here so later audits do not rediscover them.
`
}

export function initPlanDir(inputDir = DEFAULT_PLAN_DIR, { track = false } = {}) {
  const planDir = path.resolve(inputDir)
  fs.mkdirSync(planDir, { recursive: true })
  const context = repoContext(planDir)
  const readme = path.join(planDir, "README.md")
  const createdReadme = !fs.existsSync(readme)
  if (createdReadme) fs.writeFileSync(readme, initialReadme())
  const ignoreChanged = track ? removeLocalIgnore(context) : addLocalIgnore(context)
  const runtimeIgnoreChanged = track ? ensureRuntimeIgnore(planDir) : false
  return { planDir, readme, createdReadme, tracking: track ? "tracked" : "local", ignoreChanged, runtimeIgnoreChanged }
}

export function setTracking(inputDir = DEFAULT_PLAN_DIR, track) {
  const planDir = path.resolve(inputDir)
  if (!fs.existsSync(planDir) || !fs.statSync(planDir).isDirectory()) fail(`Plan directory does not exist: ${planDir}`)
  const context = repoContext(planDir)
  if (track) {
    return {
      planDir,
      tracking: "tracked",
      ignoreChanged: removeLocalIgnore(context),
      runtimeIgnoreChanged: ensureRuntimeIgnore(planDir),
    }
  }
  const tracked = runGit(context.repoRoot, ["ls-files", "--", context.relative], { allowFailure: true }).stdout.trim().split(/\r?\n/).filter(Boolean)
  return {
    planDir,
    tracking: "local",
    ignoreChanged: addLocalIgnore(context),
    warning: tracked.length > 0 ? `${tracked.length} tracked plan file(s) remain tracked until removed from the Git index` : "",
  }
}

export function snapshotPlan(inputDir = DEFAULT_PLAN_DIR, inputId) {
  const graph = buildGraph(inputDir)
  const id = canonicalId(inputId)
  const plan = graph.plans.find((candidate) => candidate.id === id)
  if (!plan) fail(`Plan ${id} is not indexed in ${graph.readme}`)
  return {
    planDir: graph.planDir,
    readme: graph.readme,
    plan,
    planText: fs.readFileSync(plan.file, "utf8"),
    indexText: fs.readFileSync(graph.readme, "utf8"),
  }
}

function formatStatus(status, detail) {
  if (!SUPPORTED_STATUSES.has(status)) fail(`Unsupported status: ${JSON.stringify(status)}`)
  if (detail && !new Set(["BLOCKED", "REJECTED"]).has(status)) {
    fail(`Only BLOCKED and REJECTED may include a status detail`)
  }
  if (!detail && new Set(["BLOCKED", "REJECTED"]).has(status)) {
    fail(`${status} requires a one-line status detail`)
  }
  if (/[\r\n|]/.test(detail)) fail("Status detail must be one line and cannot contain a table separator")
  return detail ? `${status} — ${detail}` : status
}

export function transitionStatus(inputDir = DEFAULT_PLAN_DIR, inputId, requestedStatus, detail = "") {
  const graph = buildGraph(inputDir)
  const id = canonicalId(inputId)
  const current = graph.plans.find((candidate) => candidate.id === id)
  if (!current) fail(`Plan ${id} is not indexed in ${graph.readme}`)
  const nextStatus = String(requestedStatus).trim().toUpperCase().replace(/\s+/g, " ")
  if (!SUPPORTED_STATUSES.has(nextStatus)) fail(`Unsupported status: ${JSON.stringify(requestedStatus)}`)
  if (current.status !== nextStatus && !TRANSITIONS.get(current.status).has(nextStatus)) {
    fail(`Invalid plan transition for ${id}: ${current.status} -> ${nextStatus}`)
  }

  const markdown = fs.readFileSync(graph.readme, "utf8")
  const table = findIndexTable(markdown, graph.readme)
  const column = Object.fromEntries(table.normalized.map((name, index) => [name, index]))
  const row = table.rows.find((candidate) => canonicalId(candidate.cells[column.plan], "Plan column") === id)
  row.cells[column.status] = formatStatus(nextStatus, String(detail).trim())
  table.lines[row.lineIndex] = `| ${row.cells.join(" | ")} |`
  const nextMarkdown = table.lines.join("\n")
  const temporary = `${graph.readme}.herder-tmp-${process.pid}`
  fs.writeFileSync(temporary, nextMarkdown)
  fs.renameSync(temporary, graph.readme)
  buildGraph(graph.planDir)
  return { planDir: graph.planDir, id, from: current.status, to: nextStatus, detail: String(detail).trim() }
}

function usage() {
  return [
    "Usage:",
    "  herder-plans init [plan-dir] [--track] [--pretty]",
    "  herder-plans validate [plan-dir] [--pretty]",
    "  herder-plans status [plan-dir] [--pretty]",
    "  herder-plans ready [plan-dir] [--pretty]",
    "  herder-plans snapshot <plan-id> [plan-dir] [--pretty]",
    "  herder-plans transition <plan-id> <status> [plan-dir] [--detail <text>] [--pretty]",
    "  herder-plans track [plan-dir] [--pretty]",
    "  herder-plans untrack [plan-dir] [--pretty]",
  ].join("\n")
}

function takeFlag(args, name) {
  const index = args.indexOf(name)
  if (index === -1) return null
  if (index === args.length - 1) fail(`${name} requires a value`)
  const value = args[index + 1]
  args.splice(index, 2)
  return value
}

function main(argv) {
  const args = [...argv]
  const pretty = args.includes("--pretty")
  const track = args.includes("--track")
  for (const flag of ["--pretty", "--track"]) {
    let index
    while ((index = args.indexOf(flag)) !== -1) args.splice(index, 1)
  }
  const detail = takeFlag(args, "--detail") ?? ""
  const unknown = args.filter((argument) => argument.startsWith("--"))
  if (unknown.length > 0) fail(`Unknown option: ${unknown[0]}\n${usage()}`)

  const command = args.shift()
  let result
  if (command === "init") {
    if (args.length > 1 || detail) fail(usage())
    result = initPlanDir(args[0] ?? DEFAULT_PLAN_DIR, { track })
  } else if (["validate", "status"].includes(command)) {
    if (args.length > 1 || detail || track) fail(usage())
    result = buildGraph(args[0] ?? DEFAULT_PLAN_DIR)
  } else if (command === "ready") {
    if (args.length > 1 || detail || track) fail(usage())
    const graph = buildGraph(args[0] ?? DEFAULT_PLAN_DIR)
    result = {
      planDir: graph.planDir,
      ready: graph.ready,
      inProgress: graph.inProgress,
      blocked: graph.blocked,
      waiting: graph.waiting,
      complete: graph.complete,
    }
  } else if (command === "snapshot") {
    if (args.length < 1 || args.length > 2 || detail || track) fail(usage())
    result = snapshotPlan(args[1] ?? DEFAULT_PLAN_DIR, args[0])
  } else if (command === "transition") {
    if (args.length < 2 || args.length > 3 || track) fail(usage())
    result = transitionStatus(args[2] ?? DEFAULT_PLAN_DIR, args[0], args[1], detail)
  } else if (["track", "untrack"].includes(command)) {
    if (args.length > 1 || detail || track) fail(usage())
    result = setTracking(args[0] ?? DEFAULT_PLAN_DIR, command === "track")
  } else {
    fail(usage())
  }

  process.stdout.write(`${JSON.stringify(result, null, pretty ? 2 : 0)}\n`)
}

const isMain = process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)
if (isMain) {
  try {
    main(process.argv.slice(2))
  } catch (error) {
    process.stderr.write(`herder-plans: ${error.message}\n`)
    process.exitCode = 1
  }
}

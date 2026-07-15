#!/usr/bin/env node

import fs from "node:fs"
import path from "node:path"
import process from "node:process"
import { fileURLToPath } from "node:url"

const TERMINAL = new Set(["DONE", "REJECTED"])
const ACTIONABLE = new Set(["TODO", "IN PROGRESS", "BLOCKED"])

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

function canonicalId(value, context) {
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
  return {
    status: match[1].toUpperCase().replace(/\s+/g, " "),
    statusDetail: match[2].trim(),
  }
}

function extractLink(value) {
  const match = String(value).match(/\[[^\]]+\]\(([^)]+)\)/)
  return match ? match[1].trim().replace(/^<|>$/g, "") : null
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

function parsePlanFileDependencies(file, id) {
  const text = fs.readFileSync(file, "utf8")
  const match = text.match(/^\s*[-*]\s+\*\*Depends on\*\*:\s*(.+?)\s*$/im)
  if (!match) fail(`Plan ${id} is missing a "- **Depends on**:" metadata line: ${file}`)
  return parseDependencies(match[1])
}

function findIndexTable(markdown, readme) {
  const lines = markdown.split(/\r?\n/)
  for (let index = 0; index < lines.length - 1; index += 1) {
    const header = parseTableRow(lines[index])
    const separator = parseTableRow(lines[index + 1])
    if (!header || !separator || !isSeparatorRow(separator)) continue
    const normalized = header.map(normalizeHeader)
    if (!normalized.includes("plan") || !normalized.includes("depends on") || !normalized.includes("status")) continue

    const rows = []
    for (let rowIndex = index + 2; rowIndex < lines.length; rowIndex += 1) {
      const row = parseTableRow(lines[rowIndex])
      if (!row || row.length < header.length) break
      rows.push(row.slice(0, header.length))
    }
    if (rows.length === 0) fail(`Execution table in ${readme} has no plan rows`)
    return { header, normalized, rows }
  }
  fail(`${readme} has no Markdown table containing Plan, Depends on, and Status columns`)
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

export function buildGraph(inputDir) {
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
    const id = canonicalId(row[column.plan], "Plan column")
    if (seen.has(id)) fail(`Duplicate plan ID in ${readme}: ${id}`)
    seen.add(id)
    const file = resolvePlanFile(planDir, row[column.plan], id)
    const indexDependencies = parseDependencies(row[column["depends on"]])
    const fileDependencies = parsePlanFileDependencies(file, id)
    if (JSON.stringify([...indexDependencies].sort()) !== JSON.stringify([...fileDependencies].sort())) {
      fail(`Plan ${id} dependency mismatch: README has [${indexDependencies.join(", ")}], file has [${fileDependencies.join(", ")}]`)
    }
    const parsedStatus = parseStatus(row[column.status], id)
    plans.push({
      id,
      title: column.title === undefined ? "" : row[column.title].replace(/[`*_]/g, "").trim(),
      priority: column.priority === undefined ? "" : row[column.priority].trim(),
      effort: column.effort === undefined ? "" : row[column.effort].trim(),
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
    if (unsatisfied.length === 0) ready.push(plan.id)
    else waiting.push({ id: plan.id, unsatisfied, rejected })
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
    waiting,
    waves: buildWaves(plans),
    complete: plans.every((plan) => TERMINAL.has(plan.status)),
    warnings,
  }
}

function usage() {
  return "Usage: node plan-graph.mjs <plan-dir> [--pretty]"
}

function main(argv) {
  const positional = argv.filter((argument) => !argument.startsWith("--"))
  const unknown = argv.filter((argument) => argument.startsWith("--") && argument !== "--pretty")
  if (positional.length !== 1 || unknown.length > 0) fail(usage())
  const graph = buildGraph(positional[0])
  process.stdout.write(`${JSON.stringify(graph, null, argv.includes("--pretty") ? 2 : 0)}\n`)
}

const isMain = process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)
if (isMain) {
  try {
    main(process.argv.slice(2))
  } catch (error) {
    process.stderr.write(`plan-graph: ${error.message}\n`)
    process.exitCode = 1
  }
}

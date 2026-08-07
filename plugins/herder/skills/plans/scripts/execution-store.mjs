import fs from "node:fs"
import { createRequire } from "node:module"
import path from "node:path"

const require = createRequire(import.meta.url)

export const EXECUTION_DATABASE_RELATIVE = ".herder/execution.sqlite3"
export const EXECUTION_SCHEMA_VERSION = 2

const LEGACY_SECTION_START = "<!-- herder-usage:start -->"
const LEGACY_SECTION_END = "<!-- herder-usage:end -->"
const LEGACY_HEADERS = [
  "attempt",
  "plan",
  "role",
  "model",
  "effort",
  "outcome",
  "input tokens",
  "cached input",
  "output tokens",
  "reasoning tokens",
  "source",
]
const IDENTITY_FIELDS = [
  "attempt",
  "plan",
  "role",
  "model",
  "effort",
  "outcome",
  "inputTokens",
  "cachedInputTokens",
  "outputTokens",
  "reasoningTokens",
  "source",
  "round",
  "generation",
  "runtime",
  "harness",
  "serviceTier",
  "startedAt",
  "finishedAt",
  "durationMs",
]

function fail(message) {
  throw new Error(message)
}

function sqliteApi() {
  try {
    return require("node:sqlite")
  } catch {
    fail("SQLite execution accounting requires a Node.js runtime with the built-in node:sqlite module")
  }
}

export function executionDatabasePath(planDir) {
  return path.join(path.resolve(planDir), EXECUTION_DATABASE_RELATIVE)
}

function configureDatabase(database, { readOnly = false } = {}) {
  database.exec("PRAGMA foreign_keys = ON")
  database.exec("PRAGMA busy_timeout = 5000")
  if (readOnly) {
    database.exec("PRAGMA query_only = ON")
    return
  }
  database.exec("PRAGMA journal_mode = DELETE")
  database.exec("PRAGMA synchronous = FULL")
}

function initializeSchema(database, { allowInitialize = true } = {}) {
  const row = database.prepare("PRAGMA user_version").get()
  const version = Number(row.user_version)
  if (version > EXECUTION_SCHEMA_VERSION) {
    fail(`Execution database schema ${version} is newer than supported schema ${EXECUTION_SCHEMA_VERSION}`)
  }
  if (version === 0) {
    if (!allowInitialize) fail("Execution database has no initialized schema")
    database.exec(`
      CREATE TABLE IF NOT EXISTS attempts (
        attempt_id TEXT PRIMARY KEY NOT NULL,
        plan_id TEXT NOT NULL,
        role TEXT NOT NULL,
        model TEXT NOT NULL,
        effort TEXT NOT NULL,
        outcome TEXT NOT NULL,
        input_tokens INTEGER CHECK (input_tokens IS NULL OR input_tokens >= 0),
        cached_input_tokens INTEGER CHECK (cached_input_tokens IS NULL OR cached_input_tokens >= 0),
        output_tokens INTEGER CHECK (output_tokens IS NULL OR output_tokens >= 0),
        reasoning_tokens INTEGER CHECK (reasoning_tokens IS NULL OR reasoning_tokens >= 0),
        source TEXT NOT NULL,
        round_number INTEGER CHECK (round_number IS NULL OR round_number BETWEEN 1 AND 6),
        generation TEXT,
        runtime TEXT,
        harness TEXT,
        service_tier TEXT,
        started_at TEXT,
        finished_at TEXT,
        duration_ms INTEGER CHECK (duration_ms IS NULL OR duration_ms >= 0),
        recorded_at TEXT NOT NULL
      );
      CREATE INDEX IF NOT EXISTS attempts_plan_id ON attempts(plan_id);
      CREATE INDEX IF NOT EXISTS attempts_role ON attempts(role);
      CREATE INDEX IF NOT EXISTS attempts_model_effort ON attempts(model, effort);
      PRAGMA user_version = 1;
    `)
  }
  if (version < 2) {
    if (!allowInitialize) return
    database.exec(`
      CREATE TABLE IF NOT EXISTS run_configuration (
        singleton INTEGER PRIMARY KEY NOT NULL CHECK (singleton = 1),
        profile_name TEXT NOT NULL,
        profile_sha256 TEXT NOT NULL,
        host TEXT NOT NULL,
        roles_json TEXT NOT NULL,
        recorded_at TEXT NOT NULL
      );
      PRAGMA user_version = 2;
    `)
  }
}

function assertHealthy(database, databasePath) {
  const row = database.prepare("PRAGMA quick_check").get()
  const result = String(Object.values(row)[0] ?? "")
  if (result !== "ok") fail(`Execution database failed quick_check at ${databasePath}: ${result || "unknown error"}`)
}

function openDatabase(planDir, { create = false, readOnly = false } = {}) {
  const databasePath = executionDatabasePath(planDir)
  const runtimeDirectory = path.dirname(databasePath)
  const existed = fs.existsSync(databasePath)
  if (!existed && !create) return null
  if (!existed && readOnly) return null
  if (fs.existsSync(runtimeDirectory)) {
    const runtimeStat = fs.lstatSync(runtimeDirectory)
    if (runtimeStat.isSymbolicLink() || !runtimeStat.isDirectory()) {
      fail(`Execution runtime path must be a real directory: ${runtimeDirectory}`)
    }
  } else {
    fs.mkdirSync(runtimeDirectory, { recursive: true, mode: 0o700 })
  }
  if (existed) {
    const databaseStat = fs.lstatSync(databasePath)
    if (databaseStat.isSymbolicLink() || !databaseStat.isFile()) {
      fail(`Execution database path must be a regular file: ${databasePath}`)
    }
  }
  const { DatabaseSync } = sqliteApi()
  const database = new DatabaseSync(databasePath, { readOnly })
  try {
    configureDatabase(database, { readOnly })
    initializeSchema(database, { allowInitialize: !readOnly })
    assertHealthy(database, databasePath)
    if (!existed) {
      fs.chmodSync(runtimeDirectory, 0o700)
      fs.chmodSync(databasePath, 0o600)
    }
    return database
  } catch (error) {
    database.close()
    throw error
  }
}

function requiredText(value, label) {
  const normalized = String(value ?? "").trim()
  if (!normalized) fail(`${label} cannot be empty`)
  if (/[\0\r\n|]/.test(normalized)) fail(`${label} must be one line and cannot contain a table separator`)
  return normalized
}

function optionalText(value, label) {
  if (value === null || value === undefined || String(value).trim() === "") return null
  return requiredText(value, label)
}

function optionalCount(value, label) {
  const normalized = String(value ?? "unknown").trim().toLowerCase()
  if (normalized === "unknown" || normalized === "") return null
  if (!/^\d+$/.test(normalized)) fail(`${label} must be a non-negative integer or "unknown"`)
  const count = Number.parseInt(normalized, 10)
  if (!Number.isSafeInteger(count)) fail(`${label} is too large`)
  return count
}

function optionalRound(value) {
  if (value === null || value === undefined || String(value).trim() === "") return null
  const round = optionalCount(value, "Round")
  if (round < 1 || round > 6) fail("Round must be an integer from 1 through 6")
  return round
}

function optionalTimestamp(value, label) {
  if (value === null || value === undefined || String(value).trim() === "") return null
  const text = requiredText(value, label)
  const milliseconds = Date.parse(text)
  if (!Number.isFinite(milliseconds)) fail(`${label} must be an ISO-8601 timestamp`)
  return new Date(milliseconds).toISOString()
}

export function normalizeUsageRecord(input = {}) {
  const record = {
    attempt: requiredText(input.attempt, "Attempt"),
    plan: requiredText(input.plan, "Plan"),
    role: requiredText(input.role, "Role"),
    model: requiredText(input.model, "Model"),
    effort: requiredText(input.effort, "Effort"),
    outcome: requiredText(input.outcome, "Outcome"),
    inputTokens: optionalCount(input.inputTokens, "Input tokens"),
    cachedInputTokens: optionalCount(input.cachedInputTokens, "Cached input tokens"),
    outputTokens: optionalCount(input.outputTokens, "Output tokens"),
    reasoningTokens: optionalCount(input.reasoningTokens, "Reasoning tokens"),
    source: requiredText(input.source ?? "unknown", "Source"),
    round: optionalRound(input.round),
    generation: optionalText(input.generation, "Generation"),
    runtime: optionalText(input.runtime, "Runtime"),
    harness: optionalText(input.harness, "Harness"),
    serviceTier: optionalText(input.serviceTier, "Service tier"),
    startedAt: optionalTimestamp(input.startedAt, "Started at"),
    finishedAt: optionalTimestamp(input.finishedAt, "Finished at"),
    durationMs: optionalCount(input.durationMs, "Duration milliseconds"),
  }
  if (record.source.toLowerCase() === "unknown"
    && [record.inputTokens, record.cachedInputTokens, record.outputTokens, record.reasoningTokens].some((value) => value !== null)) {
    fail(`Usage attempt ${record.attempt} has numeric usage but an unknown source`)
  }
  if (record.startedAt && record.finishedAt && Date.parse(record.finishedAt) < Date.parse(record.startedAt)) {
    fail(`Usage attempt ${record.attempt} finishes before it starts`)
  }
  return record
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

function findLegacyTable(section, readme) {
  const lines = section.split(/\r?\n/)
  for (let index = 0; index < lines.length - 1; index += 1) {
    const header = parseTableRow(lines[index])
    const separator = parseTableRow(lines[index + 1])
    if (!header || !separator || !isSeparatorRow(separator)) continue
    const normalized = header.map(normalizeHeader)
    if (!LEGACY_HEADERS.every((name) => normalized.includes(name))) continue
    const rows = []
    for (let rowIndex = index + 2; rowIndex < lines.length; rowIndex += 1) {
      const cells = parseTableRow(lines[rowIndex])
      if (!cells || cells.length < header.length) break
      rows.push(cells.slice(0, header.length))
    }
    return { normalized, rows }
  }
  fail(`${readme} has a legacy Herder usage section without its attempt ledger table`)
}

export function parseLegacyUsageRecords(markdown, readme) {
  const start = markdown.indexOf(LEGACY_SECTION_START)
  const end = markdown.indexOf(LEGACY_SECTION_END)
  if (start === -1 && end === -1) return { present: false, records: [] }
  if (start === -1 || end === -1 || end < start) fail(`${readme} has malformed legacy Herder usage section markers`)
  if (markdown.indexOf(LEGACY_SECTION_START, start + LEGACY_SECTION_START.length) !== -1
    || markdown.indexOf(LEGACY_SECTION_END, end + LEGACY_SECTION_END.length) !== -1) {
    fail(`${readme} has duplicate legacy Herder usage section markers`)
  }
  const section = markdown.slice(start, end + LEGACY_SECTION_END.length)
  const table = findLegacyTable(section, readme)
  const column = Object.fromEntries(table.normalized.map((name, index) => [name, index]))
  const records = table.rows.map((cells) => normalizeUsageRecord({
    attempt: cells[column.attempt],
    plan: cells[column.plan],
    role: cells[column.role],
    model: cells[column.model],
    effort: cells[column.effort],
    outcome: cells[column.outcome],
    inputTokens: cells[column["input tokens"]],
    cachedInputTokens: cells[column["cached input"]],
    outputTokens: cells[column["output tokens"]],
    reasoningTokens: cells[column["reasoning tokens"]],
    source: cells[column.source],
  }))
  const attempts = new Set()
  for (const record of records) {
    if (attempts.has(record.attempt)) fail(`Usage attempt ${record.attempt} is recorded more than once in legacy README metadata`)
    attempts.add(record.attempt)
  }
  return { present: true, records, start, end: end + LEGACY_SECTION_END.length }
}

function stripLegacyUsageSection(markdown, legacy) {
  const prefix = markdown.slice(0, legacy.start).replace(/\s*$/, "")
  const suffix = markdown.slice(legacy.end).replace(/^\s*/, "").replace(/\s*$/, "")
  return `${[prefix, suffix].filter(Boolean).join("\n\n")}\n`
}

function atomicWrite(file, content) {
  const mode = fs.existsSync(file) ? fs.statSync(file).mode & 0o777 : 0o644
  const temporary = `${file}.herder-tmp-${process.pid}`
  try {
    fs.writeFileSync(temporary, content, { mode, flag: "wx" })
    fs.renameSync(temporary, file)
  } finally {
    if (fs.existsSync(temporary)) fs.rmSync(temporary)
  }
}

function rowToRecord(row) {
  return {
    attempt: row.attempt_id,
    plan: row.plan_id,
    role: row.role,
    model: row.model,
    effort: row.effort,
    outcome: row.outcome,
    inputTokens: row.input_tokens,
    cachedInputTokens: row.cached_input_tokens,
    outputTokens: row.output_tokens,
    reasoningTokens: row.reasoning_tokens,
    source: row.source,
    round: row.round_number,
    generation: row.generation,
    runtime: row.runtime,
    harness: row.harness,
    serviceTier: row.service_tier,
    startedAt: row.started_at,
    finishedAt: row.finished_at,
    durationMs: row.duration_ms,
    recordedAt: row.recorded_at,
  }
}

function comparable(record) {
  return Object.fromEntries(IDENTITY_FIELDS.map((field) => [field, record[field] ?? null]))
}

function sameRecord(left, right) {
  return JSON.stringify(comparable(left)) === JSON.stringify(comparable(right))
}

function readDatabaseRecords(database) {
  return database.prepare("SELECT * FROM attempts ORDER BY rowid").all().map(rowToRecord)
}

function normalizeRunConfiguration(input = {}) {
  const profile = requiredText(input.profile, "Profile")
  if (!/^[a-z0-9][a-z0-9-]{0,63}$/.test(profile)) fail("Profile must be a lowercase profile name")
  const profileSha256 = requiredText(input.profileSha256, "Profile SHA-256").toLowerCase()
  if (!/^[0-9a-f]{64}$/.test(profileSha256)) fail("Profile SHA-256 must contain 64 hexadecimal characters")
  const host = requiredText(input.host, "Host")
  if (!["codex", "claude", "pi"].includes(host)) fail("Host must be codex, claude, or pi")
  let roles
  try {
    roles = typeof input.roles === "string" ? JSON.parse(input.roles) : input.roles
  } catch (error) {
    fail(`Roles JSON is invalid: ${error.message}`)
  }
  if (!roles || typeof roles !== "object" || Array.isArray(roles)) fail("Roles must be a JSON object")
  const normalizedRoles = {}
  for (const role of ["plan-accountant", "plan-implementer", "plan-reviewer", "plan-judge", "plan-saver"]) {
    const mapping = roles[role]
    if (!mapping || typeof mapping !== "object" || Array.isArray(mapping)) fail(`Missing run role ${role}`)
    const unknownFields = Object.keys(mapping).filter((field) => !["agent_type", "model", "effort", "service_tier"].includes(field))
    if (unknownFields.length > 0) fail(`Run role ${role} contains unknown fields: ${unknownFields.join(", ")}`)
    normalizedRoles[role] = {
      agent_type: requiredText(mapping.agent_type, `${role} agent type`),
      model: requiredText(mapping.model, `${role} model`),
      effort: requiredText(mapping.effort, `${role} effort`),
      ...(mapping.service_tier ? { service_tier: requiredText(mapping.service_tier, `${role} service tier`) } : {}),
    }
  }
  if (Object.keys(roles).some((role) => !Object.hasOwn(normalizedRoles, role))) fail("Run roles contain an unknown role")
  return { profile, profileSha256, host, roles: normalizedRoles }
}

function rowToRunConfiguration(row) {
  if (!row) return null
  return {
    profile: row.profile_name,
    profileSha256: row.profile_sha256,
    host: row.host,
    roles: JSON.parse(row.roles_json),
    recordedAt: row.recorded_at,
  }
}

function readDatabaseRunConfiguration(database) {
  const table = database.prepare("SELECT name FROM sqlite_master WHERE type = 'table' AND name = 'run_configuration'").get()
  if (!table) return null
  return rowToRunConfiguration(database.prepare("SELECT * FROM run_configuration WHERE singleton = 1").get())
}

function databaseSchemaVersion(database) {
  return Number(database.prepare("PRAGMA user_version").get().user_version)
}

export function recordRunConfiguration(planDir, readme, input) {
  const configuration = normalizeRunConfiguration(input)
  migrateLegacyUsage(planDir, readme)
  const database = openDatabase(planDir, { create: true })
  let recorded = false
  try {
    withTransaction(database, () => {
      const existing = readDatabaseRunConfiguration(database)
      if (existing) {
        const comparableExisting = { profile: existing.profile, profileSha256: existing.profileSha256, host: existing.host, roles: existing.roles }
        if (JSON.stringify(comparableExisting) !== JSON.stringify(configuration)) {
          fail(`Run profile is already bound to ${existing.profile} (${existing.profileSha256}) on ${existing.host}`)
        }
        return
      }
      database.prepare(`
        INSERT INTO run_configuration (singleton, profile_name, profile_sha256, host, roles_json, recorded_at)
        VALUES (1, ?, ?, ?, ?, ?)
      `).run(configuration.profile, configuration.profileSha256, configuration.host, JSON.stringify(configuration.roles), new Date().toISOString())
      recorded = true
    })
    return { recorded, configuration: readDatabaseRunConfiguration(database), database: executionDatabasePath(planDir) }
  } finally {
    database.close()
  }
}

export function readRunConfiguration(planDir) {
  const database = openDatabase(planDir, { readOnly: true })
  if (!database) return { database: executionDatabasePath(planDir), schemaVersion: null, configuration: null }
  try {
    return { database: executionDatabasePath(planDir), schemaVersion: databaseSchemaVersion(database), configuration: readDatabaseRunConfiguration(database) }
  } finally {
    database.close()
  }
}

function insertRecord(database, record) {
  const existing = database.prepare("SELECT * FROM attempts WHERE attempt_id = ?").get(record.attempt)
  if (existing) {
    if (!sameRecord(rowToRecord(existing), record)) {
      fail(`Usage attempt ${record.attempt} is already recorded with different values`)
    }
    return false
  }
  database.prepare(`
    INSERT INTO attempts (
      attempt_id, plan_id, role, model, effort, outcome,
      input_tokens, cached_input_tokens, output_tokens, reasoning_tokens, source,
      round_number, generation, runtime, harness, service_tier,
      started_at, finished_at, duration_ms, recorded_at
    ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
  `).run(
    record.attempt,
    record.plan,
    record.role,
    record.model,
    record.effort,
    record.outcome,
    record.inputTokens,
    record.cachedInputTokens,
    record.outputTokens,
    record.reasoningTokens,
    record.source,
    record.round,
    record.generation,
    record.runtime,
    record.harness,
    record.serviceTier,
    record.startedAt,
    record.finishedAt,
    record.durationMs,
    new Date().toISOString(),
  )
  return true
}

function withTransaction(database, operation) {
  database.exec("BEGIN IMMEDIATE")
  try {
    const result = operation()
    database.exec("COMMIT")
    return result
  } catch (error) {
    database.exec("ROLLBACK")
    throw error
  }
}

function mergeRecords(primary, secondary) {
  const merged = [...primary]
  const byAttempt = new Map(primary.map((record) => [record.attempt, record]))
  for (const record of secondary) {
    const existing = byAttempt.get(record.attempt)
    if (existing && !sameRecord(existing, record)) {
      fail(`Usage attempt ${record.attempt} differs between SQLite and legacy README metadata`)
    }
    if (!existing) {
      merged.push(record)
      byAttempt.set(record.attempt, record)
    }
  }
  return merged
}

export function migrateLegacyUsage(planDir, readme = path.join(path.resolve(planDir), "README.md")) {
  const markdown = fs.readFileSync(readme, "utf8")
  const legacy = parseLegacyUsageRecords(markdown, readme)
  const database = openDatabase(planDir, { create: true })
  let migrated = 0
  try {
    migrated = withTransaction(database, () => legacy.records.reduce(
      (count, record) => count + (insertRecord(database, record) ? 1 : 0),
      0,
    ))
  } finally {
    database.close()
  }
  if (legacy.present) atomicWrite(readme, stripLegacyUsageSection(markdown, legacy))
  return {
    database: executionDatabasePath(planDir),
    schemaVersion: EXECUTION_SCHEMA_VERSION,
    migrated,
    removedLegacySection: legacy.present,
  }
}

export function initializeExecutionStore(planDir, readme = path.join(path.resolve(planDir), "README.md")) {
  return migrateLegacyUsage(planDir, readme)
}

export function recordUsageRecord(planDir, readme, input) {
  const record = normalizeUsageRecord(input)
  const migration = migrateLegacyUsage(planDir, readme)
  const database = openDatabase(planDir, { create: true })
  let recorded
  let records
  try {
    recorded = withTransaction(database, () => insertRecord(database, record))
    records = readDatabaseRecords(database)
  } finally {
    database.close()
  }
  return { recorded, record, records, migration }
}

export function readUsageState(planDir, readme = path.join(path.resolve(planDir), "README.md")) {
  const markdown = fs.readFileSync(readme, "utf8")
  const legacy = parseLegacyUsageRecords(markdown, readme)
  const databaseExists = fs.existsSync(executionDatabasePath(planDir))
  const database = openDatabase(planDir, { readOnly: true })
  let records = []
  let runConfiguration = null
  let schemaVersion = null
  try {
    if (database) {
      records = readDatabaseRecords(database)
      runConfiguration = readDatabaseRunConfiguration(database)
      schemaVersion = databaseSchemaVersion(database)
    }
  } finally {
    database?.close()
  }
  records = mergeRecords(records, legacy.records)
  return {
    database: executionDatabasePath(planDir),
    databaseExists,
    storage: legacy.present
      ? (databaseExists ? "sqlite+legacy-pending" : "legacy-readonly")
      : (databaseExists ? "sqlite" : "uninitialized"),
    schemaVersion,
    runConfiguration,
    records,
  }
}

function summarizeRecords(records, keyFor) {
  const groups = new Map()
  for (const record of records) {
    const key = keyFor(record)
    const group = groups.get(key) ?? []
    group.push(record)
    groups.set(key, group)
  }
  return [...groups.entries()]
    .sort(([left], [right]) => left.localeCompare(right, undefined, { numeric: true }))
    .map(([key, entries]) => {
      const tokenEntries = entries.filter((entry) => entry.inputTokens !== null && entry.outputTokens !== null)
      return {
        key,
        attempts: entries.length,
        tokenAttempts: tokenEntries.length,
        knownTokens: tokenEntries.reduce((sum, entry) => sum + entry.inputTokens + entry.outputTokens, 0),
      }
    })
}

export function usageReport(records) {
  return {
    attempts: records.length,
    byPlan: summarizeRecords(records, (record) => record.plan),
    byRole: summarizeRecords(records, (record) => record.role),
    byModel: summarizeRecords(records, (record) => `${record.model} / ${record.effort}`),
    records,
  }
}

function sumKnown(records, field) {
  return records.reduce((sum, record) => sum + (record[field] ?? 0), 0)
}

function timestampRange(records) {
  const starts = records.map((record) => record.startedAt).filter(Boolean).sort()
  const finishes = records.map((record) => record.finishedAt).filter(Boolean).sort()
  const startedAt = starts[0] ?? null
  const finishedAt = finishes.at(-1) ?? null
  return {
    startedAt,
    finishedAt,
    wallClockMs: startedAt && finishedAt ? Date.parse(finishedAt) - Date.parse(startedAt) : null,
  }
}

export function executionReport(records, selector = "RUN") {
  const selected = selector === "RUN" ? records : records.filter((record) => record.plan === selector)
  const tokenAttempts = selected.filter((record) => record.inputTokens !== null && record.outputTokens !== null)
  const durations = selected.filter((record) => record.durationMs !== null)
  const rounds = [...new Set(selected.map((record) => record.round).filter((round) => round !== null))].sort((a, b) => a - b)
  return {
    plan: selector,
    attempts: selected.length,
    rounds,
    interruptions: selected.filter((record) => record.outcome.toUpperCase() === "INTERRUPTED").length,
    tokenCoverage: {
      reported: tokenAttempts.length,
      total: selected.length,
    },
    tokens: {
      input: sumKnown(selected, "inputTokens"),
      cachedInput: sumKnown(selected, "cachedInputTokens"),
      output: sumKnown(selected, "outputTokens"),
      reasoning: sumKnown(selected, "reasoningTokens"),
      reportedInputOutput: tokenAttempts.reduce((sum, record) => sum + record.inputTokens + record.outputTokens, 0),
    },
    timing: {
      ...timestampRange(selected),
      attemptDurationMs: durations.length > 0
        ? durations.reduce((sum, record) => sum + record.durationMs, 0)
        : null,
      durationCoverage: { reported: durations.length, total: selected.length },
    },
    byPlan: summarizeRecords(selected, (record) => record.plan),
    byRole: summarizeRecords(selected, (record) => record.role),
    byOutcome: summarizeRecords(selected, (record) => record.outcome),
    byModel: summarizeRecords(selected, (record) => `${record.model} / ${record.effort}`),
    byRuntime: summarizeRecords(selected, (record) => `${record.runtime ?? "unknown"} / ${record.harness ?? "unknown"}`),
    byGeneration: summarizeRecords(selected, (record) => record.generation ?? "unknown"),
    byServiceTier: summarizeRecords(selected, (record) => record.serviceTier ?? "unknown"),
    records: selected,
  }
}

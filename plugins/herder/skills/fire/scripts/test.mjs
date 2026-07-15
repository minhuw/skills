#!/usr/bin/env node

import assert from "node:assert/strict"
import fs from "node:fs"
import os from "node:os"
import path from "node:path"
import { buildGraph } from "./plan-graph.mjs"

function writeFixture(root, { cycle = false, mismatch = false } = {}) {
  const planDir = path.join(root, "plans")
  fs.mkdirSync(planDir, { recursive: true })
  fs.writeFileSync(path.join(planDir, "README.md"), `# Implementation Plans

## Execution order & status

| Plan | Title | Priority | Effort | Depends on | Status |
|------|-------|----------|--------|------------|--------|
| [001](001-first.md) | First | P1 | S | ${cycle ? "002" : "—"} | DONE |
| [002](002-second.md) | Second | P1 | M | 001 | TODO |
| 003 | Parallel | P2 | S | — | BLOCKED — previous attempt stopped |
`)
  fs.writeFileSync(path.join(planDir, "001-first.md"), `# Plan 001: First

## Status

- **Depends on**: ${cycle ? "plans/002-*.md" : "none"}
`)
  fs.writeFileSync(path.join(planDir, "002-second.md"), `# Plan 002: Second

## Status

- **Depends on**: ${mismatch ? "none" : "plans/001-*.md"}
`)
  fs.writeFileSync(path.join(planDir, "003-parallel.md"), `# Plan 003: Parallel

## Status

- **Depends on**: none
`)
  return planDir
}

function expectFailure(fn, pattern) {
  assert.throws(fn, pattern)
}

const root = fs.mkdtempSync(path.join(os.tmpdir(), "plan-herder-test-"))
try {
  const valid = buildGraph(writeFixture(path.join(root, "valid")))
  assert.deepEqual(valid.ready, ["002", "003"])
  assert.deepEqual(valid.waiting, [])
  assert.deepEqual(valid.waves, [["001", "003"], ["002"]])
  assert.equal(valid.complete, false)
  assert.equal(valid.plans.find((plan) => plan.id === "003").statusDetail, "previous attempt stopped")

  expectFailure(
    () => buildGraph(writeFixture(path.join(root, "mismatch"), { mismatch: true })),
    /dependency mismatch/,
  )
  expectFailure(
    () => buildGraph(writeFixture(path.join(root, "cycle"), { cycle: true })),
    /Dependency cycle/,
  )

  const unindexed = writeFixture(path.join(root, "unindexed"))
  fs.writeFileSync(path.join(unindexed, "004-forgotten.md"), "# Plan 004\n\n- **Depends on**: none\n")
  expectFailure(() => buildGraph(unindexed), /missing from .*README\.md/)

  process.stdout.write("plan-graph tests passed\n")
} finally {
  fs.rmSync(root, { recursive: true, force: true })
}

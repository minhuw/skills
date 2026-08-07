#!/usr/bin/env node

import { spawnSync } from "node:child_process"
import path from "node:path"
import process from "node:process"
import { fileURLToPath } from "node:url"

const pluginRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..")
const repositoryRoot = path.resolve(pluginRoot, "../..")

const checks = [
  ["node", ["plugins/herder/agent-profiles/scripts/test.mjs"]],
  ["node", ["plugins/herder/skills/plans/scripts/test.mjs"]],
  ["node", ["plugins/herder/skills/install/scripts/test.mjs"]],
  ["node", ["plugins/herder/skills/fire/scripts/test.mjs"]],
  ["node", ["plugins/herder/skills/fire/scripts/coordination-ref-test.mjs"]],
  ["node", ["plugins/herder/skills/fire/scripts/checkout-state-test.mjs"]],
  ["node", ["plugins/herder/skills/fire/scripts/namespace-test.mjs"]],
  ["node", ["plugins/herder/skills/fire/scripts/assignment-bundle-test.mjs"]],
  ["node", ["plugins/herder/skills/fire/scripts/branch-model-test.mjs"]],
  ["node", ["plugins/herder/skills/fire/scripts/cleanup-test.mjs"]],
  ["node", ["plugins/herder/skills/dashboard/scripts/test.mjs"]],
  ["npm", ["run", "typecheck:pi"]],
  ["npm", ["run", "test:pi"]],
  ["npm", ["run", "test:runtime"]],
]

for (const [command, args] of checks) {
  process.stdout.write(`\n> ${command} ${args.join(" ")}\n`)
  const result = spawnSync(command, args, { cwd: repositoryRoot, stdio: "inherit" })
  if (result.error) throw result.error
  if (result.status !== 0) process.exit(result.status || 1)
}

process.stdout.write("\nHerder smoke suite passed.\n")

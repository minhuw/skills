#!/usr/bin/env node

import assert from "node:assert/strict"
import { execFileSync, spawnSync } from "node:child_process"
import { access, chmod, mkdtemp, readFile, readdir, rm, writeFile } from "node:fs/promises"
import { tmpdir } from "node:os"
import path from "node:path"
import process from "node:process"
import { fileURLToPath } from "node:url"

const scriptDir = path.dirname(fileURLToPath(import.meta.url))
const installer = path.join(scriptDir, "install-herder.mjs")
const pluginRoot = path.resolve(scriptDir, "../../..")
const manifest = JSON.parse(await readFile(path.join(pluginRoot, "agent-profiles/manifest.json"), "utf8"))
const fixtureRoot = await mkdtemp(path.join(tmpdir(), "herder-plugin-install-test-"))

let fakeCodex

function run(...args) {
  return execFileSync(process.execPath, [installer, ...args], {
    encoding: "utf8",
    env: { ...process.env, HERDER_CODEX_BIN: fakeCodex },
    stdio: ["ignore", "pipe", "pipe"],
  })
}

try {
  fakeCodex = path.join(fixtureRoot, "codex-enabled.mjs")
  await writeFile(fakeCodex, `#!/usr/bin/env node
if (process.argv.slice(2).join(" ") !== "features list") process.exit(2)
process.stdout.write("multi_agent_v2 under development true\\n")
`)
  await chmod(fakeCodex, 0o700)

  const projectRoot = path.join(fixtureRoot, "project")
  const args = ["--host", "codex", "--project-root", projectRoot]
  const first = run(...args)
  assert.match(first, /multi_agent_v2 is enabled/)
  assert.match(first, /tool_namespace = "herder_agents"/)
  assert.match(first, /max_concurrent_threads_per_session = 5/)
  assert.match(first, /Named profiles: eclipse, offcut/)

  const codexFiles = manifest.hosts.codex.files
  assert.equal(codexFiles.length, 6)
  assert.deepEqual([...new Set(codexFiles.map((file) => file.role))].sort(), ["plan-implementer", "plan-judge", "plan-reviewer"])
  for (const file of codexFiles) {
    const installed = path.join(projectRoot, ".codex/agents", file.target)
    assert.deepEqual(await readFile(installed), await readFile(path.join(pluginRoot, file.source)))
    assert.match(first, new RegExp(`Installed: .*${file.target.replace(/[.*+?^${}()|[\\]\\]/g, "\\$&")}`))
  }
  assert.deepEqual((await readdir(path.join(projectRoot, ".codex/agents"))).sort(), codexFiles.map((file) => file.target).sort())

  const second = run(...args)
  assert.match(second, /Unchanged: .*eclipse_plan_implementer\.toml/)

  const customized = path.join(projectRoot, ".codex/agents/eclipse_plan_implementer.toml")
  await writeFile(customized, "customized\n")
  const conflict = spawnSync(process.execPath, [installer, ...args], {
    encoding: "utf8",
    env: { ...process.env, HERDER_CODEX_BIN: fakeCodex },
  })
  assert.equal(conflict.status, 3)
  assert.equal(await readFile(customized, "utf8"), "customized\n")
  assert.match(run(...args, "--dry-run"), /Conflict \(would preserve\): .*eclipse_plan_implementer\.toml/)

  assert.match(run(...args, "--force"), /Installed \(replaced\): .*eclipse_plan_implementer\.toml/)
  const backupRoot = path.join(projectRoot, ".codex/.plan-herder-backups")
  const stamps = await readdir(backupRoot)
  assert.equal(stamps.length, 1)
  assert.equal(await readFile(path.join(backupRoot, stamps[0], "eclipse_plan_implementer.toml"), "utf8"), "customized\n")

  const claude = run("--host", "claude", "--project-root", path.join(fixtureRoot, "claude-project"))
  const claudeFiles = manifest.hosts.claude.files
  assert.equal(claudeFiles.length, 9)
  for (const file of claudeFiles) assert.match(claude, new RegExp(`Bundled: ${file.identifier}`))
  assert.match(claude, /Named profiles: eclipse, offcut, shannon/)

  const dryProject = path.join(fixtureRoot, "dry-project")
  assert.match(run("--host", "codex", "--project-root", dryProject, "--dry-run"), /Would install:/)
  await assert.rejects(access(path.join(dryProject, ".codex/agents")))

  const disabled = path.join(fixtureRoot, "codex-disabled.mjs")
  await writeFile(disabled, `#!/usr/bin/env node
if (process.argv.slice(2).join(" ") !== "features list") process.exit(2)
process.stdout.write("multi_agent_v2 under development false\\n")
`)
  await chmod(disabled, 0o700)
  fakeCodex = disabled
  const warning = run("--host", "codex", "--project-root", path.join(fixtureRoot, "warning-project"))
  assert.match(warning, /WARNING: Codex multi_agent_v2 is disabled/)
  assert.match(warning, /codex features enable multi_agent_v2/)

  const badHost = spawnSync(process.execPath, [installer, "--host", "other"], { encoding: "utf8" })
  assert.equal(badHost.status, 2)
  console.log("herder plugin installer tests passed")
} finally {
  await rm(fixtureRoot, { recursive: true, force: true })
}

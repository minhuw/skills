import assert from "node:assert/strict"
import { execFileSync, spawn } from "node:child_process"
import fs from "node:fs"
import os from "node:os"
import path from "node:path"
import readline from "node:readline"
import test from "node:test"
import { fileURLToPath } from "node:url"
import { stopService } from "../client.ts"
import { initPlanDir } from "../../skills/plans/scripts/herder-plans.mjs"

const runtimeRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..")

test("MCP exposes structured Herder control on top of the persistent service", { timeout: 20_000 }, async () => {
	const root = fs.mkdtempSync(path.join(os.tmpdir(), "herder-mcp-test-"))
	const planDirectory = path.join(root, "herder-plans")
	execFileSync("git", ["init", "-q", root])
	initPlanDir(planDirectory)
	const child = spawn(process.execPath, ["--experimental-strip-types", path.join(runtimeRoot, "mcp-server.ts")], {
		cwd: path.resolve(runtimeRoot, ".."),
		stdio: ["pipe", "pipe", "pipe"],
	})
	const lines = readline.createInterface({ input: child.stdout })
	const pending: Array<(value: Record<string, unknown>) => void> = []
	lines.on("line", (line) => pending.shift()?.(JSON.parse(line) as Record<string, unknown>))
	const call = async (request: Record<string, unknown>) => {
		const response = new Promise<Record<string, unknown>>((resolve) => pending.push(resolve))
		child.stdin.write(`${JSON.stringify(request)}\n`)
		return response
	}
	try {
		const initialized = await call({ jsonrpc: "2.0", id: 1, method: "initialize", params: { protocolVersion: "2025-06-18" } })
		assert.equal((initialized.result as Record<string, unknown>).protocolVersion, "2025-06-18")
		const listed = await call({ jsonrpc: "2.0", id: 2, method: "tools/list" })
		const tools = (listed.result as { tools: Array<Record<string, unknown>> }).tools
		assert.deepEqual(tools.map((tool) => tool.name), ["herder_control"])
		const status = await call({
			jsonrpc: "2.0",
			id: 3,
			method: "tools/call",
			params: { name: "herder_control", arguments: { operation: "status", planDirectory } },
		})
		assert.ok(status.result, JSON.stringify(status))
		const structured = (status.result as { structuredContent: Record<string, unknown> }).structuredContent
		assert.equal(structured.ok, true)
		assert.equal((structured.reply as Record<string, unknown>).status, "idle")
	} finally {
		child.stdin.end()
		await stopService(planDirectory).catch(() => {})
		fs.rmSync(root, { recursive: true, force: true })
	}
})

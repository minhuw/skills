#!/usr/bin/env node

import fs from "node:fs"
import http from "node:http"
import path from "node:path"
import process from "node:process"
import { fileURLToPath } from "node:url"
import { buildDashboardState } from "./dashboard-state.mjs"
import { describeDashboardHostAccess, enableDashboardHostAccess } from "./dashboard-host.mjs"

const SCRIPT_DIR = path.dirname(fileURLToPath(import.meta.url))
const ASSET_DIR = path.resolve(SCRIPT_DIR, "../assets")
const LOOPBACK_HOST = "127.0.0.1"
const DEFAULT_PORT = 4173
const ASSETS = new Map([
  ["/", { file: "index.html", type: "text/html; charset=utf-8" }],
  ["/dashboard.css", { file: "dashboard.css", type: "text/css; charset=utf-8" }],
  ["/dashboard.js", { file: "dashboard.js", type: "text/javascript; charset=utf-8" }],
])

function fail(message) {
  throw new Error(message)
}

function takeValue(args, index, name) {
  const value = args[index + 1]
  if (value === undefined || value.startsWith("--")) fail(`${name} requires a value`)
  return value
}

export function parseDashboardArguments(argv) {
  const options = {
    planDir: "herder-plans",
    planName: null,
    port: DEFAULT_PORT,
    snapshot: false,
    pretty: false,
    hostIntegration: true,
    help: false,
  }
  for (let index = 0; index < argv.length; index += 1) {
    const argument = argv[index]
    if (argument === "--snapshot") options.snapshot = true
    else if (argument === "--pretty") options.pretty = true
    else if (argument === "--no-host-integration") options.hostIntegration = false
    else if (["--help", "-h"].includes(argument)) options.help = true
    else if (["--plan-dir", "--plan-name", "--port"].includes(argument)) {
      const value = takeValue(argv, index, argument)
      index += 1
      if (argument === "--plan-dir") options.planDir = value
      else if (argument === "--plan-name") options.planName = value
      else {
        if (!/^\d+$/.test(value)) fail("--port must be an integer from 0 through 65535")
        options.port = Number.parseInt(value, 10)
        if (!Number.isSafeInteger(options.port) || options.port < 0 || options.port > 65535) {
          fail("--port must be an integer from 0 through 65535")
        }
      }
    } else {
      fail(`Unknown argument: ${argument}`)
    }
  }
  return options
}

function usage() {
  return [
    "Usage:",
    "  herder-dashboard [--plan-dir <path>] [--plan-name <name>] [--port <0..65535>] [--no-host-integration]",
    "  herder-dashboard --snapshot [--plan-dir <path>] [--plan-name <name>] [--pretty]",
    "",
    `The server binds only to ${LOOPBACK_HOST}. Use --port 0 to select an available port.`,
  ].join("\n")
}

function securityHeaders(contentType, cacheControl = "no-store") {
  return {
    "Cache-Control": cacheControl,
    "Content-Security-Policy": "default-src 'self'; script-src 'self'; style-src 'self'; img-src 'self' data:; connect-src 'self'; object-src 'none'; base-uri 'none'; frame-ancestors 'none'; form-action 'none'",
    "Content-Type": contentType,
    "Cross-Origin-Opener-Policy": "same-origin",
    "Cross-Origin-Resource-Policy": "same-origin",
    "Permissions-Policy": "camera=(), geolocation=(), microphone=()",
    "Referrer-Policy": "no-referrer",
    "X-Content-Type-Options": "nosniff",
    "X-Frame-Options": "DENY",
  }
}

function canonicalHost(value) {
  try {
    return new URL(`http://${String(value ?? "")}`).hostname.toLowerCase()
  } catch {
    return null
  }
}

function acceptsLoopbackHost(value, allowedHosts) {
  const host = canonicalHost(value)
  return ["127.0.0.1", "localhost", "[::1]"].includes(host) || allowedHosts.has(host)
}

function send(response, status, body, contentType, method, cacheControl) {
  const payload = Buffer.isBuffer(body) ? body : Buffer.from(body)
  response.writeHead(status, {
    ...securityHeaders(contentType, cacheControl),
    "Content-Length": payload.length,
  })
  if (method === "HEAD") response.end()
  else response.end(payload)
}

function readAssets() {
  return new Map([...ASSETS.entries()].map(([route, asset]) => {
    const file = path.join(ASSET_DIR, asset.file)
    if (!fs.existsSync(file) || !fs.statSync(file).isFile()) fail(`Dashboard asset is missing: ${file}`)
    return [route, { ...asset, content: fs.readFileSync(file) }]
  }))
}

export async function createDashboardServer(input = {}) {
  const planDir = path.resolve(input.planDir ?? "herder-plans")
  const planName = input.planName ?? null
  const port = input.port ?? DEFAULT_PORT
  const stateProvider = input.stateProvider ?? (() => buildDashboardState({ planDir, planName }))
  const allowedHosts = new Set()
  const assets = readAssets()
  stateProvider()

  const server = http.createServer((request, response) => {
    const method = request.method ?? "GET"
    if (!acceptsLoopbackHost(request.headers.host, allowedHosts)) {
      send(response, 421, JSON.stringify({ error: "invalid-host" }), "application/json; charset=utf-8", method)
      return
    }
    if (!new Set(["GET", "HEAD"]).has(method)) {
      response.setHeader("Allow", "GET, HEAD")
      send(response, 405, JSON.stringify({ error: "method-not-allowed" }), "application/json; charset=utf-8", method)
      return
    }
    let pathname
    try {
      pathname = new URL(request.url ?? "/", `http://${LOOPBACK_HOST}`).pathname
    } catch {
      send(response, 400, JSON.stringify({ error: "invalid-request-url" }), "application/json; charset=utf-8", method)
      return
    }
    if (pathname === "/api/state") {
      try {
        send(response, 200, `${JSON.stringify(stateProvider())}\n`, "application/json; charset=utf-8", method)
      } catch (error) {
        send(response, 503, `${JSON.stringify({ error: "snapshot-unavailable", message: error.message })}\n`, "application/json; charset=utf-8", method)
      }
      return
    }
    if (pathname === "/api/health") {
      send(response, 200, `${JSON.stringify({ ok: true, readOnly: true })}\n`, "application/json; charset=utf-8", method)
      return
    }
    const asset = assets.get(pathname)
    if (asset) {
      send(response, 200, asset.content, asset.type, method, "no-cache")
      return
    }
    send(response, 404, JSON.stringify({ error: "not-found" }), "application/json; charset=utf-8", method)
  })

  server.on("clientError", (_error, socket) => {
    socket.end("HTTP/1.1 400 Bad Request\r\nConnection: close\r\n\r\n")
  })

  await new Promise((resolve, reject) => {
    server.once("error", reject)
    server.listen(port, LOOPBACK_HOST, resolve)
  })
  const address = server.address()
  if (!address || typeof address === "string") {
    server.close()
    fail("Dashboard server did not receive a TCP address")
  }
  const url = `http://${LOOPBACK_HOST}:${address.port}/`
  const allowHost = (value) => {
    const host = canonicalHost(value)
    if (host) allowedHosts.add(host)
  }
  return {
    host: LOOPBACK_HOST,
    port: address.port,
    url,
    server,
    allowHost,
    close: () => new Promise((resolve, reject) => server.close((error) => (error ? reject(error) : resolve()))),
  }
}

async function main(argv) {
  const options = parseDashboardArguments(argv)
  if (options.help) {
    process.stdout.write(`${usage()}\n`)
    return
  }
  if (options.snapshot) {
    const state = buildDashboardState(options)
    process.stdout.write(`${JSON.stringify(state, null, options.pretty ? 2 : 0)}\n`)
    return
  }
  const dashboard = await createDashboardServer(options)
  const stop = async () => {
    await dashboard.close()
    process.exitCode = 0
  }
  process.once("SIGINT", stop)
  process.once("SIGTERM", stop)
  process.stdout.write([
    "Herder Dashboard — read-only local observer",
    `URL: ${dashboard.url}`,
    `Plan directory: ${path.resolve(options.planDir)}`,
    "Press Ctrl+C to stop.",
  ].join("\n"))
  if (options.hostIntegration) {
    const access = await enableDashboardHostAccess({
      url: dashboard.url,
      allowHost: dashboard.allowHost,
    })
    for (const line of describeDashboardHostAccess(access)) process.stdout.write(`\n${line}`)
  }
  process.stdout.write("\n")
}

const isMain = process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)
if (isMain) {
  main(process.argv.slice(2)).catch((error) => {
    process.stderr.write(`herder-dashboard: ${error.message}\n`)
    process.exitCode = 1
  })
}

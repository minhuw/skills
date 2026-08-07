#!/usr/bin/env -S node --experimental-strip-types

import path from "node:path";
import process from "node:process";
import readline from "node:readline";
import { ensureService, requestService } from "./client.ts";

interface Request {
	jsonrpc: "2.0";
	id?: string | number | null;
	method: string;
	params?: Record<string, unknown>;
}

const TOOL = {
	name: "herder_control",
	description: "Start, resume, revise, inspect, stop, or deliver a structured host event to a deterministic Herder run.",
	inputSchema: {
		type: "object",
		additionalProperties: false,
		required: ["operation", "planDirectory"],
		properties: {
			operation: { enum: ["fire", "resume", "revise", "status", "stop", "event"] },
			planDirectory: { type: "string" },
			repositoryRoot: { type: "string" },
			planName: { type: "string" },
			host: { enum: ["codex", "claude"] },
			profile: { type: "string" },
			maxParallel: { type: "integer", minimum: 1, maximum: 32 },
			event: { type: "object" },
		},
	},
} as const;

function write(value: unknown): void {
	process.stdout.write(`${JSON.stringify(value)}\n`);
}

function result(id: Request["id"], value: unknown): void {
	write({ jsonrpc: "2.0", id, result: value });
}

function toolResult(id: Request["id"], value: unknown): void {
	result(id, {
		content: [{ type: "text", text: JSON.stringify(value) }],
		structuredContent: value,
	});
}

function failure(id: Request["id"], error: unknown, code = -32603): void {
	write({ jsonrpc: "2.0", id, error: { code, message: error instanceof Error ? error.message : String(error) } });
}

async function control(args: Record<string, unknown>): Promise<Record<string, unknown>> {
	const operation = String(args.operation || "");
	if (typeof args.planDirectory !== "string" || !args.planDirectory.trim()) throw new Error("planDirectory is required");
	const planDirectory = path.resolve(args.planDirectory);
	const service = await ensureService(planDirectory);
	if (operation === "status") return requestService(service, "/v1/status");
	if (operation === "stop") return requestService(service, "/v1/stop", {});
	if (operation === "event") {
		if (!args.event || typeof args.event !== "object" || Array.isArray(args.event)) throw new Error("event operation requires a structured event object");
		return requestService(service, "/v1/event", args.event);
	}
	if (!["fire", "resume", "revise"].includes(operation)) throw new Error(`Unknown Herder operation: ${operation}`);
	const host = String(args.host || "");
	if (!repositoryHost(host)) throw new Error("fire/resume/revise requires host codex or claude");
	if (typeof args.repositoryRoot !== "string" || !args.repositoryRoot.trim()) throw new Error("fire/resume/revise requires repositoryRoot");
	const repositoryRoot = path.resolve(args.repositoryRoot);
	return requestService(service, "/v1/start", {
		mode: operation,
		repositoryRoot,
		planDirectory,
		host,
		...(args.planName ? { planName: String(args.planName) } : {}),
		...(args.profile ? { profile: String(args.profile) } : {}),
		...(args.maxParallel === undefined ? {} : { maxParallel: Number(args.maxParallel) }),
		dashboardUrl: service.forwardedUrl || service.dashboardUrl,
	});
}

function repositoryHost(value: string): value is "codex" | "claude" {
	return value === "codex" || value === "claude";
}

async function handle(request: Request): Promise<void> {
	if (request.method === "initialize") {
		result(request.id, {
			protocolVersion: String(request.params?.protocolVersion || "2025-06-18"),
			capabilities: { tools: {} },
			serverInfo: { name: "herder", version: "1" },
		});
		return;
	}
	if (request.method === "ping") {
		result(request.id, {});
		return;
	}
	if (request.method === "tools/list") {
		result(request.id, { tools: [TOOL] });
		return;
	}
	if (request.method === "tools/call") {
		if (request.params?.name !== TOOL.name) throw new Error(`Unknown tool: ${String(request.params?.name)}`);
		const args = request.params.arguments;
		if (!args || typeof args !== "object" || Array.isArray(args)) throw new Error("herder_control requires an arguments object");
		toolResult(request.id, await control(args as Record<string, unknown>));
		return;
	}
	if (request.id !== undefined) failure(request.id, `Method not found: ${request.method}`, -32601);
}

const input = readline.createInterface({ input: process.stdin, crlfDelay: Infinity });
input.on("line", (line) => {
	if (!line.trim()) return;
	void (async () => {
		let request: Request;
		try { request = JSON.parse(line) as Request; }
		catch (error) { failure(null, `Invalid JSON: ${(error as Error).message}`, -32700); return; }
		if (request.method.startsWith("notifications/")) return;
		try { await handle(request); }
		catch (error) { failure(request.id, error); }
	})();
});

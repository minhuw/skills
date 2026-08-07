import assert from "node:assert/strict";
import test from "node:test";
import {
	SUBAGENT_RPC_REPLY_PREFIX,
	SUBAGENT_RPC_REQUEST_EVENT,
	SubagentRpcClient,
	asyncRunIdentity,
	type EventBus,
} from "../lib/rpc.ts";
import { HERDER_STATE_ENTRY, restoreLastRun, type HerderRunState } from "../lib/state.ts";

class MockBus implements EventBus {
	private handlers = new Map<string, Set<(payload: unknown) => void>>();
	reply: "success" | "failure" | "none" = "success";
	lastRequest?: Record<string, unknown>;

	on(event: string, handler: (payload: unknown) => void): () => void {
		const handlers = this.handlers.get(event) || new Set();
		handlers.add(handler);
		this.handlers.set(event, handlers);
		return () => handlers.delete(handler);
	}

	emit(event: string, payload: unknown): void {
		if (event !== SUBAGENT_RPC_REQUEST_EVENT) {
			for (const handler of this.handlers.get(event) || []) handler(payload);
			return;
		}
		this.lastRequest = payload as Record<string, unknown>;
		if (this.reply === "none") return;
		const requestId = String(this.lastRequest.requestId);
		queueMicrotask(() => this.emit(`${SUBAGENT_RPC_REPLY_PREFIX}${requestId}`, {
			version: 1,
			requestId,
			success: this.reply === "success",
			...(this.reply === "success" ? { data: { ok: true } } : { error: { message: "rejected" } }),
		}));
	}
}

test("RPC client uses pi-subagents public request/reply events", async () => {
	const bus = new MockBus();
	assert.deepEqual(await new SubagentRpcClient(bus).call("ping", { probe: true }), { ok: true });
	assert.equal(bus.lastRequest?.method, "ping");
	assert.deepEqual(bus.lastRequest?.params, { probe: true });
	assert.deepEqual(bus.lastRequest?.source, { extension: "herder-pi" });

	bus.reply = "failure";
	await assert.rejects(() => new SubagentRpcClient(bus).call("spawn"), /rejected/);
	bus.reply = "none";
	await assert.rejects(() => new SubagentRpcClient(bus, 5).call("status"), /timed out/);
});

test("async run identity is fail-closed", () => {
	assert.deepEqual(asyncRunIdentity({ details: { asyncId: "run-1", asyncDir: "/tmp/run-1" } }), { runId: "run-1", asyncDir: "/tmp/run-1" });
	assert.throws(() => asyncRunIdentity({}), /did not return an async run ID/);
});

test("session restoration uses the newest valid Herder entry", () => {
	const state: HerderRunState = {
		version: 1,
		mode: "fire",
		status: "running",
		runId: "run-1",
		repoRoot: "/tmp/repo",
		planDir: "/tmp/repo/herder-plans",
		profile: "offcut",
		maxParallel: 5,
		dashboardEnabled: true,
		startedAt: 1,
		updatedAt: 2,
	};
	assert.deepEqual(restoreLastRun([
		{ type: "custom", customType: HERDER_STATE_ENTRY, data: { nope: true } },
		{ type: "custom", customType: HERDER_STATE_ENTRY, data: state },
	]), state);
});

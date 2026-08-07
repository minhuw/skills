import { randomUUID } from "node:crypto";

export const SUBAGENT_RPC_REQUEST_EVENT = "subagents:rpc:v1:request";
export const SUBAGENT_RPC_READY_EVENT = "subagents:rpc:v1:ready";
export const SUBAGENT_RPC_REPLY_PREFIX = "subagents:rpc:v1:reply:";
export const SUBAGENT_ASYNC_COMPLETE_EVENT = "subagent:async-complete";

export type SubagentRpcMethod = "ping" | "status" | "spawn" | "steer" | "interrupt" | "stop" | "resume";

export interface EventBus {
	on(event: string, handler: (payload: unknown) => void): (() => void) | void;
	emit(event: string, payload: unknown): void;
}

interface RpcReply {
	version: number;
	requestId: string;
	success: boolean;
	data?: unknown;
	error?: { code?: string; message?: string };
}

export class SubagentRpcClient {
	private readonly events: EventBus;
	private readonly timeoutMs: number;

	constructor(events: EventBus, timeoutMs = 15_000) {
		this.events = events;
		this.timeoutMs = timeoutMs;
	}

	call<T = unknown>(method: SubagentRpcMethod, params?: unknown): Promise<T> {
		const requestId = randomUUID();
		const replyEvent = `${SUBAGENT_RPC_REPLY_PREFIX}${requestId}`;
		return new Promise<T>((resolve, reject) => {
			let settled = false;
			let unsubscribe: (() => void) | undefined;
			const finish = (callback: () => void) => {
				if (settled) return;
				settled = true;
				clearTimeout(timer);
				unsubscribe?.();
				callback();
			};
			const timer = setTimeout(() => finish(() => reject(new Error(`pi-subagents RPC ${method} timed out.`))), this.timeoutMs);
			const maybeUnsubscribe = this.events.on(replyEvent, (payload) => {
				const reply = payload as RpcReply;
				if (reply?.requestId !== requestId) return;
				if (reply.success) finish(() => resolve(reply.data as T));
				else finish(() => reject(new Error(reply.error?.message || `pi-subagents RPC ${method} failed.`)));
			});
			if (typeof maybeUnsubscribe === "function") unsubscribe = maybeUnsubscribe;
			this.events.emit(SUBAGENT_RPC_REQUEST_EVENT, {
				version: 1,
				requestId,
				method,
				...(params === undefined ? {} : { params }),
				source: { extension: "herder-pi" },
			});
		});
	}
}

export function asyncRunIdentity(data: unknown): { runId: string; asyncDir?: string } {
	const record = data && typeof data === "object" && !Array.isArray(data) ? data as Record<string, unknown> : {};
	const details = record.details && typeof record.details === "object" && !Array.isArray(record.details)
		? record.details as Record<string, unknown>
		: {};
	const runId = [details.asyncId, details.runId, record.runId, record.id].find((value) => typeof value === "string" && value.length > 0);
	if (typeof runId !== "string") throw new Error("pi-subagents did not return an async run ID.");
	const asyncDir = [details.asyncDir, record.asyncDir].find((value) => typeof value === "string" && value.length > 0);
	return { runId, ...(typeof asyncDir === "string" ? { asyncDir } : {}) };
}

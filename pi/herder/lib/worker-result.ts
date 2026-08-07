import type { UsageEvidence } from "../../../plugins/herder/runtime/protocol.ts";

function record(value: unknown): Record<string, unknown> | undefined {
	return value && typeof value === "object" && !Array.isArray(value) ? value as Record<string, unknown> : undefined;
}

function resultRecords(value: unknown): Record<string, unknown>[] {
	const root = record(value);
	if (!root) return [];
	const details = record(root.details);
	return [root.results, details?.results]
		.flatMap((candidate) => Array.isArray(candidate) ? candidate : [])
		.map(record)
		.filter((candidate): candidate is Record<string, unknown> => Boolean(candidate));
}

function nonemptyString(...values: unknown[]): string | undefined {
	return values.find((value): value is string => typeof value === "string" && value.trim().length > 0);
}

function finiteCount(value: unknown): number | undefined {
	return typeof value === "number" && Number.isSafeInteger(value) && value >= 0 ? value : undefined;
}

function isoTime(value: unknown): string | undefined {
	if (typeof value === "string" && !Number.isNaN(Date.parse(value))) return new Date(value).toISOString();
	if (typeof value === "number" && Number.isFinite(value) && value >= 0) return new Date(value).toISOString();
	return undefined;
}

export function completionText(value: unknown): string | undefined {
	const root = record(value);
	if (!root) return undefined;
	for (const child of resultRecords(root)) {
		const output = nonemptyString(child.output, child.text, child.result, child.summary);
		if (output) return output;
	}
	const details = record(root.details);
	const nestedResult = record(root.result);
	return nonemptyString(
		nestedResult ? completionText(nestedResult) : undefined,
		root.output,
		root.text,
		typeof root.result === "string" ? root.result : undefined,
		details?.output,
		details?.text,
		details?.result,
		root.summary,
	);
}

export function completionFailed(value: unknown): boolean {
	const root = record(value);
	if (!root) return true;
	if (root.success === false || ["failed", "stopped", "interrupted", "paused", "rejected"].includes(String(root.state))) return true;
	return resultRecords(root).some((child) => child.success === false || ["failed", "stopped", "interrupted", "paused", "rejected"].includes(String(child.state)));
}

export function completionUsage(value: unknown): Partial<UsageEvidence> | undefined {
	const root = record(value);
	if (!root) return undefined;
	const details = record(root.details);
	const tokens = record(root.totalTokens) ?? record(details?.totalTokens);
	const inputTokens = finiteCount(tokens?.input);
	const cachedInputTokens = finiteCount(tokens?.cachedInput ?? tokens?.cacheRead);
	const outputTokens = finiteCount(tokens?.output);
	const reasoningTokens = finiteCount(tokens?.reasoning);
	const durationMs = finiteCount(root.durationMs ?? details?.durationMs);
	const finishedAt = isoTime(root.timestamp ?? root.endedAt ?? details?.timestamp ?? details?.endedAt);
	const startedAt = isoTime(root.startedAt ?? details?.startedAt)
		?? (finishedAt && durationMs !== undefined ? new Date(Date.parse(finishedAt) - durationMs).toISOString() : undefined);
	if ([inputTokens, cachedInputTokens, outputTokens, reasoningTokens, durationMs, startedAt, finishedAt].every((item) => item === undefined)) return undefined;
	return {
		...(inputTokens === undefined ? {} : { inputTokens }),
		...(cachedInputTokens === undefined ? {} : { cachedInputTokens }),
		...(outputTokens === undefined ? {} : { outputTokens }),
		...(reasoningTokens === undefined ? {} : { reasoningTokens }),
		source: "pi-subagents async result",
		...(startedAt ? { startedAt } : {}),
		...(finishedAt ? { finishedAt } : {}),
		...(durationMs === undefined ? {} : { durationMs }),
	};
}

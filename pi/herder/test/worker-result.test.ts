import assert from "node:assert/strict";
import test from "node:test";
import { completionFailed, completionText, completionUsage } from "../lib/worker-result.ts";

test("Pi completion selects the exact child envelope instead of a workflow summary", () => {
	const payload = {
		success: true,
		state: "complete",
		output: "Workflow completed with 1 child run(s).",
		results: [{ success: true, output: "STATUS: COMPLETE\nCOMMITS: abc123" }],
	};
	assert.equal(completionText(payload), "STATUS: COMPLETE\nCOMMITS: abc123");
	assert.equal(completionFailed(payload), false);
});

test("Pi completion rejects a failed child even when its wrapper completed", () => {
	assert.equal(completionFailed({ success: true, state: "complete", results: [{ success: false, output: "failed" }] }), true);
});

test("Pi completion records direct async token and timing evidence", () => {
	assert.deepEqual(completionUsage({
		totalTokens: { input: 120, output: 30 },
		timestamp: 1_800_000,
		durationMs: 500,
	}), {
		inputTokens: 120,
		outputTokens: 30,
		source: "pi-subagents async result",
		startedAt: "1970-01-01T00:29:59.500Z",
		finishedAt: "1970-01-01T00:30:00.000Z",
		durationMs: 500,
	});
});

import assert from "node:assert/strict";
import { mkdtempSync, mkdirSync, realpathSync, rmSync, symlinkSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { parseFireArguments, parsePlanDirArguments, tokenizeArguments } from "../lib/arguments.ts";
import { resolvePlanDirectory } from "../lib/paths.ts";

test("tokenizes shell-style plan paths without invoking a shell", () => {
	assert.deepEqual(tokenizeArguments(`"plans with spaces" --profile 'offcut'`), ["plans with spaces", "--profile", "offcut"]);
	assert.deepEqual(tokenizeArguments("plans\\ with\\ spaces"), ["plans with spaces"]);
	assert.throws(() => tokenizeArguments("'unfinished"), /unterminated quote/);
});

test("fire defaults to a five-worker pool and an ephemeral dashboard port", () => {
	assert.deepEqual(parseFireArguments("", "fire"), {
		mode: "fire",
		planDir: "herder-plans",
		maxParallel: 5,
		dashboardPort: 0,
	});
	assert.deepEqual(parseFireArguments("", "resume"), {
		mode: "resume",
		planDir: "herder-plans",
		dashboardPort: 0,
	});
	assert.deepEqual(parseFireArguments("custom --profile offcut --max-parallel 7 --dashboard-port 4312", "resume"), {
		mode: "resume",
		planDir: "custom",
		profile: "offcut",
		maxParallel: 7,
		dashboardPort: 4312,
	});
});

test("argument validation is fail-closed", () => {
	assert.throws(() => parseFireArguments("--max-parallel 0", "fire"), /between 1 and 32/);
	assert.throws(() => parseFireArguments("--dashboard-port 65536", "fire"), /0 through 65535/);
	assert.throws(() => parseFireArguments("--unknown", "fire"), /Unknown option/);
	assert.throws(() => parseFireArguments("one two", "fire"), /Unexpected argument/);
	assert.deepEqual(parsePlanDirArguments(""), {});
});

test("plan paths cannot escape the repository lexically or through symlinks", () => {
	const root = mkdtempSync(path.join(os.tmpdir(), "herder-pi-paths-"));
	try {
		const repo = path.join(root, "repo");
		const planDir = path.join(repo, "herder-plans");
		const outside = path.join(root, "outside");
		mkdirSync(planDir, { recursive: true });
		mkdirSync(outside);
		assert.equal(resolvePlanDirectory(repo, "herder-plans"), realpathSync(planDir));
		assert.throws(() => resolvePlanDirectory(repo, ".."), /must stay inside/);
		symlinkSync(outside, path.join(repo, "escaped-plans"));
		assert.throws(() => resolvePlanDirectory(repo, "escaped-plans"), /must stay inside/);
	} finally {
		rmSync(root, { recursive: true, force: true });
	}
});

#!/usr/bin/env node

import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";

const SCRIPT = path.join(path.dirname(fileURLToPath(import.meta.url)), "grill-others.mjs");
let failures = 0;

function run(args, { input, env: extraEnv } = {}) {
  const env = { ...process.env, ...(extraEnv ?? {}) };
  delete env.GRILL_OTHERS_MOCK;
  return spawnSync("node", [SCRIPT, ...args], { input, encoding: "utf8", env });
}

function runJson(args, options) {
  const result = run([...args, "--json"], options);
  assert.equal(result.status, 0, `expected exit 0, got ${result.status}: ${result.stderr}`);
  return JSON.parse(result.stdout);
}

function writeFakeCommand(dir, name, script) {
  fs.mkdirSync(dir, { recursive: true });
  const commandPath = path.join(dir, name);
  fs.writeFileSync(commandPath, `#!/usr/bin/env node\n${script}\n`, "utf8");
  fs.chmodSync(commandPath, 0o755);
  return commandPath;
}

const JUROR_JSON = `JSON.stringify({
  stance: "recommend",
  recommendation: "model flag accepted",
  rationale: "The fake harness received the expected harness arguments.",
  assumptions: [],
  risks: [],
  repo_findings: [process.env.GRILL_TEST_VALUE || ""].filter(Boolean),
  questions_for_other_jurors: [],
  confidence: 0.9
})`;

function test(name, fn) {
  try {
    fn();
    console.log(`ok - ${name}`);
  } catch (error) {
    failures += 1;
    console.error(`FAIL - ${name}\n  ${error.message}`);
  }
}

const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "grill-others-test-"));

test("start creates a sequential v1 state and resolves one focused decision", () => {
  const { state, decisionSummaries } = runJson(["start", "--mock", "--cwd", tmp, "--prompt", "Should we cache results in memory?"]);
  assert.equal(state.version, 1);
  assert.equal(state.mode, "sequential");
  assert.equal(state.decisions.length, 1);
  assert.equal(state.decisions[0].status, "resolved");
  assert.equal(state.final, null, "start must pause after one decision for review");
  assert.equal(decisionSummaries.length, 1);
  assert.equal(decisionSummaries[0].roundSummaries[0].stance_counts.recommend, 3);
  assert.equal(decisionSummaries[0].roundSummaries[0].participants.length, 3);
});

test("markdown output is marked as a mock run and shows a single decision with a continue command", () => {
  const result = run(["start", "--mock", "--cwd", tmp, "--prompt", "anything"]);
  assert.equal(result.status, 0, result.stderr);
  assert.match(result.stdout, /MOCK RUN/);
  assert.match(result.stdout, /Mode: sequential/);
  assert.match(result.stdout, /## Decision 1/);
  assert.match(result.stdout, /## Jury Rounds/);
  assert.match(result.stdout, /continue --state/);
  assert.doesNotMatch(result.stdout, /## Latest Jury Round/);
});

test("unresolved jury answers pause the active decision and answer resumes that decision", () => {
  const { statePath, state } = runJson(["start", "--mock", "--cwd", tmp, "--prompt", "no-majority-demo: pick a header color"]);
  const decision = state.decisions[0];
  assert.equal(decision.status, "needs-user");
  assert.ok(Array.isArray(decision.pendingUserQuestions), "expected pending user questions");
  assert.equal(decision.pendingUserQuestions.length, 1, "the original focused question should be escalated once");
  assert.equal(decision.pendingUserQuestions[0].opinions.length, 3);
  const answered = runJson(["answer", "--mock", "--state", statePath, "--answer", "blue"]);
  assert.equal(answered.state.decisions[0].status, "resolved");
  assert.equal(answered.state.decisions[0].userAnswers.length, 1);
  assert.equal(answered.state.decisions[0].userAnswers[0].questions.length, 1);
  assert.equal(answered.state.decisions[0].pendingUserQuestions, null);
  assert.ok(answered.state.decisions[0].final, "expected a decision final after the answer");
});


test("pending user-question markdown includes decision summary before the question", () => {
  const result = run(["start", "--mock", "--cwd", tmp, "--prompt", "no-majority-demo: pick a header color"]);
  assert.equal(result.status, 0, result.stderr);
  assert.match(result.stdout, /## Decision 1[\s\S]*## Jury Rounds[\s\S]*## Questions For User/);
  assert.match(result.stdout, /Juror positions:/);
});

test("continue finalizes when the planner says no more questions are needed", () => {
  const { statePath } = runJson(["start", "--mock", "--cwd", tmp, "--prompt", "Should we cache results in memory?"]);
  const continued = runJson(["continue", "--mock", "--state", statePath]);
  assert.ok(continued.state.final, "expected a top-level final after continue");
  assert.equal(continued.state.final.resolved_decisions, 1);
  assert.match(continued.state.final.recommendation, /Resolved focused decisions/);
});

test("continue can run a second focused question before finalizing", () => {
  const { statePath } = runJson(["start", "--mock", "--cwd", tmp, "--prompt", "two-question-demo: check two risks"]);
  const second = runJson(["continue", "--mock", "--state", statePath]);
  assert.equal(second.state.decisions.length, 2);
  assert.equal(second.state.decisions[1].status, "resolved");
  assert.equal(second.state.final, null);
  const done = runJson(["continue", "--mock", "--state", statePath]);
  assert.ok(done.state.final);
  assert.equal(done.state.final.resolved_decisions, 2);
});

test("stance disagreement triggers a challenge round inside one decision", () => {
  const { state, decisionSummaries } = runJson(["start", "--mock", "--cwd", tmp, "--prompt", "disagree-demo: architecture A or B"]);
  const decision = state.decisions[0];
  assert.equal(decision.rounds.length, 2, "needs-evidence stances must trigger exactly one challenge round");
  assert.ok(decision.final);
  assert.equal(decision.final.consensus, true);
  assert.match(decision.final.recommendation, /reversible/, "the 2-of-3 majority recommendation must win");
  assert.equal(decision.final.unresolved_disagreements.length, 0);
  assert.ok(decisionSummaries[0].roundSummaries[0].divergences.some((entry) => entry.type === "stance-split"));
  assert.ok(decisionSummaries[0].roundSummaries[1].divergences.some((entry) => entry.type === "recommendation-split"));
});

test("routed juror questions trigger a challenge round inside one decision", () => {
  const { state } = runJson(["start", "--mock", "--cwd", tmp, "--prompt", "route-demo: check the default"]);
  assert.equal(state.decisions[0].rounds.length, 2);
  assert.ok(state.decisions[0].final);
});

test("answer reuses custom agents persisted in sequential state", () => {
  const configPath = path.join(tmp, "agents.json");
  fs.writeFileSync(configPath, JSON.stringify({ agents: [{ name: "example", command: "example-agent", args: ["{{prompt}}"] }] }));
  const { statePath, state } = runJson([
    "start",
    "--mock",
    "--cwd",
    tmp,
    "--agent-config",
    configPath,
    "--agents",
    "codex,example",
    "--prompt",
    "no-majority-demo: choose"
  ]);
  assert.deepEqual(state.agents.map((agent) => agent.name), ["codex", "example"]);
  const answered = runJson(["answer", "--mock", "--state", statePath, "--answer", "blue"]);
  assert.deepEqual(answered.state.agents.map((agent) => agent.name), ["codex", "example"]);
  assert.ok(answered.state.decisions[0].final, "answer must succeed without re-passing --agent-config");
});

test("agent config supports multiple instances of one built-in harness", () => {
  const configPath = path.join(tmp, "built-in-variants.json");
  fs.writeFileSync(
    configPath,
    JSON.stringify({
      agents: [
        { name: "codex-gpt5", harness: "codex", model: "gpt-5" },
        { name: "codex-o3", label: "Codex o3", harness: "codex", model: "o3" }
      ]
    })
  );
  const { state, decisionSummaries } = runJson([
    "start",
    "--mock",
    "--cwd",
    tmp,
    "--agent-config",
    configPath,
    "--agents",
    "codex-gpt5,codex-o3",
    "--question",
    "Which configured model variant should review this?",
    "--prompt",
    "check model variants"
  ]);
  assert.deepEqual(
    state.agents.map((agent) => ({ name: agent.name, harness: agent.harness, model: agent.model })),
    [
      { name: "codex-gpt5", harness: "codex", model: "gpt-5" },
      { name: "codex-o3", harness: "codex", model: "o3" }
    ]
  );
  assert.deepEqual(Object.keys(state.decisions[0].rounds[0].responses).sort(), ["codex-gpt5", "codex-o3"]);
  assert.deepEqual(
    decisionSummaries[0].roundSummaries[0].participants.map((participant) => participant.agent).sort(),
    ["codex-gpt5", "codex-o3"]
  );
});

test("duplicate agent names are rejected case-insensitively", () => {
  const configPath = path.join(tmp, "duplicate-agents.json");
  fs.writeFileSync(
    configPath,
    JSON.stringify({
      agents: [
        { name: "codex-gpt5", harness: "codex", model: "gpt-5" },
        { name: "Codex-GPT5", harness: "codex", model: "o3" }
      ]
    })
  );
  const result = run([
    "start",
    "--mock",
    "--cwd",
    tmp,
    "--agent-config",
    configPath,
    "--agents",
    "codex-gpt5",
    "--prompt",
    "hi"
  ]);
  assert.equal(result.status, 1);
  assert.match(result.stderr, /Duplicate agent name "Codex-GPT5"/);
});

test("codex harness passes per-instance model to the CLI", () => {
  const bin = fs.mkdtempSync(path.join(tmp, "fake-codex-bin-"));
  writeFakeCommand(
    bin,
    "codex",
    `
const argv = process.argv.slice(2);
const modelIndex = argv.indexOf("-m");
if (modelIndex === -1 || argv[modelIndex + 1] !== "gpt-5") {
  console.error(JSON.stringify(argv));
  process.exit(2);
}
console.log(${JUROR_JSON});
`
  );
  const configPath = path.join(tmp, "codex-model.json");
  fs.writeFileSync(configPath, JSON.stringify({ agents: [{ name: "codex-gpt5", harness: "codex", model: "gpt-5" }] }));
  const { state } = runJson(
    [
      "start",
      "--cwd",
      tmp,
      "--agent-config",
      configPath,
      "--agents",
      "codex-gpt5",
      "--question",
      "Does the Codex model flag propagate?",
      "--prompt",
      "hi"
    ],
    { env: { PATH: `${bin}${path.delimiter}${process.env.PATH}` } }
  );
  assert.equal(state.decisions[0].rounds[0].responses["codex-gpt5"].ok, true);
});

test("claude harness passes per-instance model to the CLI", () => {
  const bin = fs.mkdtempSync(path.join(tmp, "fake-claude-bin-"));
  writeFakeCommand(
    bin,
    "claude",
    `
const argv = process.argv.slice(2);
const modelIndex = argv.indexOf("--model");
if (modelIndex === -1 || argv[modelIndex + 1] !== "sonnet") {
  console.error(JSON.stringify(argv));
  process.exit(2);
}
console.log(${JUROR_JSON});
`
  );
  const configPath = path.join(tmp, "claude-model.json");
  fs.writeFileSync(configPath, JSON.stringify({ agents: [{ name: "claude-sonnet", harness: "claude", model: "sonnet" }] }));
  const { state } = runJson(
    [
      "start",
      "--cwd",
      tmp,
      "--agent-config",
      configPath,
      "--agents",
      "claude-sonnet",
      "--question",
      "Does the Claude model flag propagate?",
      "--prompt",
      "hi"
    ],
    { env: { PATH: `${bin}${path.delimiter}${process.env.PATH}` } }
  );
  assert.equal(state.decisions[0].rounds[0].responses["claude-sonnet"].ok, true);
});

test("pi harness passes per-instance provider and model to the CLI", () => {
  const bin = fs.mkdtempSync(path.join(tmp, "fake-pi-bin-"));
  writeFakeCommand(
    bin,
    "pi",
    `
const argv = process.argv.slice(2);
const providerIndex = argv.indexOf("--provider");
const modelIndex = argv.indexOf("--model");
if (providerIndex === -1 || argv[providerIndex + 1] !== "openai" || modelIndex === -1 || argv[modelIndex + 1] !== "gpt-4o") {
  console.error(JSON.stringify(argv));
  process.exit(2);
}
console.log(${JUROR_JSON});
`
  );
  const configPath = path.join(tmp, "pi-model.json");
  fs.writeFileSync(
    configPath,
    JSON.stringify({ agents: [{ name: "pi-openai", harness: "pi", provider: "openai", model: "gpt-4o" }] })
  );
  const { state } = runJson(
    [
      "start",
      "--cwd",
      tmp,
      "--agent-config",
      configPath,
      "--agents",
      "pi-openai",
      "--question",
      "Does the Pi model flag propagate?",
      "--prompt",
      "hi"
    ],
    { env: { PATH: `${bin}${path.delimiter}${process.env.PATH}` } }
  );
  assert.equal(state.decisions[0].rounds[0].responses["pi-openai"].ok, true);
});

test("command harness expands model/provider placeholders and per-agent env", () => {
  const configPath = path.join(tmp, "command-model.json");
  fs.writeFileSync(
    configPath,
    JSON.stringify({
      agents: [
        {
          name: "cmd-model",
          command: process.execPath,
          model: "model-a",
          provider: "provider-a",
          env: { GRILL_TEST_VALUE: "from-agent-env" },
          args: [
            "-e",
            `
const [model, provider, harness] = process.argv.slice(-3);
if (model !== "model-a" || provider !== "provider-a" || harness !== "command") {
  console.error(JSON.stringify(process.argv));
  process.exit(2);
}
console.log(${JUROR_JSON});
`,
            "{{model}}",
            "{{provider}}",
            "{{harness}}"
          ]
        }
      ]
    })
  );
  const { state } = runJson([
    "start",
    "--cwd",
    tmp,
    "--agent-config",
    configPath,
    "--agents",
    "cmd-model",
    "--question",
    "Do command placeholders propagate?",
    "--prompt",
    "hi"
  ]);
  const parsed = state.decisions[0].rounds[0].responses["cmd-model"].parsed;
  assert.deepEqual(parsed.repo_findings, ["from-agent-env"]);
});

test("a zero user-question budget surfaces open questions in the decision final", () => {
  const { state } = runJson(["start", "--mock", "--cwd", tmp, "--max-user-questions", "0", "--prompt", "no-majority-demo: pick a color"]);
  const decision = state.decisions[0];
  assert.equal(decision.status, "resolved");
  assert.equal(decision.pendingUserQuestions, null);
  assert.ok(decision.final.open_user_questions.length >= 1, "unasked questions must be surfaced");
});




test("round summaries include failed jurors inside sequential decisions", () => {
  const configPath = path.join(tmp, "failing-agent.json");
  fs.writeFileSync(
    configPath,
    JSON.stringify({ agents: [{ name: "bad", command: process.execPath, args: ["-e", "process.exit(2)"] }] })
  );
  const { state, decisionSummaries } = runJson([
    "start",
    "--cwd",
    tmp,
    "--agent-config",
    configPath,
    "--agents",
    "bad",
    "--timeout-ms",
    "1000",
    "--prompt",
    "hi"
  ]);
  assert.equal(state.decisions[0].final.all_jurors_failed, true);
  assert.equal(decisionSummaries[0].roundSummaries[0].failed_jurors[0].agent, "bad");
  assert.match(decisionSummaries[0].roundSummaries[0].outcome, /No jurors produced a usable response/);
});

test("status summaries expose stale prior juror context for old v2 states", () => {
  const statePath = path.join(tmp, "stale-state.json");
  fs.writeFileSync(
    statePath,
    JSON.stringify({
      version: 2,
      cwd: tmp,
      prompt: "hi",
      maxRounds: 2,
      maxUserQuestions: 3,
      createdAt: new Date().toISOString(),
      updatedAt: new Date().toISOString(),
      mock: false,
      agents: [{ name: "a", label: "A", adapter: "command", command: process.execPath }],
      rounds: [
        {
          index: 1,
          kind: "initial",
          responses: {
            a: {
              ok: true,
              parsed: {
                stance: "recommend",
                recommendation: "Use the existing path.",
                rationale: "",
                assumptions: [],
                risks: [],
                repo_findings: [],
                questions_for_other_jurors: [],
                questions_for_user: [],
                confidence: 0.8
              }
            }
          }
        },
        {
          index: 2,
          kind: "challenge",
          responses: {
            a: {
              ok: false,
              error: "boom"
            }
          }
        }
      ],
      userAnswers: [],
      pendingUserQuestions: null,
      mediation: null,
      final: null
    })
  );
  const { state, roundSummaries } = runJson(["status", "--state", statePath]);
  assert.equal(state.agents[0].harness, "command");
  assert.equal("adapter" in state.agents[0], false);
  assert.equal(roundSummaries[1].failed_jurors[0].agent, "a");
  assert.equal(roundSummaries[1].stale_jurors[0].used_round, 1);
  assert.equal(roundSummaries[1].stale_jurors[0].recommendation, "Use the existing path.");
});

test("continue is rejected while a decision is waiting for the user", () => {
  const { statePath } = runJson(["start", "--mock", "--cwd", tmp, "--prompt", "no-majority-demo: choose"]);
  const result = run(["continue", "--mock", "--state", statePath]);
  assert.equal(result.status, 1);
  assert.match(result.stderr, /Answer the pending user question/);
});

test("unknown options are rejected", () => {
  const result = run(["start", "--mock", "--bogus", "x", "--prompt", "hi"]);
  assert.equal(result.status, 1);
  assert.match(result.stderr, /Unknown option --bogus/);
});

test("non-numeric --max-grill-questions is rejected", () => {
  const result = run(["start", "--mock", "--max-grill-questions", "abc", "--cwd", tmp, "--prompt", "hi"]);
  assert.equal(result.status, 1);
  assert.match(result.stderr, /--max-grill-questions/);
});

test("the state directory is gitignored", () => {
  const gitignore = fs.readFileSync(path.join(tmp, ".grill-others", ".gitignore"), "utf8");
  assert.equal(gitignore.trim(), "*");
});

fs.rmSync(tmp, { recursive: true, force: true });
if (failures > 0) {
  console.error(`${failures} test(s) failed.`);
  process.exit(1);
}
console.log("All tests passed.");

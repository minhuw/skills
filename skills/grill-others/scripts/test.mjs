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

test("start creates a sequential v1 state and runs until the planner is done", () => {
  const { statePath, state, decisionSummaries } = runJson(["start", "--mock", "--cwd", tmp, "--prompt", "Should we cache results in memory?"]);
  assert.equal(state.version, 1);
  assert.equal(state.mode, "sequential");
  assert.equal(state.maxGrillQuestions, 200);
  assert.equal(typeof state.grillSessionId, "string");
  assert.equal(statePath, path.join(tmp, ".grill-others", state.grillSessionId, "state.json"));
  assert.equal(state.decisions.length, 1);
  assert.equal(state.decisions[0].status, "resolved");
  assert.ok(state.final, "start must continue until the grill is finished");
  assert.equal(state.final.resolved_decisions, 1);
  assert.equal(decisionSummaries.length, 1);
  assert.equal(decisionSummaries[0].roundSummaries[0].stance_counts.recommend, 3);
  assert.equal(decisionSummaries[0].roundSummaries[0].participants.length, 3);
});

test("separate starts use separate grill session directories", () => {
  const first = runJson(["start", "--mock", "--cwd", tmp, "--prompt", "Should first run stay isolated?"]);
  const second = runJson(["start", "--mock", "--cwd", tmp, "--prompt", "Should second run stay isolated?"]);
  assert.notEqual(first.state.grillSessionId, second.state.grillSessionId);
  assert.notEqual(path.dirname(first.statePath), path.dirname(second.statePath));
  assert.equal(first.statePath, path.join(tmp, ".grill-others", first.state.grillSessionId, "state.json"));
  assert.equal(second.statePath, path.join(tmp, ".grill-others", second.state.grillSessionId, "state.json"));
});

test("markdown output is marked as a mock run and shows the final recommendation", () => {
  const result = run(["start", "--mock", "--cwd", tmp, "--prompt", "anything"]);
  assert.equal(result.status, 0, result.stderr);
  assert.match(result.stdout, /MOCK RUN/);
  assert.match(result.stdout, /Mode: sequential/);
  assert.match(result.stdout, /## Decision 1/);
  assert.match(result.stdout, /## Jury Rounds/);
  assert.match(result.stdout, /## Final Recommendation/);
  assert.doesNotMatch(result.stdout, /continue --state/);
  assert.doesNotMatch(result.stdout, /## Latest Jury Round/);
});

test("--question seeds only the first focused decision", () => {
  const { state } = runJson([
    "start",
    "--mock",
    "--cwd",
    tmp,
    "--question",
    "Should this seeded question run once?",
    "--prompt",
    "Should we cache results in memory?",
    "--max-grill-questions",
    "3"
  ]);
  assert.equal(state.decisions.length, 1);
  assert.equal(state.decisions[0].question, "Should this seeded question run once?");
  assert.ok(state.final, "the seeded run should still finish after the planner reports done");
});

test("unresolved jury answers pause the active decision and answer resumes that decision", () => {
  const { statePath, state } = runJson(["start", "--mock", "--cwd", tmp, "--prompt", "no-majority-demo: pick a header color"]);
  const decision = state.decisions[0];
  assert.equal(decision.status, "needs-user");
  assert.ok(Array.isArray(decision.pendingUserQuestions), "expected pending user questions");
  assert.equal(decision.pendingUserQuestions.length, 1, "the original focused question should be escalated once");
  assert.equal(decision.pendingUserQuestions[0].recommended_default, "");
  assert.equal(decision.pendingUserQuestions[0].opinions.length, 3);
  const answered = runJson(["answer", "--mock", "--state", statePath, "--answer", "blue"]);
  assert.equal(answered.state.decisions[0].status, "resolved");
  assert.equal(answered.state.decisions[0].userAnswers.length, 1);
  assert.equal(answered.state.decisions[0].userAnswers[0].questions.length, 1);
  assert.equal(answered.state.decisions[0].pendingUserQuestions, null);
  assert.ok(answered.state.decisions[0].final, "expected a decision final after the answer");
});

test("answer does not re-ask the same unresolved focused question", () => {
  const commandPath = writeFakeCommand(
    tmp,
    "always-escalates.js",
    `
const fs = require("node:fs");
const prompt = fs.readFileSync(0, "utf8");
if (prompt.includes("acting as the mediator")) {
  console.log(JSON.stringify({
    recommendation: "Pick the option that best matches the user's product intent.",
    rationale: "The fake mediator intentionally requires the user so repeat escalation can be tested.",
    consensus: false,
    requires_user: true,
    unresolved_disagreements: ["No clear majority."],
    confidence: 0.4
  }));
  process.exit(0);
}
const agent = /Your juror id is ([^\\n.]+)/.exec(prompt)?.[1] || "unknown";
console.log(JSON.stringify({
  stance: "recommend",
  recommendation: "Recommendation from " + agent,
  rationale: "Distinct fake juror position.",
  assumptions: [],
  risks: [],
  repo_findings: [],
  questions_for_other_jurors: [],
  confidence: 0.6
}));
`
  );
  const configPath = path.join(tmp, "always-escalates-agents.json");
  fs.writeFileSync(
    configPath,
    JSON.stringify({
      agents: [
        { name: "a", command: commandPath },
        { name: "b", command: commandPath },
        { name: "c", command: commandPath }
      ]
    })
  );
  const { statePath, state } = runJson([
    "start",
    "--cwd",
    tmp,
    "--agent-config",
    configPath,
    "--agents",
    "a,b,c",
    "--question",
    "Which option should ship?",
    "--prompt",
    "choose"
  ]);
  assert.equal(state.decisions[0].status, "needs-user");
  assert.equal(state.decisions[0].pendingUserQuestions.length, 1);

  const answered = runJson(["answer", "--state", statePath, "--answer", "Ship option B"]);
  const decision = answered.state.decisions[0];
  assert.equal(decision.status, "resolved");
  assert.equal(decision.pendingUserQuestions, null);
  assert.ok(decision.final, "expected final instead of a repeated user question");
  assert.equal(decision.final.open_user_questions.length, 1);
  assert.equal(decision.final.open_user_questions[0].question, "Which option should ship?");
});

test("pending user-question markdown includes decision summary before the question", () => {
  const result = run(["start", "--mock", "--cwd", tmp, "--prompt", "no-majority-demo: pick a header color"]);
  assert.equal(result.status, 0, result.stderr);
  assert.match(result.stdout, /## Decision 1[\s\S]*## Jury Rounds[\s\S]*## Questions For User/);
  assert.match(result.stdout, /Juror positions:/);
});

test("continue returns the final state when the planner is already done", () => {
  const { statePath } = runJson(["start", "--mock", "--cwd", tmp, "--prompt", "Should we cache results in memory?"]);
  const continued = runJson(["continue", "--mock", "--state", statePath]);
  assert.ok(continued.state.final, "expected a top-level final after continue");
  assert.equal(continued.state.final.resolved_decisions, 1);
  assert.match(continued.state.final.recommendation, /Resolved focused decisions/);
});

test("start can run a second focused question before finalizing", () => {
  const { state } = runJson(["start", "--mock", "--cwd", tmp, "--prompt", "two-question-demo: check two risks"]);
  assert.equal(state.decisions.length, 2);
  assert.equal(state.decisions[0].status, "resolved");
  assert.equal(state.decisions[1].status, "resolved");
  assert.ok(state.final);
  assert.equal(state.final.resolved_decisions, 2);
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

test("answer with changed agent config drops stale harness sessions", () => {
  const logPath = path.join(tmp, "reset-session.log");
  const commandPath = writeFakeCommand(
    tmp,
    "reset-session-agent.js",
    `
const fs = require("node:fs");
const [agent, sessionId, promptMode, prompt] = process.argv.slice(2);
fs.appendFileSync(process.env.GRILL_TEST_RESET_SESSION_LOG, agent + ":" + sessionId + ":" + promptMode + "\\n");
if (prompt.includes("acting as the mediator") || prompt.includes("continuing as mediator")) {
  const answered = prompt.includes("User Q&A transcript") || prompt.includes("Latest user answer delta");
  console.log(JSON.stringify({
    recommendation: answered ? "Use the user's selected option." : "Jurors remain split.",
    rationale: answered ? "The user resolved the split." : "The fake mediator intentionally requires user input first.",
    consensus: answered,
    requires_user: !answered,
    unresolved_disagreements: answered ? [] : ["No clear majority."],
    confidence: answered ? 0.8 : 0.4
  }));
  process.exit(0);
}
console.log(JSON.stringify({
  stance: "recommend",
  recommendation: "Recommendation from " + agent,
  rationale: "Distinct fake juror position.",
  assumptions: [],
  risks: [],
  repo_findings: [],
  questions_for_other_jurors: [],
  confidence: 0.7
}));
`
  );
  const writeConfig = (file, labelSuffix) =>
    fs.writeFileSync(
      file,
      JSON.stringify({
        agents: ["a", "b", "c"].map((name) => ({
          name,
          label: `${name}-${labelSuffix}`,
          command: commandPath,
          persistentSession: true,
          args: ["{{agentName}}", "{{sessionId}}", "{{promptMode}}", "{{prompt}}"]
        }))
      })
    );
  const firstConfig = path.join(tmp, "reset-session-first.json");
  const secondConfig = path.join(tmp, "reset-session-second.json");
  writeConfig(firstConfig, "first");
  writeConfig(secondConfig, "second");
  const { statePath, state } = runJson(
    [
      "start",
      "--cwd",
      tmp,
      "--agent-config",
      firstConfig,
      "--agents",
      "a,b,c",
      "--max-grill-questions",
      "1",
      "--question",
      "Which split option should win?",
      "--prompt",
      "choose"
    ],
    { env: { GRILL_TEST_RESET_SESSION_LOG: logPath } }
  );
  assert.equal(state.decisions[0].status, "needs-user");
  const oldJurorSession = state.harnessSessions.juror.a.sessionId;
  const oldMediatorSession = state.harnessSessions.mediator.a.sessionId;

  const answered = runJson(
    [
      "answer",
      "--state",
      statePath,
      "--agent-config",
      secondConfig,
      "--agents",
      "a,b,c",
      "--answer",
      "Use option B"
    ],
    { env: { GRILL_TEST_RESET_SESSION_LOG: logPath } }
  );
  assert.notEqual(answered.state.harnessSessions.juror.a.sessionId, oldJurorSession);
  assert.notEqual(answered.state.harnessSessions.mediator.a.sessionId, oldMediatorSession);
  assert.equal(answered.state.agents[0].label, "a-second");
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

test("codex harness uses app-server threads with output schemas", () => {
  const bin = fs.mkdtempSync(path.join(tmp, "fake-codex-app-bin-"));
  const logPath = path.join(tmp, "codex-app-server.log");
  writeFakeCommand(
    bin,
    "codex",
    `
const fs = require("node:fs");
const argv = process.argv.slice(2);
const appServerIndex = argv.indexOf("app-server");
if (appServerIndex === -1) {
  console.error("codex exec fallback should not be used");
  process.exit(2);
}
const logPath = process.env.GRILL_TEST_CODEX_APP_LOG;
fs.appendFileSync(logPath, "argv:" + argv.join(" ") + "\\n");
function write(message) {
  process.stdout.write(JSON.stringify(message) + "\\n");
}
function turn(id = "turn-1", status = "inProgress") {
  return { id, items: [], itemsView: "all", status, error: null, startedAt: null, completedAt: null, durationMs: null };
}
function handle(message) {
  if (message.method === "initialize") {
    write({ id: message.id, result: { serverInfo: { name: "fake-codex", version: "1" }, capabilities: {} } });
    return;
  }
  if (message.method === "initialized") {
    return;
  }
  if (message.method === "thread/start") {
    fs.appendFileSync(logPath, "thread/start:" + message.params.model + ":" + message.params.sandbox + ":" + message.params.approvalPolicy + "\\n");
    write({
      id: message.id,
      result: {
        thread: { id: "thread-1" },
        model: message.params.model,
        modelProvider: "fake",
        serviceTier: null,
        cwd: message.params.cwd,
        instructionSources: [],
        approvalPolicy: "never",
        approvalsReviewer: "codex",
        sandbox: { type: "readOnly", networkAccess: false },
        reasoningEffort: null
      }
    });
    return;
  }
  if (message.method === "thread/resume") {
    fs.appendFileSync(logPath, "thread/resume:" + message.params.threadId + "\\n");
    write({
      id: message.id,
      result: {
        thread: { id: message.params.threadId },
        model: message.params.model,
        modelProvider: "fake",
        serviceTier: null,
        cwd: message.params.cwd,
        instructionSources: [],
        approvalPolicy: "never",
        approvalsReviewer: "codex",
        sandbox: { type: "readOnly", networkAccess: false },
        reasoningEffort: null
      }
    });
    return;
  }
  if (message.method === "turn/start") {
    const prompt = message.params.input?.[0]?.text || "";
    const round = prompt.includes("Current round kind: challenge") ? "challenge" : "initial";
    const mode = prompt.includes("Original user plan or decision:") ? "full" : "compact";
    fs.appendFileSync(logPath, "turn/start:" + message.params.threadId + ":" + (message.params.outputSchema?.type || "missing") + ":" + mode + ":" + round + "\\n");
    write({ id: message.id, result: { turn: turn() } });
    const text = JSON.stringify({
      stance: round === "challenge" ? "recommend" : "needs-evidence",
      recommendation: round === "challenge" ? "compact app-server prompt accepted" : "Run a challenge round to test compact app-server prompts.",
      rationale: "The fake app-server received the turn.",
      assumptions: [],
      risks: [],
      repo_findings: [],
      questions_for_other_jurors: round === "challenge" ? [] : [{ to: "all", question: "Did the second app-server prompt stay compact?", why: "Exercise session-aware context feeding." }],
      confidence: 0.91
    });
    write({
      method: "item/completed",
      params: {
        threadId: message.params.threadId,
        turnId: "turn-1",
        item: { type: "agentMessage", id: "item-1", text, phase: null, memoryCitation: null },
        completedAtMs: Date.now()
      }
    });
    write({ method: "turn/completed", params: { threadId: message.params.threadId, turn: turn("turn-1", "completed") } });
    return;
  }
  write({ id: message.id, error: { message: "unexpected method " + message.method } });
}
let buffer = "";
process.stdin.setEncoding("utf8");
process.stdin.on("data", (chunk) => {
  buffer += chunk;
  let index = buffer.indexOf("\\n");
  while (index !== -1) {
    const line = buffer.slice(0, index);
    buffer = buffer.slice(index + 1);
    if (line.trim()) {
      handle(JSON.parse(line));
    }
    index = buffer.indexOf("\\n");
  }
});
process.stdin.on("end", () => {
  fs.appendFileSync(logPath, "stdin/end\\n");
  process.exit(0);
});
`
  );
  const configPath = path.join(tmp, "codex-app-server.json");
  fs.writeFileSync(
    configPath,
    JSON.stringify({
      agents: [{ name: "codex-app", harness: "codex", model: "gpt-5", args: ["--profile", "jury-profile", "-c", "features.fake=true"] }]
    })
  );
  const { state } = runJson(
    [
      "start",
      "--cwd",
      tmp,
      "--agent-config",
      configPath,
      "--agents",
      "codex-app",
      "--max-grill-questions",
      "1",
      "--question",
      "Does Codex app-server receive the turn?",
      "--prompt",
      "hi"
    ],
    { env: { PATH: `${bin}${path.delimiter}${process.env.PATH}`, GRILL_TEST_CODEX_APP_LOG: logPath } }
  );
  assert.equal(state.decisions[0].rounds[0].responses["codex-app"].ok, true);
  assert.equal(state.decisions[0].rounds[1].responses["codex-app"].ok, true);
  assert.equal(state.decisions[0].rounds[0].responses["codex-app"].promptMode, "full");
  assert.equal(state.decisions[0].rounds[1].responses["codex-app"].promptMode, "compact");
  assert.ok(state.decisions[0].rounds[1].responses["codex-app"].promptChars < state.decisions[0].rounds[0].responses["codex-app"].promptChars);
  assert.equal(state.harnessSessions.juror["codex-app"].codexThreadId, "thread-1");
  assert.equal(state.harnessSessions.juror["codex-app"].contextPrimed, true);
  const log = fs.readFileSync(logPath, "utf8");
  assert.match(log, /argv:--profile jury-profile -c features\.fake=true app-server/);
  assert.match(log, /thread\/start:gpt-5:read-only:never\nturn\/start:thread-1:object:full:initial/);
  assert.match(log, /turn\/start:thread-1:object:compact:challenge\nstdin\/end/);
  assert.doesNotMatch(log, /thread\/resume/);
});

test("codex app-server requests receive an unsupported-method response", () => {
  const bin = fs.mkdtempSync(path.join(tmp, "fake-codex-app-request-bin-"));
  const logPath = path.join(tmp, "codex-app-server-request.log");
  writeFakeCommand(
    bin,
    "codex",
    `
const fs = require("node:fs");
const argv = process.argv.slice(2);
if (argv[0] !== "app-server") {
  console.error("codex exec fallback should not be used");
  process.exit(2);
}
const logPath = process.env.GRILL_TEST_CODEX_APP_REQUEST_LOG;
let pendingThreadId = "";
function write(message) {
  process.stdout.write(JSON.stringify(message) + "\\n");
}
function turn(id = "turn-1", status = "inProgress") {
  return { id, items: [], itemsView: "all", status, error: null, startedAt: null, completedAt: null, durationMs: null };
}
function completeTurn() {
  const text = JSON.stringify({
    stance: "recommend",
    recommendation: "app-server callback was answered",
    rationale: "The fake app-server received a response to its request.",
    assumptions: [],
    risks: [],
    repo_findings: [],
    questions_for_other_jurors: [],
    confidence: 0.9
  });
  write({
    method: "item/completed",
    params: {
      threadId: pendingThreadId,
      turnId: "turn-1",
      item: { type: "agentMessage", id: "item-1", text, phase: null, memoryCitation: null },
      completedAtMs: Date.now()
    }
  });
  write({ method: "turn/completed", params: { threadId: pendingThreadId, turn: turn("turn-1", "completed") } });
}
function handle(message) {
  if (message.id === "server-request-1") {
    fs.appendFileSync(logPath, "server-request-response:" + (message.error?.code || "none") + "\\n");
    completeTurn();
    return;
  }
  if (message.method === "initialize") {
    write({ id: message.id, result: { serverInfo: { name: "fake-codex", version: "1" }, capabilities: {} } });
    return;
  }
  if (message.method === "initialized") {
    return;
  }
  if (message.method === "thread/start") {
    write({ id: message.id, result: { thread: { id: "thread-request" } } });
    return;
  }
  if (message.method === "turn/start") {
    pendingThreadId = message.params.threadId;
    write({ id: message.id, result: { turn: turn() } });
    write({ id: "server-request-1", method: "approval/request", params: {} });
    return;
  }
}
let buffer = "";
process.stdin.setEncoding("utf8");
process.stdin.on("data", (chunk) => {
  buffer += chunk;
  let index = buffer.indexOf("\\n");
  while (index !== -1) {
    const line = buffer.slice(0, index);
    buffer = buffer.slice(index + 1);
    if (line.trim()) {
      handle(JSON.parse(line));
    }
    index = buffer.indexOf("\\n");
  }
});
`
  );
  const configPath = path.join(tmp, "codex-app-server-request.json");
  fs.writeFileSync(configPath, JSON.stringify({ agents: [{ name: "codex-request", harness: "codex" }] }));
  const { state } = runJson(
    [
      "start",
      "--cwd",
      tmp,
      "--agent-config",
      configPath,
      "--agents",
      "codex-request",
      "--max-grill-questions",
      "1",
      "--timeout-ms",
      "1000",
      "--question",
      "Does Codex app-server receive callback responses?",
      "--prompt",
      "hi"
    ],
    { env: { PATH: `${bin}${path.delimiter}${process.env.PATH}`, GRILL_TEST_CODEX_APP_REQUEST_LOG: logPath } }
  );
  const response = state.decisions[0].rounds[0].responses["codex-request"];
  assert.equal(response.ok, true);
  assert.equal(response.sessionContextAvailable, true);
  assert.equal(response.parsed.recommendation, "app-server callback was answered");
  assert.match(fs.readFileSync(logPath, "utf8"), /server-request-response:-32601/);
});

test("codex app-server exit during an active turn falls back without waiting for timeout", () => {
  const bin = fs.mkdtempSync(path.join(tmp, "fake-codex-app-exit-bin-"));
  writeFakeCommand(
    bin,
    "codex",
    `
const fs = require("node:fs");
const argv = process.argv.slice(2);
if (argv[0] === "exec") {
  console.log(${JUROR_JSON});
  process.exit(0);
}
if (argv[0] !== "app-server") {
  console.error("unexpected codex argv " + JSON.stringify(argv));
  process.exit(2);
}
function write(message) {
  process.stdout.write(JSON.stringify(message) + "\\n");
}
function turn(id = "turn-1", status = "inProgress") {
  return { id, items: [], itemsView: "all", status, error: null, startedAt: null, completedAt: null, durationMs: null };
}
function handle(message) {
  if (message.method === "initialize") {
    write({ id: message.id, result: { serverInfo: { name: "fake-codex", version: "1" }, capabilities: {} } });
    return;
  }
  if (message.method === "initialized") {
    return;
  }
  if (message.method === "thread/start") {
    write({ id: message.id, result: { thread: { id: "thread-exit" } } });
    return;
  }
  if (message.method === "turn/start") {
    write({ id: message.id, result: { turn: turn() } });
    process.exit(7);
  }
}
let buffer = "";
process.stdin.setEncoding("utf8");
process.stdin.on("data", (chunk) => {
  buffer += chunk;
  let index = buffer.indexOf("\\n");
  while (index !== -1) {
    const line = buffer.slice(0, index);
    buffer = buffer.slice(index + 1);
    if (line.trim()) {
      handle(JSON.parse(line));
    }
    index = buffer.indexOf("\\n");
  }
});
`
  );
  const configPath = path.join(tmp, "codex-app-server-exit.json");
  fs.writeFileSync(configPath, JSON.stringify({ agents: [{ name: "codex-exit", harness: "codex" }] }));
  const { state } = runJson(
    [
      "start",
      "--cwd",
      tmp,
      "--agent-config",
      configPath,
      "--agents",
      "codex-exit",
      "--max-grill-questions",
      "1",
      "--timeout-ms",
      "5000",
      "--question",
      "Does Codex app-server failure fall back?",
      "--prompt",
      "hi"
    ],
    { env: { PATH: `${bin}${path.delimiter}${process.env.PATH}` } }
  );
  const response = state.decisions[0].rounds[0].responses["codex-exit"];
  assert.equal(response.ok, true);
  assert.equal(response.sessionContextAvailable, false);
  assert.equal(response.parsed.recommendation, "model flag accepted");
});

test("codex app-server RPC timeout falls back to exec", () => {
  const bin = fs.mkdtempSync(path.join(tmp, "fake-codex-app-timeout-bin-"));
  writeFakeCommand(
    bin,
    "codex",
    `
const argv = process.argv.slice(2);
if (argv[0] === "exec") {
  console.log(${JUROR_JSON});
  process.exit(0);
}
if (argv[0] !== "app-server") {
  console.error("unexpected codex argv " + JSON.stringify(argv));
  process.exit(2);
}
setInterval(() => {}, 1000);
`
  );
  const configPath = path.join(tmp, "codex-app-server-timeout.json");
  fs.writeFileSync(configPath, JSON.stringify({ agents: [{ name: "codex-timeout", harness: "codex" }] }));
  const { state } = runJson(
    [
      "start",
      "--cwd",
      tmp,
      "--agent-config",
      configPath,
      "--agents",
      "codex-timeout",
      "--max-grill-questions",
      "1",
      "--timeout-ms",
      "1000",
      "--question",
      "Does Codex app-server RPC timeout fall back?",
      "--prompt",
      "hi"
    ],
    { env: { PATH: `${bin}${path.delimiter}${process.env.PATH}` } }
  );
  const response = state.decisions[0].rounds[0].responses["codex-timeout"];
  assert.equal(response.ok, true);
  assert.equal(response.sessionContextAvailable, false);
  assert.equal(response.parsed.recommendation, "model flag accepted");
});

test("codex exec fallback after a compact app-server failure uses a full prompt", () => {
  const bin = fs.mkdtempSync(path.join(tmp, "fake-codex-compact-fallback-bin-"));
  const logPath = path.join(tmp, "codex-compact-fallback.log");
  writeFakeCommand(
    bin,
    "codex",
    `
const fs = require("node:fs");
const argv = process.argv.slice(2);
const logPath = process.env.GRILL_TEST_CODEX_COMPACT_FALLBACK_LOG;
if (argv[0] === "exec") {
  const prompt = fs.readFileSync(0, "utf8");
  const mode = prompt.includes("Original user plan or decision:") ? "full" : "compact";
  fs.appendFileSync(logPath, "exec:" + mode + "\\n");
  if (mode !== "full") {
    console.error("exec fallback received a compact prompt");
    process.exit(6);
  }
  console.log(JSON.stringify({
    stance: "recommend",
    recommendation: "exec fallback received full prompt",
    rationale: "The fallback path rebuilt full context.",
    assumptions: [],
    risks: [],
    repo_findings: [],
    questions_for_other_jurors: [],
    confidence: 0.9
  }));
  process.exit(0);
}
if (argv[0] !== "app-server") {
  console.error("unexpected codex argv " + JSON.stringify(argv));
  process.exit(2);
}
let turnCount = 0;
function write(message) {
  process.stdout.write(JSON.stringify(message) + "\\n");
}
function turn(id = "turn-1", status = "inProgress") {
  return { id, items: [], itemsView: "all", status, error: null, startedAt: null, completedAt: null, durationMs: null };
}
function handle(message) {
  if (message.method === "initialize") {
    write({ id: message.id, result: { serverInfo: { name: "fake-codex", version: "1" }, capabilities: {} } });
    return;
  }
  if (message.method === "initialized") {
    return;
  }
  if (message.method === "thread/start") {
    write({ id: message.id, result: { thread: { id: "thread-compact-fallback" } } });
    return;
  }
  if (message.method === "turn/start") {
    turnCount += 1;
    const prompt = message.params.input?.[0]?.text || "";
    const mode = prompt.includes("Original user plan or decision:") ? "full" : "compact";
    fs.appendFileSync(logPath, "app:" + turnCount + ":" + mode + "\\n");
    write({ id: message.id, result: { turn: turn("turn-" + turnCount) } });
    if (turnCount === 1) {
      const text = JSON.stringify({
        stance: "needs-evidence",
        recommendation: "Run a challenge round before finalizing.",
        rationale: "The second turn should use compact app-server context first.",
        assumptions: [],
        risks: [],
        repo_findings: [],
        questions_for_other_jurors: [{ to: "all", question: "Can compact fallback rebuild full context?", why: "Exercise fallback prompting." }],
        confidence: 0.7
      });
      write({
        method: "item/completed",
        params: {
          threadId: message.params.threadId,
          turnId: "turn-1",
          item: { type: "agentMessage", id: "item-1", text, phase: null, memoryCitation: null },
          completedAtMs: Date.now()
        }
      });
      write({ method: "turn/completed", params: { threadId: message.params.threadId, turn: turn("turn-1", "completed") } });
      return;
    }
    process.exit(7);
  }
}
let buffer = "";
process.stdin.setEncoding("utf8");
process.stdin.on("data", (chunk) => {
  buffer += chunk;
  let index = buffer.indexOf("\\n");
  while (index !== -1) {
    const line = buffer.slice(0, index);
    buffer = buffer.slice(index + 1);
    if (line.trim()) {
      handle(JSON.parse(line));
    }
    index = buffer.indexOf("\\n");
  }
});
`
  );
  const configPath = path.join(tmp, "codex-compact-fallback.json");
  fs.writeFileSync(configPath, JSON.stringify({ agents: [{ name: "codex-compact-fallback", harness: "codex" }] }));
  const { state } = runJson(
    [
      "start",
      "--cwd",
      tmp,
      "--agent-config",
      configPath,
      "--agents",
      "codex-compact-fallback",
      "--max-grill-questions",
      "1",
      "--question",
      "Does compact fallback rebuild a full prompt?",
      "--prompt",
      "hi"
    ],
    { env: { PATH: `${bin}${path.delimiter}${process.env.PATH}`, GRILL_TEST_CODEX_COMPACT_FALLBACK_LOG: logPath } }
  );
  const response = state.decisions[0].rounds[1].responses["codex-compact-fallback"];
  assert.equal(response.ok, true);
  assert.equal(response.sessionContextAvailable, false);
  assert.equal(response.promptMode, "full");
  assert.equal(response.parsed.recommendation, "exec fallback received full prompt");
  assert.deepEqual(fs.readFileSync(logPath, "utf8").trim().split("\n"), ["app:1:full", "app:2:compact", "exec:full"]);
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

test("claude and pi harnesses reuse juror session ids across rounds", () => {
  const bin = fs.mkdtempSync(path.join(tmp, "fake-session-bin-"));
  const logPath = path.join(tmp, "harness-session.log");
  const script = `
const fs = require("node:fs");
const command = require("node:path").basename(process.argv[1]);
const argv = process.argv.slice(2);
const prompt = argv.at(-1) || "";
const round = prompt.includes("Current round kind: challenge") ? "challenge" : "initial";
const mode = prompt.includes("Original user plan or decision:") ? "full" : "compact";
const sessionFlag = command === "claude" && round === "challenge" ? "--resume" : "--session-id";
const wrongSessionFlag = sessionFlag === "--resume" ? "--session-id" : "--resume";
if (argv.includes(wrongSessionFlag)) {
  console.error("wrong session flag for " + command + " " + round + ": " + JSON.stringify(argv));
  process.exit(2);
}
const sessionIndex = argv.indexOf(sessionFlag);
if (sessionIndex === -1 || !argv[sessionIndex + 1]) {
  console.error(JSON.stringify(argv));
  process.exit(3);
}
if (round === "initial" && mode !== "full") {
  console.error("initial prompt should include full context");
  process.exit(4);
}
if (round === "challenge" && mode !== "compact") {
  console.error("challenge prompt should be compact");
  process.exit(5);
}
fs.appendFileSync(process.env.GRILL_TEST_SESSION_LOG, command + ":" + sessionFlag + ":" + argv[sessionIndex + 1] + ":" + round + ":" + mode + "\\n");
const challenge = round === "challenge";
console.log(JSON.stringify({
  stance: challenge ? "recommend" : "needs-evidence",
  recommendation: challenge ? "Stable session id was reused." : "Run a challenge round to test session reuse.",
  rationale: "Fake harness session regression.",
  assumptions: [],
  risks: [],
  repo_findings: [],
  questions_for_other_jurors: challenge ? [] : [{ to: "all", question: "Was the same session reused?", why: "Exercise challenge-round session continuity." }],
  confidence: 0.8
}));
`;
  writeFakeCommand(bin, "claude", script);
  writeFakeCommand(bin, "pi", script);

  for (const harness of ["claude", "pi"]) {
    const name = `${harness}-session`;
    const configPath = path.join(tmp, `${name}.json`);
    fs.writeFileSync(configPath, JSON.stringify({ agents: [{ name, harness }] }));
    const { state } = runJson(
      [
        "start",
        "--cwd",
        tmp,
        "--agent-config",
        configPath,
        "--agents",
        name,
        "--max-grill-questions",
        "1",
        "--question",
        `Does ${harness} reuse a session id?`,
        "--prompt",
        "hi"
      ],
      { env: { PATH: `${bin}${path.delimiter}${process.env.PATH}`, GRILL_TEST_SESSION_LOG: logPath } }
    );
    const sessionId = state.harnessSessions.juror[name].sessionId;
    assert.equal(typeof sessionId, "string");
    assert.equal(state.harnessSessions.juror[name].contextPrimed, true);
    const entries = fs
      .readFileSync(logPath, "utf8")
      .trim()
      .split("\n")
      .filter((line) => line.startsWith(`${harness}:`) && line.includes(sessionId));
    const challengeFlag = harness === "claude" ? "--resume" : "--session-id";
    assert.deepEqual(entries, [
      `${harness}:--session-id:${sessionId}:initial:full`,
      `${harness}:${challengeFlag}:${sessionId}:challenge:compact`
    ]);
  }
});

test("claude full-turn failure clears the session id before retry", () => {
  const bin = fs.mkdtempSync(path.join(tmp, "fake-claude-retry-bin-"));
  const logPath = path.join(tmp, "claude-retry-session.log");
  const markerPath = path.join(tmp, "claude-retry-marker");
  writeFakeCommand(
    bin,
    "claude",
    `
const fs = require("node:fs");
const argv = process.argv.slice(2);
const prompt = argv.at(-1) || "";
const sessionFlag = argv.includes("--resume") ? "--resume" : "--session-id";
const sessionIndex = argv.indexOf(sessionFlag);
const sessionId = sessionIndex === -1 ? "" : argv[sessionIndex + 1];
const role = prompt.includes("acting as the planner") ? "planner" : "juror";
fs.appendFileSync(process.env.GRILL_TEST_CLAUDE_RETRY_LOG, role + ":" + sessionFlag + ":" + sessionId + "\\n");
if (role === "planner") {
  console.log(JSON.stringify({
    done: true,
    question: "",
    rationale: "The retried Claude decision resolved.",
    confidence: 0.8
  }));
  process.exit(0);
}
if (!fs.existsSync(process.env.GRILL_TEST_CLAUDE_RETRY_MARKER)) {
  fs.writeFileSync(process.env.GRILL_TEST_CLAUDE_RETRY_MARKER, sessionId);
  console.error("transient Claude failure after session creation");
  process.exit(2);
}
console.log(JSON.stringify({
  stance: "recommend",
  recommendation: "Claude retry used a fresh full-turn session id.",
  rationale: "The fake Claude harness succeeds on retry.",
  assumptions: [],
  risks: [],
  repo_findings: [],
  questions_for_other_jurors: [],
  confidence: 0.8
}));
`
  );
  const configPath = path.join(tmp, "claude-retry.json");
  fs.writeFileSync(configPath, JSON.stringify({ agents: [{ name: "claude-retry", harness: "claude" }] }));
  const env = {
    PATH: `${bin}${path.delimiter}${process.env.PATH}`,
    GRILL_TEST_CLAUDE_RETRY_LOG: logPath,
    GRILL_TEST_CLAUDE_RETRY_MARKER: markerPath
  };
  const started = runJson(
    [
      "start",
      "--cwd",
      tmp,
      "--agent-config",
      configPath,
      "--agents",
      "claude-retry",
      "--question",
      "Can Claude retry after a full-turn failure?",
      "--prompt",
      "hi"
    ],
    { env }
  );
  assert.equal(started.state.decisions[0].status, "failed");
  assert.equal(started.state.harnessSessions.juror?.["claude-retry"]?.sessionId, undefined);

  const continued = runJson(["continue", "--state", started.statePath], { env });
  assert.equal(continued.state.decisions[0].status, "resolved");
  const jurorLines = fs
    .readFileSync(logPath, "utf8")
    .trim()
    .split("\n")
    .filter((line) => line.startsWith("juror:"));
  assert.equal(jurorLines.length, 2);
  const [, firstFlag, firstSessionId] = jurorLines[0].split(":");
  const [, secondFlag, secondSessionId] = jurorLines[1].split(":");
  assert.equal(firstFlag, "--session-id");
  assert.equal(secondFlag, "--session-id");
  assert.notEqual(firstSessionId, secondSessionId);
});

test("claude and pi configs cannot disable built-in session persistence", () => {
  for (const [harness, flag] of [
    ["claude", "--no-session-persistence"],
    ["pi", "--no-session"]
  ]) {
    const name = `${harness}-no-session`;
    const configPath = path.join(tmp, `${name}-invalid.json`);
    fs.writeFileSync(configPath, JSON.stringify({ agents: [{ name, harness, args: [flag] }] }));
    const result = run([
      "start",
      "--cwd",
      tmp,
      "--agent-config",
      configPath,
      "--agents",
      name,
      "--question",
      `Does ${harness} reject disabled persistence?`,
      "--prompt",
      "hi"
    ]);
    assert.equal(result.status, 1);
    assert.match(result.stderr, new RegExp(`${harness}.*${flag.replaceAll("-", "\\-")}`));
    assert.match(result.stderr, /requires persistent harness sessions/);
  }
});

test("planner and mediator use compact prompts after session bootstrap", () => {
  const bin = fs.mkdtempSync(path.join(tmp, "fake-role-compact-bin-"));
  const logPath = path.join(tmp, "role-compact.log");
  writeFakeCommand(
    bin,
    "claude",
    `
const fs = require("node:fs");
const prompt = process.argv.at(-1) || "";
const mode = prompt.includes("Original user plan or decision:") ? "full" : "compact";
let role = "juror";
if (prompt.includes("acting as the planner") || prompt.includes("continuing as planner")) role = "planner";
if (prompt.includes("acting as the mediator") || prompt.includes("continuing as mediator")) role = "mediator";
fs.appendFileSync(process.env.GRILL_TEST_ROLE_COMPACT_LOG, role + ":" + mode + "\\n");
if (role === "planner") {
  const match = /Focused questions resolved so far: (\\d+)/.exec(prompt);
  const resolved = Number(match?.[1] || 0);
  console.log(JSON.stringify({
    done: resolved >= 2,
    question: resolved >= 2 ? "" : "Focused question " + (resolved + 1) + "?",
    rationale: "Fake planner compact prompt test.",
    confidence: 0.8
  }));
  process.exit(0);
}
if (role === "mediator") {
  console.log(JSON.stringify({
    recommendation: "Use the shared fake recommendation.",
    rationale: "Fake mediator compact prompt test.",
    consensus: true,
    requires_user: false,
    unresolved_disagreements: [],
    confidence: 0.8
  }));
  process.exit(0);
}
if (role === "juror" && mode === "compact" && prompt.includes("Current focused grill question: Focused question 2?")) {
  if (!prompt.includes("Resolved focused decisions so far:") || !prompt.includes("Question: Focused question 1?")) {
    console.error("compact second-decision juror prompt omitted prior decisions");
    process.exit(5);
  }
}
const agent = /Your juror id is ([^\\n.]+)/.exec(prompt)?.[1] || /continuing as juror ([^\\s]+)/.exec(prompt)?.[1] || "unknown";
console.log(JSON.stringify({
  stance: "recommend",
  recommendation: "Shared fake recommendation from " + agent,
  rationale: "Fake juror response.",
  assumptions: [],
  risks: [],
  repo_findings: [],
  questions_for_other_jurors: [],
  confidence: 0.8
}));
`
  );
  const configPath = path.join(tmp, "role-compact-agents.json");
  fs.writeFileSync(
    configPath,
    JSON.stringify({
      agents: [
        { name: "a", label: "A", harness: "claude" },
        { name: "b", label: "B", harness: "claude" }
      ]
    })
  );
  const { state } = runJson(
    [
      "start",
      "--cwd",
      tmp,
      "--agent-config",
      configPath,
      "--agents",
      "a,b",
      "--max-grill-questions",
      "3",
      "--prompt",
      "two decisions need compact planner and mediator prompts"
    ],
    { env: { PATH: `${bin}${path.delimiter}${process.env.PATH}`, GRILL_TEST_ROLE_COMPACT_LOG: logPath } }
  );
  assert.equal(state.decisions.length, 2);
  assert.equal(state.decisions[0].mediation.promptMode, "full");
  assert.equal(state.decisions[1].mediation.promptMode, "compact");
  assert.equal(state.lastPlanner.promptMode, "compact");
  assert.equal(state.decisions[1].rounds[0].responses.a.promptMode, "compact");
  const log = fs.readFileSync(logPath, "utf8");
  assert.match(log, /planner:full/);
  assert.match(log, /planner:compact/);
  assert.match(log, /mediator:full/);
  assert.match(log, /mediator:compact/);
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

test("command harness sessionId placeholder stays stateless without persistentSession", () => {
  const logPath = path.join(tmp, "command-stateless-session.log");
  const commandPath = writeFakeCommand(
    tmp,
    "command-stateless-session-agent.js",
    `
const fs = require("node:fs");
const [sessionId, promptMode, prompt] = process.argv.slice(2);
const actualMode = prompt.includes("Original user plan or decision:") ? "full" : "compact";
if (promptMode !== actualMode) {
  console.error("promptMode placeholder mismatch: " + promptMode + " vs " + actualMode);
  process.exit(2);
}
const challenge = prompt.includes("Current round kind: challenge");
fs.appendFileSync(process.env.GRILL_TEST_COMMAND_STATELESS_SESSION_LOG, sessionId + ":" + (challenge ? "challenge" : "initial") + ":" + promptMode + "\\n");
console.log(JSON.stringify({
  stance: challenge ? "recommend" : "needs-evidence",
  recommendation: challenge ? "Stateless command stayed on full prompts." : "Run a challenge round for the command harness.",
  rationale: "Fake command harness stateless session test.",
  assumptions: [],
  risks: [],
  repo_findings: [],
  questions_for_other_jurors: challenge ? [] : [{ to: "all", question: "Did the command harness stay stateless?", why: "Exercise legacy sessionId behavior." }],
  confidence: 0.8
}));
`
  );
  const configPath = path.join(tmp, "command-stateless-session-agent.json");
  fs.writeFileSync(
    configPath,
    JSON.stringify({
      agents: [
        {
          name: "cmd-stateless",
          command: commandPath,
          args: ["{{sessionId}}", "{{promptMode}}", "{{prompt}}"]
        }
      ]
    })
  );
  const { state } = runJson(
    [
      "start",
      "--cwd",
      tmp,
      "--agent-config",
      configPath,
      "--agents",
      "cmd-stateless",
      "--max-grill-questions",
      "1",
      "--question",
      "Do legacy command session IDs stay stateless?",
      "--prompt",
      "hi"
    ],
    { env: { GRILL_TEST_COMMAND_STATELESS_SESSION_LOG: logPath } }
  );
  assert.equal(state.harnessSessions.juror?.["cmd-stateless"], undefined);
  assert.equal(state.decisions[0].rounds[0].responses["cmd-stateless"].promptMode, "full");
  assert.equal(state.decisions[0].rounds[1].responses["cmd-stateless"].promptMode, "full");
  const entries = fs.readFileSync(logPath, "utf8").trim().split("\n");
  const first = entries[0].split(":");
  const second = entries[1].split(":");
  assert.notEqual(first[0], second[0]);
  assert.deepEqual(
    entries.map((line) => line.split(":").slice(1)),
    [
      ["initial", "full"],
      ["challenge", "full"]
    ]
  );
});

test("command harness can opt into stable sessions and compact prompts", () => {
  const logPath = path.join(tmp, "command-session.log");
  const commandPath = writeFakeCommand(
    tmp,
    "command-session-agent.js",
    `
const fs = require("node:fs");
const [sessionId, promptMode, promptContextVersion, prompt] = process.argv.slice(2);
const actualMode = prompt.includes("Original user plan or decision:") ? "full" : "compact";
if (promptMode !== actualMode) {
  console.error("promptMode placeholder mismatch: " + promptMode + " vs " + actualMode);
  process.exit(2);
}
if (promptContextVersion !== "1") {
  console.error("unexpected prompt context version: " + promptContextVersion);
  process.exit(3);
}
const challenge = prompt.includes("Current round kind: challenge");
fs.appendFileSync(process.env.GRILL_TEST_COMMAND_SESSION_LOG, sessionId + ":" + (challenge ? "challenge" : "initial") + ":" + promptMode + "\\n");
console.log(JSON.stringify({
  stance: challenge ? "recommend" : "needs-evidence",
  recommendation: challenge ? "Command compact prompt accepted." : "Run a challenge round for the command harness.",
  rationale: "Fake command harness compact prompt test.",
  assumptions: [],
  risks: [],
  repo_findings: [],
  questions_for_other_jurors: challenge ? [] : [{ to: "all", question: "Did the command harness receive a compact prompt?", why: "Exercise command session opt-in." }],
  confidence: 0.8
}));
`
  );
  const configPath = path.join(tmp, "command-session-agent.json");
  fs.writeFileSync(
    configPath,
    JSON.stringify({
      agents: [
        {
          name: "cmd-session",
          command: commandPath,
          persistentSession: true,
          args: ["{{sessionId}}", "{{promptMode}}", "{{promptContextVersion}}", "{{prompt}}"]
        }
      ]
    })
  );
  const { state } = runJson(
    [
      "start",
      "--cwd",
      tmp,
      "--agent-config",
      configPath,
      "--agents",
      "cmd-session",
      "--max-grill-questions",
      "1",
      "--question",
      "Can command harnesses use compact prompts?",
      "--prompt",
      "hi"
    ],
    { env: { GRILL_TEST_COMMAND_SESSION_LOG: logPath } }
  );
  const sessionId = state.harnessSessions.juror["cmd-session"].sessionId;
  assert.equal(state.harnessSessions.juror["cmd-session"].contextPrimed, true);
  assert.equal(state.decisions[0].rounds[0].responses["cmd-session"].promptMode, "full");
  assert.equal(state.decisions[0].rounds[1].responses["cmd-session"].promptMode, "compact");
  assert.deepEqual(
    fs.readFileSync(logPath, "utf8").trim().split("\n"),
    [`${sessionId}:initial:full`, `${sessionId}:challenge:compact`]
  );
});

test("a zero user-question budget surfaces open questions in the decision final", () => {
  const { state } = runJson(["start", "--mock", "--cwd", tmp, "--max-user-questions", "0", "--prompt", "no-majority-demo: pick a color"]);
  const decision = state.decisions[0];
  assert.equal(decision.status, "resolved");
  assert.equal(decision.pendingUserQuestions, null);
  assert.ok(decision.final.open_user_questions.length >= 1, "unasked questions must be surfaced");
  assert.equal(decision.final.open_user_questions[0].recommended_default, "");
});

test("open user questions stop sequential auto-continuation", () => {
  const args = [
    "start",
    "--mock",
    "--cwd",
    tmp,
    "--max-user-questions",
    "0",
    "--prompt",
    "no-majority-demo two-question-demo: pick a color"
  ];
  const { state } = runJson(args);
  assert.equal(state.decisions.length, 1);
  assert.equal(state.final, null, "the top-level final must wait while open questions are visible");
  assert.ok(state.decisions[0].final.open_user_questions.length >= 1);

  const rendered = run(args);
  assert.equal(rendered.status, 0, rendered.stderr);
  assert.match(rendered.stdout, /Open user questions/);
  assert.doesNotMatch(rendered.stdout, /continue --state/);
});

test("old-shape mediator responses do not resolve split recommendations", () => {
  const commandPath = writeFakeCommand(
    tmp,
    "old-shape-mediator.js",
    `
const fs = require("node:fs");
const prompt = fs.readFileSync(0, "utf8");
if (prompt.includes("acting as the mediator")) {
  console.log(JSON.stringify({
    recommendation: "Pick the first listed option.",
    rationale: "This intentionally omits requires_user to mimic an old mediator response.",
    consensus: false,
    unresolved_disagreements: ["The fake jurors disagree."],
    confidence: 0.5
  }));
  process.exit(0);
}
const agent = /Your juror id is ([^\\n.]+)/.exec(prompt)?.[1] || "unknown";
console.log(JSON.stringify({
  stance: "recommend",
  recommendation: "Recommendation from " + agent,
  rationale: "Distinct fake juror position.",
  assumptions: [],
  risks: [],
  repo_findings: [],
  questions_for_other_jurors: [],
  confidence: 0.7
}));
`
  );
  const configPath = path.join(tmp, "old-shape-mediator-agents.json");
  fs.writeFileSync(
    configPath,
    JSON.stringify({
      agents: [
        { name: "a", command: commandPath },
        { name: "b", command: commandPath },
        { name: "c", command: commandPath }
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
    "a,b,c",
    "--question",
    "Which split recommendation should win?",
    "--prompt",
    "choose"
  ]);
  const decision = state.decisions[0];
  assert.equal(decision.status, "needs-user");
  assert.equal(decision.pendingUserQuestions.length, 1);
  assert.equal(decision.final, null);
});

test("actionable non-consensus mediator output resolves without user escalation", () => {
  const commandPath = writeFakeCommand(
    tmp,
    "actionable-non-consensus-mediator.js",
    `
const fs = require("node:fs");
const prompt = fs.readFileSync(0, "utf8");
if (prompt.includes("acting as the mediator")) {
  console.log(JSON.stringify({
    recommendation: "Ship option A with the narrower implementation boundary.",
    rationale: "Two jurors prefer the same actionable direction with different wording; no user decision is required.",
    consensus: false,
    requires_user: false,
    unresolved_disagreements: ["One juror preferred a broader implementation."],
    confidence: 0.76
  }));
  process.exit(0);
}
const agent = /Your juror id is ([^\\n.]+)/.exec(prompt)?.[1] || "unknown";
const recommendations = {
  a: "Ship option A first because it is the smallest reversible slice.",
  b: "Prefer option A now, then revisit the broader architecture later.",
  c: "Ship option B because the architecture is cleaner."
};
console.log(JSON.stringify({
  stance: "recommend",
  recommendation: recommendations[agent] || "Ship option A.",
  rationale: "Fake juror position.",
  assumptions: [],
  risks: [],
  repo_findings: [],
  questions_for_other_jurors: [],
  confidence: 0.7
}));
`
  );
  const configPath = path.join(tmp, "actionable-non-consensus-agents.json");
  fs.writeFileSync(
    configPath,
    JSON.stringify({
      agents: [
        { name: "a", command: commandPath },
        { name: "b", command: commandPath },
        { name: "c", command: commandPath }
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
    "a,b,c",
    "--question",
    "Which actionable split should win?",
    "--prompt",
    "choose"
  ]);
  const decision = state.decisions[0];
  assert.equal(decision.status, "resolved");
  assert.equal(decision.pendingUserQuestions, null);
  assert.equal(decision.final.requires_user, false);
  assert.equal(decision.final.consensus, false);
  assert.match(decision.final.recommendation, /Ship option A/);
});

test("fallback majority detection uses full recommendation text", () => {
  const commandPath = writeFakeCommand(
    tmp,
    "long-prefix-jurors.js",
    `
const fs = require("node:fs");
const prompt = fs.readFileSync(0, "utf8");
if (prompt.includes("acting as the mediator")) {
  process.exit(2);
}
const agent = /Your juror id is ([^\\n.]+)/.exec(prompt)?.[1] || "unknown";
const sharedPrefix = "Keep the same implementation boundary and defer unrelated cleanup while preserving the current sync behavior, validation surface, and planner integration because ";
const tails = {
  a: "option A should ship first.",
  b: "option B should ship first.",
  c: "option C should ship first."
};
console.log(JSON.stringify({
  stance: "recommend",
  recommendation: sharedPrefix + (tails[agent] || "another option should ship first."),
  rationale: "The recommendations intentionally diverge after a long shared prefix.",
  assumptions: [],
  risks: [],
  repo_findings: [],
  questions_for_other_jurors: [],
  confidence: 0.7
}));
`
  );
  const configPath = path.join(tmp, "long-prefix-agents.json");
  fs.writeFileSync(
    configPath,
    JSON.stringify({
      agents: [
        { name: "a", command: commandPath },
        { name: "b", command: commandPath },
        { name: "c", command: commandPath }
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
    "a,b,c",
    "--question",
    "Which long-prefix recommendation is correct?",
    "--prompt",
    "choose"
  ]);
  const decision = state.decisions[0];
  assert.equal(decision.status, "needs-user");
  assert.equal(decision.pendingUserQuestions.length, 1);
  assert.equal(decision.final, null);
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
  assert.equal(state.decisions[0].status, "failed");
  assert.equal(state.decisions[0].final.all_jurors_failed, true);
  assert.equal(state.final, null);
  assert.equal(decisionSummaries[0].status, "failed");
  assert.equal(decisionSummaries[0].roundSummaries[0].failed_jurors[0].agent, "bad");
  assert.match(decisionSummaries[0].roundSummaries[0].outcome, /No jurors produced a usable response/);
});

test("continue retries a failed active decision", () => {
  const markerPath = path.join(tmp, "flaky-agent-marker");
  const commandPath = writeFakeCommand(
    tmp,
    "flaky-agent.js",
    `
const fs = require("node:fs");
const prompt = fs.readFileSync(0, "utf8");
if (prompt.includes("acting as the planner")) {
  console.log(JSON.stringify({
    done: true,
    question: "",
    rationale: "The retried focused decision resolved.",
    confidence: 0.8
  }));
  process.exit(0);
}
const markerPath = ${JSON.stringify(markerPath)};
if (!fs.existsSync(markerPath)) {
  fs.writeFileSync(markerPath, "failed-once");
  console.error("transient harness failure");
  process.exit(2);
}
if (prompt.includes("Current round kind: challenge")) {
  console.log(JSON.stringify({
    stance: "recommend",
    recommendation: "Retry challenge round ran after harness recovery.",
    rationale: "The failed infrastructure round did not consume the deliberation budget.",
    assumptions: [],
    risks: [],
    repo_findings: [],
    questions_for_other_jurors: [],
    confidence: 0.8
  }));
  process.exit(0);
}
console.log(JSON.stringify({
  stance: "needs-evidence",
  recommendation: "Retry the same focused question after harness recovery.",
  rationale: "The retry should still have budget for a challenge round.",
  assumptions: [],
  risks: [],
  repo_findings: [],
  questions_for_other_jurors: [
    { to: "all", question: "Did the failed round consume budget?", why: "Exercise retry round counting." }
  ],
  confidence: 0.8
}));
`
  );
  const configPath = path.join(tmp, "flaky-agent.json");
  fs.writeFileSync(configPath, JSON.stringify({ agents: [{ name: "flaky", command: commandPath }] }));
  const started = runJson([
    "start",
    "--cwd",
    tmp,
    "--agent-config",
    configPath,
    "--agents",
    "flaky",
    "--question",
    "Can a failed decision be retried?",
    "--prompt",
    "hi"
  ]);
  assert.equal(started.state.decisions[0].status, "failed");
  assert.equal(started.state.final, null);

  const continued = runJson(["continue", "--state", started.statePath]);
  assert.equal(continued.state.decisions.length, 1);
  assert.equal(continued.state.decisions[0].status, "resolved");
  assert.equal(continued.state.decisions[0].rounds.length, 3);
  assert.equal(continued.state.decisions[0].rounds[2].kind, "challenge");
  assert.equal(continued.state.decisions[0].final.all_jurors_failed, false);
  assert.ok(continued.state.final);
  assert.equal(continued.state.final.resolved_decisions, 1);
});

test("old all-failed resolved decisions are reopened as failed", () => {
  const statePath = path.join(tmp, "old-all-failed-state.json");
  const okFinal = {
    recommendation: "Use the existing path.",
    confidence: 0.8,
    consensus: true,
    all_jurors_failed: false,
    unresolved_disagreements: [],
    risks: [],
    assumptions: [],
    repo_findings: [],
    open_user_questions: []
  };
  const failedFinal = {
    recommendation: "All jurors failed. Fix harness availability, credentials, or CLI flags before using this run as design guidance.",
    confidence: 0,
    consensus: false,
    all_jurors_failed: true,
    failed_jurors: [{ agent: "bad", error: "failed" }],
    unresolved_disagreements: [],
    risks: ["No successful jury response was available to synthesize."],
    assumptions: [],
    repo_findings: [],
    open_user_questions: []
  };
  fs.writeFileSync(
    statePath,
    JSON.stringify({
      version: 1,
      mode: "sequential",
      cwd: tmp,
      prompt: "hi",
      maxRounds: 2,
      maxUserQuestions: 3,
      maxGrillQuestions: 200,
      mock: false,
      harnessSessions: {
        juror: {
          old: {
            sessionId: "stale-juror-session",
            contextPrimed: true,
            promptContextVersion: 1
          }
        },
        planner: {
          old: {
            sessionId: "stale-planner-session",
            contextPrimed: true,
            promptContextVersion: 1
          }
        }
      },
      agents: [],
      activeDecisionIndex: null,
      decisions: [
        {
          id: "d1",
          question: "Resolved question",
          status: "resolved",
          rounds: [],
          userAnswers: [],
          pendingUserQuestions: null,
          mediation: null,
          final: okFinal
        },
        {
          id: "d2",
          question: "Failed question",
          status: "resolved",
          rounds: [],
          userAnswers: [],
          pendingUserQuestions: null,
          mediation: null,
          final: failedFinal
        },
        {
          id: "d3",
          question: "Question that should be discarded",
          status: "resolved",
          rounds: [],
          userAnswers: [],
          pendingUserQuestions: null,
          mediation: null,
          final: okFinal
        }
      ],
      final: {
        recommendation: "stale final",
        confidence: 0.5,
        consensus: false,
        all_jurors_failed: false,
        resolved_decisions: 3,
        decision_count: 3
      }
    }),
    "utf8"
  );
  const { state } = runJson(["status", "--state", statePath]);
  assert.equal(state.final, null);
  assert.equal(state.decisions.length, 2);
  assert.equal(state.activeDecisionIndex, 1);
  assert.equal(state.decisions[1].status, "failed");
  assert.deepEqual(state.harnessSessions, {});
});

test("failed juror diagnostics are bounded before challenge rounds", () => {
  const commandPath = writeFakeCommand(
    tmp,
    "noisy-agent.js",
    `
const fs = require("node:fs");
const prompt = fs.readFileSync(0, "utf8");
if (prompt.includes("acting as the planner")) {
  console.log(JSON.stringify({
    done: true,
    question: "",
    rationale: "One bounded diagnostic decision is enough.",
    confidence: 0.8
  }));
  process.exit(0);
}
if (prompt.includes("acting as the mediator")) {
  console.log(JSON.stringify({
    recommendation: "Use the bounded diagnostic response.",
    rationale: "The challenge round stayed small enough to run.",
    consensus: true,
    requires_user: false,
    unresolved_disagreements: [],
    confidence: 0.8
  }));
  process.exit(0);
}
const agent = /Your juror id is ([^\\n.]+)/.exec(prompt)?.[1] || "unknown";
if (prompt.includes("Current round kind: challenge")) {
  if (prompt.length > 30000) {
    console.error("challenge prompt too large: " + prompt.length);
    process.exit(3);
  }
  console.log(JSON.stringify({
    stance: "recommend",
    recommendation: "Challenge prompt was bounded for " + agent,
    rationale: "The prior failed stderr did not flood this prompt.",
    assumptions: [],
    risks: [],
    repo_findings: [],
    questions_for_other_jurors: [],
    confidence: 0.8
  }));
  process.exit(0);
}
if (agent === "noisy") {
  console.error("x".repeat(100000));
  process.exit(2);
}
console.log(JSON.stringify({
  stance: "needs-evidence",
  recommendation: "Run a challenge round after a noisy juror failure.",
  rationale: "This exercises failed-juror disagreement prompt construction.",
  assumptions: [],
  risks: [],
  repo_findings: [],
  questions_for_other_jurors: [
    { to: "all", question: "Can the challenge prompt stay bounded?", why: "Guard against E2BIG regressions." }
  ],
  confidence: 0.7
}));
`
  );
  const configPath = path.join(tmp, "noisy-agents.json");
  fs.writeFileSync(
    configPath,
    JSON.stringify({
      agents: [
        { name: "asker", command: commandPath },
        { name: "noisy", command: commandPath }
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
    "asker,noisy",
    "--question",
    "Can diagnostics stay bounded?",
    "--prompt",
    "bounded diagnostics"
  ]);
  const decision = state.decisions[0];
  assert.equal(decision.rounds.length, 2);
  assert.equal(decision.rounds[0].responses.noisy.ok, false);
  assert.ok(decision.rounds[0].responses.noisy.stderr.length <= 20000);
  assert.ok(decision.rounds[0].responses.noisy.error.length <= 2000);
  assert.equal(decision.rounds[1].responses.noisy.ok, true);
  assert.equal(typeof decision.rounds[1].responses.noisy.durationMs, "number");
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

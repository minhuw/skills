# Testing Herder

Run these checks after changing any Herder skill, plan protocol, agent profile, installer, or plugin manifest.

## Fast deterministic checks

From the marketplace repository root:

```bash
node plugins/herder/skills/plans/scripts/test.mjs
node plugins/herder/skills/install/scripts/test.mjs
node plugins/herder/skills/fire/scripts/test.mjs
node plugins/herder/skills/fire/scripts/cleanup-test.mjs

python3 /path/to/skill-creator/scripts/quick_validate.py plugins/herder/skills/plans
python3 /path/to/skill-creator/scripts/quick_validate.py plugins/herder/skills/grill
python3 /path/to/skill-creator/scripts/quick_validate.py plugins/herder/skills/improve
python3 /path/to/skill-creator/scripts/quick_validate.py plugins/herder/skills/fire
python3 /path/to/skill-creator/scripts/quick_validate.py plugins/herder/skills/install
python3 /path/to/skill-creator/scripts/quick_validate.py plugins/herder/skills/validate
python3 /path/to/plugin-creator/scripts/validate_plugin.py plugins/herder

claude plugin validate . --strict
claude plugin validate plugins/herder --strict
git diff --check
```

The Fire script tests cover native agent-evidence extraction, coordinator gate isolation, compact Saver failure envelopes, per-generation recovery guards, linear cherry-pick integration, and fail-closed cleanup. The cleanup fixture proves dry-run behavior, ancestor and merge-free patch-equivalent `DONE` cleanup, rejection of unmatched candidate patches, default preservation of failed evidence, explicit clean failed-evidence deletion, and preservation of dirty, unrecognized, unreachable, integration, and log state.

Use `uv run --with pyyaml python ...` when the validation scripts' Python environment does not already contain PyYAML.

## Local installation smoke test

This creates a real temporary Git repository and isolated `CODEX_HOME`, installs the current marketplace checkout through `codex plugin`, verifies all six skills are cached, initializes an ignored `herder-plans/` backlog through the installed manager, records and aggregates a usage attempt, validates the backlog, and runs the fixture's tests:

```bash
node plugins/herder/scripts/smoke-test.mjs
```

The temporary directory is deleted after success and preserved after failure.

## Live Codex compatibility test

This first installs the three native profiles in an isolated user-scoped Codex home, verifies that Multi-Agent V2 is enabled, and then exercises the full intent-to-plan pipeline against the fixture:

1. `$herder:grill <change>` investigates user intent, pauses for final confirmation, and creates one plan without changing source code or replacing the manager-generated usage ledger.
2. `$herder:plans status` reads the generated backlog and reports plan `001` ready.
3. `$herder:fire status` consumes the same backlog without spawning workers or changing files.

Run:

```bash
node plugins/herder/scripts/smoke-test.mjs --live --keep
```

The live test temporarily exposes `~/.codex/auth.json` to the isolated test home through a symlink; it never copies or prints credentials and removes the symlink before exiting. Override it when needed:

```bash
node plugins/herder/scripts/smoke-test.mjs \
  --live \
  --auth-file /path/to/auth.json \
  --workspace /tmp/herder-smoke-run
```

`--workspace` must name an empty directory and implies `--keep`. Inspect `transcripts/` there when a skill behaves unexpectedly. Delete the directory manually after inspection.

## Live Grill interaction test

This targeted mode creates one valid plan with a single unresolved decision, then resumes one Codex session across three turns. It verifies that `$herder:grill --plan 001` asks one question without editing, records the answer without editing, and changes the plan only after explicit confirmation. It then validates the refined backlog and confirms the source checkout stayed clean.

```bash
node plugins/herder/scripts/smoke-test.mjs --live-grill --keep
```

Use `--workspace` and `--auth-file` exactly as in the general live test. The transcript files include `00-install.jsonl`, `01-grill-question.jsonl`, `02-grill-answer.jsonl`, and `03-grill-confirm.jsonl`.

## Live Validate repair test

This targeted mode creates one executor-ready plan and audits it with `$herder:validate` without `--fix`, proving the plan directory and source checkout remain byte-for-byte unchanged. It then renames one required heading, proves manager validation fails, runs `$herder:validate --fix`, and verifies that:

- the canonical heading and manager validity are restored;
- plan `001` remains ready without a lifecycle transition;
- the manager-generated execution-usage ledger is unchanged; and
- no tracked source file changes.

```bash
node plugins/herder/scripts/smoke-test.mjs --live-validate --keep
```

Use `--workspace` and `--auth-file` exactly as in the general live test. The transcript files are `00-install.jsonl`, `01-validate-read-only.jsonl`, and `02-validate-fix.jsonl`.

## Live Fire execution test

This high-cost mode creates a plan with Improve and executes it through native Codex Multi-Agent V2. The isolated Codex configuration pins the main scheduler to Sol/max, enables `multi_agent_v2`, and gives the coordinator only the workspace-write roots needed for disposable worktrees and Git metadata. The test installs the native profiles in a fresh session, then verifies:

- Fire dispatches `agent_type` with `fork_turns: "none"` and never invokes the removed `codex exec` worker adapter.
- Implementers run Luna/max and reviewers run Sol/xhigh. The installed reviewer profile requests read-only; the transcript also records whether the coordinator's inherited runtime permission override superseded it, while Fire proves the reviewer left the staged tree unchanged.
- Every child transcript reports Multi-Agent V2 with one `NEW_TASK` envelope and no user-history messages, proving coordinator history was not forked. Its command evidence must stay under the disposable candidate, staging, or integration worktree root.
- Exact native per-child transcript telemetry is recorded as numeric `codex-multi-agent-v2-transcript` usage rows.
- Transcript evidence distinguishes a real final response from `task_complete` without an envelope, allowing a clean classifier/transport interruption to be recorded as `INTERRUPTED` and restarted without consuming a substantive saver round.
- Fire uses native `wait_agent` as a one-minute event-driven long poll rather than routine status polling, and coordinator verification calls use `run-gate.mjs` so passing command bodies do not enter the coordinator transcript.
- The integration branch passes tests while the source branch and checkout remain unchanged.

```bash
node plugins/herder/scripts/smoke-test.mjs \
  --live-fire \
  --workspace /tmp/herder-live-fire
```

The transcript files are `00-install.jsonl`, `01-improve.jsonl`, and `02-fire-run.jsonl`. The retained `reports/final-fire-report.md` contains Fire's user-facing result. `reports/native-spawn-evidence.json` records redacted namespaced routing arguments and coordinator configuration; it records only that an encrypted task payload existed, never the payload itself. `reports/native-agent-evidence.json` records the effective child role, model, effort, sandbox, repository context, execution workdirs, and token telemetry extracted from persisted Codex sessions. Inspect those reports together with the fixture, integration worktree, and `herder-plans/README.md`, then delete the workspace when finished.

## Release confidence

Before publishing, require all deterministic checks and the local installation smoke test. Run the general live test after changes to Improve output, the Plans protocol, or Fire's consumption of plan state. Run the targeted Grill test after changes to its interview, confirmation, or plan-editing contract. Run the targeted Validate test after changes to validation, repair boundaries, or Fire-readiness reporting. Run the high-cost Fire execution mode when scheduling, worktree, model routing, usage capture, review, or rescue behavior changes materially.

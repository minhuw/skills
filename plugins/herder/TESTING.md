# Testing Herder

Run these checks after changing any Herder skill, plan protocol, agent profile, installer, or plugin manifest.

## Fast deterministic checks

From the marketplace repository root:

```bash
node plugins/herder/skills/plans/scripts/test.mjs
node plugins/herder/skills/install/scripts/test.mjs
node plugins/herder/skills/fire/scripts/test.mjs

python3 /path/to/skill-creator/scripts/quick_validate.py plugins/herder/skills/plans
python3 /path/to/skill-creator/scripts/quick_validate.py plugins/herder/skills/grill
python3 /path/to/skill-creator/scripts/quick_validate.py plugins/herder/skills/improve
python3 /path/to/skill-creator/scripts/quick_validate.py plugins/herder/skills/fire
python3 /path/to/skill-creator/scripts/quick_validate.py plugins/herder/skills/install
python3 /path/to/plugin-creator/scripts/validate_plugin.py plugins/herder

claude plugin validate plugins/herder --strict
git diff --check
```

Use `uv run --with pyyaml python ...` when the validation scripts' Python environment does not already contain PyYAML.

## Local installation smoke test

This creates a real temporary Git repository and isolated `CODEX_HOME`, installs the current marketplace checkout through `codex plugin`, verifies all five skills are cached, initializes an ignored `herder-plans/` backlog through the installed manager, records and aggregates a usage attempt, validates the backlog, and runs the fixture's tests:

```bash
node plugins/herder/scripts/smoke-test.mjs
```

The temporary directory is deleted after success and preserved after failure.

## Live Codex compatibility test

This additionally starts three fresh Codex sessions against the fixture:

1. `$herder:improve plan` creates one plan without changing source code and preserves the manager-generated usage ledger.
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

This targeted mode creates one valid plan with a single unresolved decision, then resumes one Codex session across three turns. It verifies that `$herder:grill` asks one question without editing, records the answer without editing, and changes the plan only after explicit confirmation. It then validates the refined backlog and confirms the source checkout stayed clean.

```bash
node plugins/herder/scripts/smoke-test.mjs --live-grill --keep
```

Use `--workspace` and `--auth-file` exactly as in the general live test. The transcript files are `01-grill-question.jsonl`, `02-grill-answer.jsonl`, and `03-grill-confirm.jsonl`.

## Live Fire execution test

This high-cost mode creates a plan with Improve and executes it through the real Codex worker runner. It verifies explicit Luna/max implementation, Sol/xhigh review, numeric `codex-exec-jsonl` usage rows, a completed integration branch, passing integration tests, and an unchanged source branch. The outer Fire coordinator uses bypass permissions only inside the disposable fixture; worker sessions retain their role-specific sandboxes.

```bash
node plugins/herder/scripts/smoke-test.mjs \
  --live-fire \
  --workspace /tmp/herder-live-fire
```

The transcript files are `01-improve.jsonl` and `02-fire-run.jsonl`. Inspect the retained fixture, integration worktree, and `herder-plans/README.md`, then delete the workspace when finished.

## Release confidence

Before publishing, require all deterministic checks and the local installation smoke test. Run the general live test after changes to Improve output, the Plans protocol, or Fire's consumption of plan state. Run the targeted Grill test after changes to its interview, confirmation, or plan-editing contract. Run the high-cost Fire execution mode when scheduling, worktree, model routing, usage capture, review, or rescue behavior changes materially.

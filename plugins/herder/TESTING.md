# Testing Herder

Run these checks after changing any Herder skill, plan protocol, agent profile, installer, or plugin manifest.

## Fast deterministic checks

From the marketplace repository root:

```bash
node plugins/herder/skills/plans/scripts/test.mjs
node plugins/herder/skills/configure/scripts/test.mjs
node plugins/herder/skills/install/scripts/test.mjs
node plugins/herder/skills/fire/scripts/test.mjs
node plugins/herder/skills/fire/scripts/assignment-bundle-test.mjs
node plugins/herder/skills/fire/scripts/checkout-state-test.mjs
node plugins/herder/skills/fire/scripts/namespace-test.mjs
node plugins/herder/skills/fire/scripts/branch-model-test.mjs
node plugins/herder/skills/fire/scripts/cleanup-test.mjs

python3 /path/to/skill-creator/scripts/quick_validate.py plugins/herder/skills/plans
python3 /path/to/skill-creator/scripts/quick_validate.py plugins/herder/skills/configure
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

The Plans tests cover compiled shared-context snapshots, snapshot hashes, ignored legacy review-budget metadata, legacy shape warnings, dependency graphs, non-executable leak-directory isolation, and lifecycle/usage behavior. Configure tests cover native Codex profile generation, all supported Orca harness/mutability combinations, structural and live route probes, redaction, conflict refusal, and recoverable backups. The Fire script tests cover native agent identity, terminal, and usage evidence, Orca runtime-profile validation and tracked dispatch construction, byte-stable checkout snapshots for tracked/index/untracked user state, coordinator gate isolation, namespaced collision preflight, the default five-slot role-mixed worker pool, fully independent per-plan role pipelines, immediate slot backfilling, a final-only integration lock, one stable branch/worktree per plan, in-place checkpointed restacking, the deterministic six-round transition table, first-discovery review accounting, Judge escalation beginning at unresolved round 3, approval bypass, deferred leak records, stable relationship ledgers, repository-native linear history, private completion/checkpoint refs, and fail-closed cleanup. The assignment-bundle fixtures cover ignored and tracked plan directories, deterministic plan and integration-RUN materialization, branch and generation binding, source-path redaction, Git-status neutrality, read-only verification, stale snapshots, byte tampering, symlink escapes, and missing ignore rules. The namespace fixtures prove directory-derived names, explicit-name isolation, fresh-run collision refusal, resume validation, and parent/unknown branch protection. Cleanup fixtures prove native and Orca-owned removal, exact plan-branch recognition, private-ref validation, absence of Herder metadata from new commit history, dry-run behavior, clean/unlocked `DONE` cleanup, default preservation of non-`DONE` evidence, explicit failed-evidence deletion, terminal finalization, and preservation of dirty, locked, unknown, proofless, integration, and log state.

Use `uv run --with pyyaml python ...` when the validation scripts' Python environment does not already contain PyYAML.

## Local installation smoke test

This creates a real temporary Git repository and isolated `CODEX_HOME`, installs the current marketplace checkout through `codex plugin`, verifies all seven skills are cached, initializes an ignored `herder-plans/` backlog through the installed manager, records and aggregates a usage attempt, validates the backlog, and runs the fixture's tests:

```bash
node plugins/herder/scripts/smoke-test.mjs
```

The temporary directory is deleted after success and preserved after failure.

## Live Codex compatibility test

This first installs the four native profiles in an isolated user-scoped Codex home, verifies that Multi-Agent V2 is enabled, and then exercises the full intent-to-plan pipeline against the fixture:

1. `$herder:grill <change>` investigates user intent, pauses for final confirmation, and creates a shape-clean semantically bounded plan graph without changing source code or replacing the manager-generated usage ledger.
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

## Live plan-shaping test

This mode adds two six-handler caller cohorts behind a compatibility normalizer, then asks Grill to plan a safe object-result migration. It verifies that Codex produces at least three focused nodes (bounded cohort migrations plus dependent cleanup), every node is at most 1,200 words and eight files, dependency edges are explicit, write-scope overlaps are ordered, and source remains unchanged.

```bash
node plugins/herder/scripts/smoke-test.mjs --live-shape --keep
```

Use `--workspace` and `--auth-file` exactly as in the general live test. The transcript files include `00-install.jsonl`, `01-shape-intake.jsonl`, and `02-shape-confirm.jsonl`.

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

This high-cost mode creates a plan with Improve, narrows its declared path list while retaining required test and documentation work, and executes it through native Codex Multi-Agent V2. The isolated Codex configuration pins the main scheduler to Sol/max, enables `multi_agent_v2`, and gives the coordinator only the workspace-write roots needed for disposable worktrees and Git metadata. The test installs the native profiles in a fresh session, then verifies:

- Fire dispatches `agent_type` with `fork_turns: "none"` and never invokes the removed `codex exec` worker adapter. The installed native role set retains Saver for legacy resume compatibility, while the passing fresh fixture exercises Implementer and Reviewer and proves that both Judge and Saver are skipped.
- Implementers run Luna/max on Fast tier and reviewers run Sol/xhigh on Standard tier. The installed reviewer profile requests read-only; the transcript also records whether the coordinator's inherited runtime permission override superseded it, while Fire proves the reviewer left the plan branch unchanged.
- Every child transcript reports Multi-Agent V2 with one `NEW_TASK` envelope and no user-history messages, proving coordinator history was not forked. Tool-call text is not treated as filesystem-containment evidence.
- Fire materializes compiled context as read-only ignored `.herder/assignment.json` bundles in plan worktrees and a `.herder/run-assignment.json` bundle in integration, records their exact hashes, and verifies them around worker dispatch instead of sending Judge or another worker to the coordinator checkout.
- Exact native per-child transcript telemetry is recorded as numeric `codex-multi-agent-v2-transcript` usage rows.
- Transcript evidence distinguishes a real final response from `task_complete` without an envelope, allowing a clean classifier/transport interruption to be recorded as `INTERRUPTED` and restarted without consuming a substantive round.
- Fire uses native `wait_agent` as a thirty-minute event-driven long poll rather than routine status polling, and coordinator verification calls use `run-gate.mjs` so passing command bodies do not enter the coordinator transcript.
- The integration branch passes tests while the checkout guard proves the source branch, logical index, pre-existing dirty tracked bytes, and untracked bytes remain unchanged.
- The integrated diff includes paths beyond the declared list, every implementation-discovered companion path is reported through `DISCOVERED_PATHS` for semantic review, and no numeric path count gates execution; Judge is required only if the plan reaches escalation.

```bash
node plugins/herder/scripts/smoke-test.mjs \
  --live-fire \
  --workspace /tmp/herder-live-fire
```

The transcript files are `00-install.jsonl`, `01-improve.jsonl`, and `02-fire-run.jsonl`. The retained `reports/final-fire-report.md` contains Fire's user-facing result. `reports/native-spawn-evidence.json` records redacted namespaced routing arguments and coordinator configuration; it records only that an encrypted task payload existed, never the payload itself. `reports/native-agent-evidence.json` records the effective child role, model, effort, sandbox, repository context, terminal classification, and token telemetry extracted from persisted Codex sessions. Inspect those reports together with the fixture, integration worktree, and `herder-plans/README.md`, then delete the workspace when finished.

## Live Orca heterogeneous execution test

This high-cost compatibility test uses the bundled `orca-heterogeneous-profile.json`:

- Controller: Codex with `gpt-5.6-sol` in the profile's explicit permissive mode, required so its Orca CLI children can reach the saved runtime
- Implementer: Grok Build with `grok-4.5`
- Reviewer: Pi with `kimi-coding/k3`
- Judge: Pi with `openai/gpt-5.6-sol`
- Saver (legacy resume only): Grok Build with `grok-4.5`

First run the deterministic checks and prepare a disposable installed fixture:

```bash
node plugins/herder/scripts/smoke-test.mjs \
  --workspace /tmp/herder-orca-matrix
```

Start or restart Orca, register `/tmp/herder-orca-matrix/project`, create an independent controller worktree, and launch the controller through the runtime adapter so its exact profile hash, model, and effort are attested:

```bash
env CODEX_HOME=/tmp/herder-orca-matrix/codex-home \
  node /absolute/path/to/skills/fire/scripts/orca-runtime.mjs \
  launch-controller \
  --profile /absolute/path/to/skills/fire/references/orca-heterogeneous-profile.json \
  --controller-terminal <handle-returned-by-orca-terminal-create> \
  --controller-worktree id:<full-id-returned-by-orca-worktree-create>
```

The controller must run inside the Orca terminal. Ask it to:

1. create and validate the fixture's focused `--version` plan;
2. run Fire with `--runtime orca` and the absolute installed or source `orca-heterogeneous-profile.json`;
3. perform the two-layer interoperability confidence test in `skills/fire/references/orca-runtime.md`; and
4. retain compact routing, dispatch, Git, checkout-guard, and usage evidence under the fixture's private report/log directory.

Pass only when the adapter normalizes Orca's deterministic slash-to-hyphen branch rewrite while retaining the same opaque worktree ownership, every custom harness receives its tracked task through `tracked-terminal-send`, independent plan roles overlap across worktrees, approving plans integrate linearly through Grok and Pi/Kimi without Judge, the separate non-integrating round-3 drill exercises Pi/GPT Judge and a Grok round-4 Implementer, no fresh Saver dispatch occurs, every `worker_done` matches its task/dispatch/pane, Reviewer and Judge leave Git unchanged, Implementer mutates only its assigned Orca worktree, and the original fixture checkout remains byte-stable.

This test fails closed rather than falling back to native agents or another model. Codex, Grok Build, and Pi must already be authenticated. If the Orca bridge reports `stale_bootstrap` while an app process exists, restart Orca before retrying; do not delete bootstrap, daemon, or single-instance files.

## Release confidence

Before publishing, require all deterministic checks and the local installation smoke test. Run the general live test after changes to Improve output, the Plans protocol, or Fire's consumption of plan state. Run the live shaping test after changes to granularity, semantic scope, shared context, or split rules. Run the targeted Grill test after changes to its interview, confirmation, or plan-editing contract. Run the targeted Validate test after changes to validation, repair boundaries, or Fire-readiness reporting. Run the high-cost native Fire execution mode when scheduling, namespace, worktree, model routing, usage capture, review, judging, recovery behavior, or discovered-path adjudication changes materially. Its fixture must intentionally declare a path set narrower than the expected test-and-documentation implementation, then assert that additional changed paths are reported through `DISCOVERED_PATHS` without a numeric gate. Run the Orca heterogeneous mode after changes to cross-harness profile resolution, Orca worktree ownership, task dispatch/provenance, runtime recovery, or Orca cleanup.

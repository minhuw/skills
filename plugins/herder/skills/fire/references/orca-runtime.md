# Orca Cross-Harness Runtime

Use this reference only when Fire is invoked with `--runtime orca`. The independent plan-loop, escalated Judge, integration-lock, usage, and completion rules in `orchestration-protocol.md` remain authoritative. Orca replaces native child spawning and owns execution worktrees; it does not replace the Plans manager or Herder lifecycle.

## Runtime profile

Require `--runtime-profile <absolute-or-repo-relative-json>`. Validate it before Git mutation:

```text
node <plugin-root>/skills/fire/scripts/orca-runtime.mjs validate \
  --profile <runtime-profile> --pretty
```

The bundled interoperability profile is:

```text
<plugin-root>/skills/fire/references/orca-heterogeneous-profile.json
```

Use `$herder:configure` to generate and live-validate a project-specific profile. Do not hand-author command arrays or copy credentials into a profile.

It deliberately exercises:

| Role | Harness | Provider/model |
|---|---|---|
| Controller | Codex | `openai-codex/gpt-5.6-sol` |
| Implementer | Grok Build | `xai/grok-4.5` |
| Reviewer | Pi | `kimi-coding/k3` |
| Judge | Pi | `openai/gpt-5.6-sol` |
| Saver (legacy resume only) | Grok Build | `xai/grok-4.5` |

Model/provider names belong to the runtime profile, not the plan. Never copy credentials into a profile, prompt, task, log, or command. A role may use its harness's normal permissive mode, but it still receives the Herder role contract and must not create Herder workers, push, publish, deploy, or alter another worktree.

The Orca adapter supports only Codex, Grok Build, and Pi harnesses. Reject every other harness during profile validation rather than attempting an unverified readiness or delivery fallback.

The Kimi route is supplied by Pi's installed provider extension, so the Reviewer command must allow extension discovery. Its exact `--tools read,bash,grep,find,ls` allowlist still excludes Pi's edit/write tools and applies to extension/custom tools as well. Judge uses Pi's built-in OpenAI provider and may keep extension discovery disabled.

The bundled controller command deliberately includes Codex's `--dangerously-bypass-approvals-and-sandbox` mode. The controller must call the Orca CLI, whose saved runtime registry and local bridge live outside the repository sandbox; a sandboxed controller therefore cannot satisfy live preflight. This permissive mode is limited to an Orca-owned controller worktree and does not relax Herder's scope, provenance, review-only, or cleanup checks.

## Preconditions

The controller must itself be a Codex session in an Orca-managed terminal and worktree. Do not use a relay terminal or an external Codex Desktop/CLI controller for this runtime. From an Orca-managed shell, launch it through the validated profile so the adapter selects and attests the exact configured command:

```text
node <plugin-root>/skills/fire/scripts/orca-runtime.mjs launch-controller \
  --profile <runtime-profile> \
  --controller-terminal <controller-handle> \
  --controller-worktree id:<opaque-controller-worktree-id>
```

Run the live preflight before mutation:

```text
node <plugin-root>/skills/fire/scripts/orca-runtime.mjs preflight \
  --profile <runtime-profile> --pretty
```

Require:

- Orca runtime reachable and experimental orchestration enabled;
- current controller terminal handle and Orca worktree identity available;
- controller profile and launcher hashes inherited from `launch-controller`;
- every configured harness executable available;
- every configured non-controller provider/model probe successful;
- current controller routing consistent with the configured controller role;
- repository registered with Orca;
- no selected role silently substituted with another harness, provider, model, or effort.

Availability probes are not agent turns and must not modify the repository. Their output is reduced to pass/fail and a SHA-256; never include raw authentication, balance, or account output in coordinator context. A failed probe stops before mutation.

## Worktree authority

For this runtime, Orca is the sole worktree creator and remover. Git remains the source of truth for branch, HEAD, tree, status, ancestry, and integration proofs.

Use exact Herder branch names as Orca worktree display names:

```text
herder/<plan-name>/integration
herder/<plan-name>/<plan-id>
```

Create through `orca worktree create --repo id:<registered-repo-id> --name <exact-branch> --base-branch <expected-base-ref> --json`. Repository path selectors are not portable across paired/headless runtimes, so resolve and use Orca's registered opaque repository ID.

Current Orca releases replace `/` with `-` in the created Git branch while retaining the exact display name. Immediately normalize that one known rewrite through the runtime adapter:

```text
node <plugin-root>/skills/fire/scripts/orca-runtime.mjs normalize-worktree \
  --profile <runtime-profile> \
  --worktree id:<opaque-worktree-id> \
  --expected-branch herder/<plan-name>/<integration-or-plan-id> \
  --expected-head <expected-base-sha>
```

The adapter accepts only the exact Herder branch or its deterministic slash-to-hyphen Orca alias. It requires a clean worktree at the expected HEAD, refuses a pre-existing target ref or any other rewrite, renames the checked-out ref once, verifies byte-stable Git state, and re-verifies the same Orca worktree ID/path. Orca may keep reporting its original alias in cached metadata; Git is authoritative for live branch identity, while the opaque Orca ID/path remains authoritative for ownership and removal. Live testing proves `orca worktree rm` removes the normalized checkout and ref by opaque ID.

Before creation, require both the exact Herder ref and its slash-to-hyphen alias to be absent. After normalization, immediately verify with Git that:

- the path is a linked worktree of the exact repository;
- its symbolic branch is the exact requested Herder branch;
- HEAD equals the expected base SHA;
- no other path has the branch checked out.

If Orca produces any branch other than the exact name or deterministic alias, chooses a different base, omits a stable worktree identity, or returns an ambiguous path, stop and preserve the created state for reconciliation. Never perform an ad hoc rename, reset, delete, or recreation outside the adapter.

For a fresh integration worktree, create it at `base_commit`, then use one `git update-ref --stdin` transaction to verify the integration branch still equals `base_commit` and create the previously absent `base_ref` at that SHA. If the transaction loses a race, stop with the Orca worktree intact.

Record the opaque Orca worktree ID, absolute path, exact branch, and initial SHA in the coordinator's private run evidence outside every Git worktree. Do not add another file or parser under `plan_dir`.

Before removal, require the normal Herder cleanup proofs plus `orca terminal list --worktree <id> --json` showing no live or ambiguous worker. Remove only with `orca worktree rm --worktree <id> --json`, then verify both Git worktree and exact branch removal. Do not use raw `git worktree remove` for an Orca-owned worktree.

## Attempt dispatch

One Orca orchestration task represents exactly one Herder role attempt. It is transport/provenance state, not a Herder plan or lifecycle authority.

For each attempt:

1. Capture the checkout guard and exact plan branch HEAD/tree/status.
2. Lock the worktree using the normal Herder lease reason, including the attempt ID.
3. Write the complete self-contained role envelope to a private task file under `gate_log_root`, outside all worktrees.
4. Dispatch with:

   ```text
   node <plugin-root>/skills/fire/scripts/orca-runtime.mjs dispatch \
     --profile <runtime-profile> \
     --role <plan-implementer|plan-reviewer|plan-judge|plan-saver> \
     --worktree id:<opaque-worktree-id> \
     --task-file <private-task-file> \
     --attempt <attempt-id> \
     --controller-terminal <controller-handle> \
     --pretty
   ```

5. Persist its compact result: profile hash, role routing, attempt ID, worktree selector, controller/worker terminal handles, readiness mode and evidence hash, Orca task ID, dispatch ID, task hash, delivery hash, delivery mode `tracked-terminal-send`, and launcher hash.
6. Wait from the controller terminal:

   ```text
   orca orchestration check \
     --terminal <controller-handle> \
     --wait \
     --types worker_done,escalation,decision_gate \
     --timeout-ms 1800000 \
     --json
   ```

7. A timeout is only a heartbeat. Wait again unless other work is ready.
8. Accept completion only when `worker_done` comes from the assigned pane and contains the active task ID and dispatch ID. Confirm it with `orca orchestration dispatch-show --task <task-id> --from <controller-handle> --json`.
9. Re-run checkout guard and exact Git state proofs before interpreting the role envelope.
10. Close the terminal only after terminal evidence and usage are captured and no retry can reuse it. Every replacement attempt gets a fresh terminal and task.

`plan-saver` is accepted here only for resuming a durable legacy Saver dispatch. Fresh six-round generations use the other three roles.

The adapter assigns the tracked task without `dispatch --inject`, then sends the full task plus live lifecycle preamble directly to the assigned terminal. Herder's custom commands pin provider, model, effort, permissions, and extension state; Orca may not classify such a command as an injectable built-in agent even when its TUI is ready. `tracked-terminal-send` is the documented custom-terminal fallback: the task/dispatch still supplies provenance, and only matching `worker_done` from the assigned pane supplies completion authority.

Never use an untracked ad hoc `terminal send` prompt for a Herder attempt. Never treat terminal idleness, exit, a message without matching provenance, or Orca task status alone as a completed role envelope.

## Role prompts

Use the generic role contract from:

```text
<plugin-root>/agents/plan-implementer.md
<plugin-root>/agents/plan-reviewer.md
<plugin-root>/agents/plan-judge.md
<plugin-root>/agents/plan-saver.md
```

Strip only the plugin frontmatter and inline the complete remaining contract before the normal role-specific prompt envelope from `orchestration-protocol.md`. Load `plan-saver.md` only for a durable legacy Saver resume.

The Reviewer and Judge profiles intentionally omit Pi's edit and write tools. Their shell remains available for checks, so coordinator-side before/after Git proofs are still mandatory. Any Reviewer or Judge mutation is a failed attempt regardless of its verdict.

## Evidence and usage

For every attempt, retain:

- runtime-profile name and SHA-256;
- configured and effective harness/provider/model/effort;
- worktree ID/path/branch;
- controller and worker terminal handles;
- Orca task and dispatch IDs;
- task-envelope and launcher hashes;
- worker completion type and matching provenance;
- dispatch status fingerprint;
- exact before/after branch HEAD, tree, index/status, and checkout-guard result;
- terminal state and timestamps;
- structured host usage when the harness exposes it.

Do not claim filesystem containment from any harness transcript. Use the exact Orca worktree identity plus coordinator Git and checkout-guard evidence for repository-state protection. Record unavailable token fields as `unknown`; never trust model-written usage numbers over host telemetry and never estimate.

Orca terminal handles are runtime-scoped. After restart, reacquire terminals by recorded Orca worktree ID, correlate task/dispatch provenance, and apply normal resume ambiguity rules. A missing or contradictory task, dispatch, terminal, branch, or worktree mapping preserves state and stops that plan.

## Failure behavior

Never silently fall back to native spawning or a different role binding. Orca/runtime loss, missing authentication, unavailable configured model, failed injection, mismatched provenance, or stale unresolvable worktree identity is an infrastructure failure. Record the attempt when it became usage-bearing, preserve the branch/worktree, and apply the normal interruption/recovery bounds.

Repository failures and evidence-complete review revisions keep their normal Herder meaning. Orca transports them; it does not classify them.

## Interoperability confidence test

The rich live test has two layers:

1. Execute at least two independent focused plans and prove that an Implementer or Reviewer for one overlaps a different plan's Reviewer or Judge. Approving reviews skip Judge, and integration remains linear under the single coordinator lock.
2. On a disposable non-integrating probe plan, supply an evidence-complete round-3 nonapproval to Pi/GPT Judge, apply the authorized round-4 repair through Grok Implementer, and run targeted verification. Prove the deterministic round policy blocks any attempted seventh round and never dispatches Saver for the fresh generation.

The drill must be labeled test-only and must not manufacture a failure in an otherwise approving production plan. Success requires the controller plus all three fresh-run roles across the configured harnesses, exact task/dispatch provenance, correct worktree isolation, zero Reviewer/Judge mutation, expected Implementer mutation, preserved source checkout, no fresh Saver dispatch, and no model or harness substitution.

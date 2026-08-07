---
name: fire
description: Execute, resume, inspect, stop, or clean a validated herder-plans/ backlog through Herder's deterministic Run Manager. Use when the user asks to fire, run, resume, monitor, stop, or clean Herder plans. Do not use to create plans or implement one ordinary task directly.
---

# Herder Fire

The persistent Run Manager owns the plan state machine, SQLite accounting, worktrees, repository proofs, gates, restacking, integration, and dashboard. The root session is only the native host adapter: it dispatches returned actions, waits for native workers, and returns exact dispatch or terminal evidence.

Read [references/run-manager-protocol.md](references/run-manager-protocol.md) before starting or resuming a run.

## Invocation

Codex uses `$herder:fire`; Claude Code uses `/herder:fire`.

```text
herder:fire [<plan-dir>] [--plan-name <name>] [--max-parallel <n>] [--profile <name>]
herder:fire resume [<plan-dir>] [--profile <name>]
herder:fire status [<plan-dir>]
herder:fire stop [<plan-dir>]
herder:fire cleanup [<plan-dir>] [--plan <id>] [--dry-run] [--include-failed] [--finalize] [--handoff-target <branch>]
```

Defaults: `herder-plans/`, host profile `eclipse` on Codex or `shannon` on Claude Code, and five workers. No control-plane child consumes a worker slot.

## Control loop

Use the plugin's structured `herder_control` tool for `fire`, `resume`, `status`, `stop`, and every manager event. Never encode manager events into shell arguments or mutate SQLite directly.

For `fire` or `resume`, pass the absolute plan directory and repository root, current host, requested profile, plan name, and parallel limit. Validate the returned protocol version and run ID. The manager response contains zero or more actions.

For every action:

- Dispatch the exact `agentType` with fresh context and the returned `prompt` byte-for-byte.
- Do not override model, effort, or service tier; installed role definitions are the immutable profile binding.
- Use the returned worktree as the worker cwd. Codex native children inherit the coordinator cwd, so they must set every command `workdir` and every patch path to the absolute returned worktree.
- Dispatch the complete batch immediately. Return one `dispatch_results` event containing every action ID and either its real host handle or exact pre-handle rejection.

After accepted dispatches, use the host's longest event-driven wait. A timeout is not a failure. Batch terminal workers already available and return one `terminals` event with action ID, matching host handle, exact final role envelope, interruption/error state, and attributable usage evidence.

For each completed Codex worker, first read verified transcript evidence:

```bash
node <plugin-root>/skills/fire/scripts/read-codex-agent-evidence.mjs --agent <host-handle> --pretty
```

Require the expected role, model, effort, Multi-Agent V2 evidence, one task message, no user messages, terminal completion, final envelope, and non-null native usage. Copy its usage object into the terminal event. If evidence has not flushed, wait on that handle and retry.

Repeat until `complete`, `failed`, `stopped`, or `needs_input`. For `needs_input`, ask only the returned question and send the answer as one `user_input` event. Never repair or supplement manager decisions in the root session.

On completion, run the read-only report and present compact per-plan and total usage, timing coverage, dashboard URL, integration branch, and verified handoff command:

```bash
node <plugin-root>/skills/plans/scripts/herder-plans.mjs report RUN <plan-dir> --pretty
```

## Safety boundaries

- SQLite is the only runtime lifecycle authority. README status is a manager-maintained projection; Git refs and worktrees are proof/effect state.
- The manager schedules only Implementer, Reviewer, and Judge in one role-agnostic pool. Each plan has at most one active role; only integration is serialized.
- Reviewer and Judge are read-only. Implementer must leave the expected branch attached, assignment unchanged, worktree clean, and committed changes passing manager-run gates.
- A nonapproving review in rounds 1–2 goes directly to repair. Beginning with unresolved round 3, Judge filters findings before repair. Six substantive rounds are available.
- File and line counts never gate scope. Preserve the user's checkout and never merge into it, push, publish, deploy, or open a PR.

Cleanup remains proof-driven:

```bash
node <plugin-root>/skills/fire/scripts/cleanup-run.mjs <options>
```

It may remove only contained, clean, unlocked worktrees and branches whose completion/finalization proofs satisfy the requested mode. It never performs the user-branch handoff.

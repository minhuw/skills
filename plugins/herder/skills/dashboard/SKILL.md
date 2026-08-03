---
name: dashboard
description: Launch and inspect a read-only local web dashboard for a validated Herder plan backlog or active Fire run. Use when the user asks for a live progress UI, dependency graph, implementation-review pipeline view, attempt statistics, integration status, or finished-run report. Do not use it to mutate lifecycle, schedule workers, integrate branches, or replace Fire status automation.
---

# Herder Dashboard

Observe one Herder plan set through a loopback-only web interface. The dashboard derives every refresh from the existing sources of truth: README lifecycle and dependencies, SQLite attempt accounting, and Git branches/worktrees/private completion refs. It creates no scheduler state and exposes no write endpoint.

## Invocation

Codex uses `$herder:dashboard ...`; Claude Code uses `/herder:dashboard ...`.

```text
herder:dashboard [<plan-dir>] [--plan-name <name>] [--port <0..65535>]
herder:dashboard snapshot [<plan-dir>] [--plan-name <name>]
```

- Default plan directory: `herder-plans/`.
- Default plan-set name: the Git-safe basename of the resolved plan directory. Pass `--plan-name` when Fire used another namespace.
- Default port: `4173`. If occupied, use `--port 0` and report the selected URL printed by the server.
- `snapshot` prints the exact JSON model once and exits without starting a server.

## Launch

Resolve `<skill-dir>` to this `SKILL.md`'s directory. For the web dashboard, start this command in a persistent terminal or PTY:

```bash
node <skill-dir>/scripts/herder-dashboard.mjs --plan-dir <plan-dir> [--plan-name <name>] [--port <port>]
```

Wait for `URL: http://127.0.0.1:<port>/`, report that URL, and open it in the available local browser when browser control exists. Keep the terminal alive while the user observes the run. Stop it with Ctrl+C when requested or when the observing session is over.

For a one-time machine-readable snapshot, run:

```bash
node <skill-dir>/scripts/herder-dashboard.mjs --snapshot --pretty --plan-dir <plan-dir> [--plan-name <name>]
```

Report validation errors exactly. If the plan directory is missing, direct planning work to Grill or `herder:plans init`; do not synthesize dashboard state.

## Observer contract

- Bind only to `127.0.0.1`. Never proxy, tunnel, publish, or change the host binding.
- Keep the dashboard read-only. It permits only GET and HEAD, polls every two seconds, and never invokes Accountant or any worker.
- Do not add lifecycle controls, scheduling controls, Git actions, SQL writes, another state file, or a second plan parser.
- Treat README as plan graph/lifecycle truth, SQLite as immutable attempt-accounting truth, and Git refs/worktrees as execution and integration evidence.
- Paths and worker metadata are local operational data. Do not expose the dashboard beyond the loopback interface.
- Use `$herder:fire status` when the user needs the Accountant to reason about or act on control-plane state; the dashboard is an independent observer, not a controller.

The graph view supports active, attention, and finished filters. Selecting a plan shows its dependency state, current worktree lease, attempts grouped by round, model/tier/timing metadata, and token coverage. The integration section is derived from the same snapshot.

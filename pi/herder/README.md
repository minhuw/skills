# Herder for Pi

Herder is a native Pi extension package. It is not registered as a Pi skill.

## Install

```sh
pi install npm:pi-subagents
pi install git:github.com/minhuw/skills
```

Use `pi install /absolute/path/to/skills` while developing this checkout. Herder neither vendors nor installs `pi-subagents`; install the shared runtime once with the first command above. Fire fails before repository mutation with that installation command when the runtime is absent or with an update instruction when its public RPC contract is incompatible.

Start Pi with the root model and thinking level required by the chosen profile:

```text
pi --model <provider>/kimi-k3 --thinking max
/herder-fire herder-plans --profile offcut
```

Available commands:

- `/herder-fire [plan-dir] [--profile name] [--max-parallel n] [--no-dashboard]`
- `/herder-resume [plan-dir] [--profile name] [--max-parallel n] [--no-dashboard]`
- `/herder-status [plan-dir]`
- `/herder-dashboard [plan-dir]`
- `/herder-stop`

The `herder` tool exposes fire, resume, status, and dashboard actions to the active Pi model. Fire and resume return after the background controller starts. A compact Pi widget and the dashboard report progress.

## Responsibility boundary

Herder retains ownership of plan state, SQLite accounting, stable branches/worktrees, immutable assignments, review rounds, recovery, gates, and serialized integration. `pi-subagents` supplies package-agent discovery, child Pi processes, async lifecycle/control, nested dispatch, and first-completion waits.

The single `herder.plan-accountant` child is the run controller. It uses a rolling pool of nested role workers and backfills a slot as soon as any Implementer, Reviewer, Judge, or legacy Saver finishes. Each plan keeps one Herder-owned branch/worktree; `pi-subagents` temporary worktrees are not used. Only integration is globally serialized.

Five generic package agents serve every profile:

```text
herder.plan-accountant
herder.plan-implementer
herder.plan-reviewer
herder.plan-judge
herder.plan-saver
```

The profile supplies the exact model and Pi thinking level at launch. Before any repository mutation, Herder validates the root model, every requested child-model effort, and all five package-owned agent definitions; the separately installed runtime must answer the required async spawn/resume RPC contract. It never substitutes another model after failure.

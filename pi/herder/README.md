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

- `/herder-fire [plan-dir] [--profile name] [--max-parallel n] [--dashboard-port n]`
- `/herder-resume [plan-dir] [--profile name] [--max-parallel n] [--dashboard-port n]`
- `/herder-revise [plan-dir] [--profile name] [--dashboard-port n]`
- `/herder-status [plan-dir]`
- `/herder-dashboard [plan-dir]`
- `/herder-stop`

The `herder` tool exposes fire, resume, revise, status, and dashboard actions to the active Pi model. Fire and resume start or reuse the persistent local Run Manager and its dashboard, dispatch the first available worker batch, then return. Revise adopts a validated new immutable graph generation after all active workers settle. A compact Pi widget and the dashboard report progress.

## Responsibility boundary

The shared deterministic Run Manager retains ownership of plan state, SQLite accounting, stable branches/worktrees, immutable assignments, review rounds, recovery, gates, and serialized integration. `pi-subagents` supplies package-agent discovery, child Pi processes, and async lifecycle/control.

The extension translates manager actions directly into Implementer, Reviewer, and Judge child runs and sends their terminal evidence back to the service. The manager backfills the global pool as soon as any role finishes. Each plan keeps one Herder-owned branch/worktree; `pi-subagents` temporary worktrees are not used. Only integration is globally serialized.

Three generic package agents are available for every profile:

```text
herder.plan-implementer
herder.plan-reviewer
herder.plan-judge
```

The profile supplies each exact model and Pi thinking level at launch. Before repository mutation, Herder validates the root model, requested child-model efforts, package-owned definitions, and the separately installed runtime's async RPC contract. It never substitutes another model after failure.

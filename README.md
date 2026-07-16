# Herder

Herder is a task orchestrator engine for Claude Code and Codex.

## Claude Code

```sh
claude plugin marketplace add minhuw/skills
claude plugin install herder@herder
```

Start a new Claude Code session (or run `/reload-plugins`), then run `/herder:install` to verify the bundled Herder agents.

## Codex

```sh
codex plugin marketplace add minhuw/skills
codex plugin add herder@herder
```

Start a new Codex session and run `$herder:install`. Follow any printed Multi-Agent V2 setup instructions; if profiles or configuration change, start one more new session before using `$herder:fire`.
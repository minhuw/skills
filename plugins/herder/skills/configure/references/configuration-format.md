# Configuration format

Use schema version 1. The temporary answers file contains no credentials:

```json
{
  "schemaVersion": 1,
  "backend": "orca",
  "name": "project-orca",
  "roles": {
    "controller": {
      "harness": "codex",
      "model": "gpt-5.6-sol",
      "effort": "max"
    },
    "plan-implementer": {
      "harness": "grok-build",
      "model": "grok-4.5",
      "effort": "high"
    },
    "plan-reviewer": {
      "harness": "pi",
      "model": "kimi-coding/k3",
      "effort": "max"
    },
    "plan-judge": {
      "harness": "pi",
      "model": "openai/gpt-5.6-sol",
      "effort": "max"
    },
    "plan-saver": {
      "harness": "grok-build",
      "model": "grok-4.5",
      "effort": "high"
    }
  }
}
```

`backend` is `orca` or `native-codex`. The answers schema still contains the controller and four configurable worker roles; every native harness must be `codex`. Native generation updates only the unqualified legacy aliases used by pre-profile runs: its controller mapping becomes a launch command, the four worker mappings become project or user aliases, and generation also copies the fixed bundled `plan_accountant` alias. It does not alter any installed named profile. The legacy Accountant is always Luna/max/Fast and is never an Orca-routed role.

For native Codex profiles and Orca roles backed by Codex, the generator adds `service_tier = "fast"` to child roles whose model ID ends in `-luna`. It removes that setting from non-Luna child profiles and never enables Fast tier for the controller.

Validation checks only schema, role completeness, supported harness adapters, model-string shape, and effort values. Model IDs are otherwise opaque. Configure never queries a model catalog or performs a token-consuming live probe; Fire reports an exact dispatch rejection without fallback when the selected host cannot run a configured model.

Role names are exact. Unknown or missing roles fail validation.

Harness rules:

- `codex`: model is a Codex model ID; effort is `low`, `medium`, `high`, `xhigh`, or `max`.
- `grok-build`: model is a Grok model ID; effort is `low`, `medium`, or `high`.
- `pi`: model is the exact `provider/model` route; effort is `off`, `minimal`, `low`, `medium`, `high`, `xhigh`, or `max`.

The generator derives providers, commands, and permission modes. Do not add raw command arrays to the answers file.

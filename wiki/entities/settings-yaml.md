---
type: entity
title: settings.yaml
tags: [config, providers, llm]
related: [fleet-architecture, cordis-composition]
created: 2026-08-18
updated: 2026-08-18
---

# settings.yaml

LLM provider and runtime configuration for DSH.

## Location

`$DSH_HOME/settings.yaml` (default: `~/.dsh/settings.yaml`)

## Providers

| Provider | Base URL | API Key Env | Models |
|----------|----------|-------------|--------|
| opencode-go | opencode.ai/zen/go/v1 | OPENCODE_GO_KEY | deepseek-v4-flash, mimo-v2.5, +6 more |
| opencode-zen | opencode.ai/zen/v1 | OPENCODE_ZEN_KEY | deepseek-v4-flash-free, hy3-free, mimo-v2.5-free |
| local-llama | 127.0.0.1:8080/v1 | — | Qwopus APEX I Mini |

## Default Model

```yaml
agent-default-model:
  provider: opencode-go
  model: mimo-v2.5
  reasoningEffort: high
```

## Permission

```yaml
permission:
  defaultPreset: danger-full-access
```

## Seeding

The supervisor seeds this file from `container/settings.yaml` on first start. It is NEVER overwritten on subsequent starts.

---
type: entity
title: subagent-claude-code-fleet
tags: [plugin, subagent, claude]
related: [fleet-agent-provider]
created: 2026-08-18
updated: 2026-08-18
---

# subagent-claude-code-fleet

Fork of DSH subagent-claude-code provider for the fleet: adds mcpServers support to the official Agent SDK query options for Claude Code children.

## What It Does

- Extends Claude Code subagent provider with fleet-specific capabilities
- Adds mcpServers parameter to Agent SDK queries
- Enables fleet tool access for out-of-process Claude Code children

## Key Files

- `plugins/subagent-claude-code-fleet/src/index.ts` — Plugin entry
- `plugins/subagent-claude-code-fleet/src/process.ts` — Process management
- `plugins/subagent-claude-code-fleet/src/run.ts` — Run logic

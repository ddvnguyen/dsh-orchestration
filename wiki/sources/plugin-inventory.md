---
type: source
title: Plugin Inventory
tags: [plugins, inventory]
related: [fleet-architecture]
created: 2026-08-18
updated: 2026-08-18
---

# Plugin Inventory

All 19 fleet plugins with status and acceptance criteria.

## Enabled — Composed into :3080 (9)

| # | Plugin | Port | Acceptance |
|---|--------|------|------------|
| 1 | fleet-agent | 3093 | 15 tools (8 admin + 7 heartbeat) |
| 2 | fleet-teams | — | teams + rooms + grants |
| 3 | fleet-teams-ui | 3092 | rooms chat UI |
| 4 | fleet-board | 3090 | transparency feed |
| 5 | fleet-bus | — | event store + pub/sub |
| 6 | fleet-budget | — | cost tracking + caps |
| 7 | fleet-policy | — | postures + command policy |
| 8 | fleet-settings | 3094 | sessions + settings page |
| 9 | ui-fleet-settings | — | client-side settings |

## Standalone-Only (8)

fleet-heartbeat, fleet-mcp, fleet-inject, subagent-claude-code-fleet, fleet-tasks, fleet-supervisor, fleet-watchdog, fleet-agent-provider, fleet-schedule

## Disabled (1)

fleet-extras — no live consumer yet

Source: [[plugin-inventory]] (docs/plugin-inventory.md)

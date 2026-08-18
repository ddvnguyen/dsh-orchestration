---
type: entity
title: fleet-budget
tags: [plugin, cost, caps]
related: [fleet-policy, leader-contract]
created: 2026-08-18
updated: 2026-08-18
---

# fleet-budget

Cost tracking + scoped caps + soft warnings + escalation (owner decision #4).

## What It Does

- Per-identity / per-task-kind / global budgets
- Soft-warning threshold (default 80% of cap) → `fleet/budget-warning`
- Escalation threshold (default 100%) → `fleet/budget-escalated` to named owner
- **No hard stops** — budgets warn + escalate, never block work
- Durable SQLite store at `$DSH_HOME/fleet/fleet-budget.sqlite`
- 3 tools: budget_set, budget_record, budget_status

## Budget Scopes

| Scope | Format | Description |
|-------|--------|-------------|
| global | `global` | Whole fleet |
| per-agent | `agent:<id>` | Per identity |
| per-task-kind | `task-kind:<kind>` | Per task kind |

## Key Files

- `plugins/fleet-budget/src/service.ts` — Budget logic
- `plugins/fleet-budget/src/store.ts` — SQLite persistence
- `plugins/fleet-budget/src/types.ts` — Type definitions

---
type: entity
title: fleet-bus
tags: [plugin, events, pubsub]
related: [fleet-board, fleet-supervisor]
created: 2026-08-18
updated: 2026-08-18
---

# fleet-bus

Durable event store with pub/sub/replay and delivery to agents via `agent.followup` (wake) / `agent.inject` (quiet inbox).

## What It Does

- Publishes events with scope, type, payload, originKind
- Subscribe/unsubscribe to event topics
- Replay events from a sequence number
- Deliver events to agents (wake or inject)
- Store: `$DSH_HOME/fleet/fleet-bus.jsonl` (append-only JSONL)

## Event Types

| Event | Published By |
|-------|-------------|
| `fleet/task-created` | fleet-tasks |
| `fleet/task-claimed` | fleet-tasks |
| `fleet/task-completed` | fleet-tasks |
| `fleet/task-accepted` | fleet-tasks (QA gate) |
| `fleet/task-rejected` | fleet-tasks (QA gate) |
| `fleet/task-escalated` | fleet-tasks |
| `fleet/task-cancelled` | fleet-tasks |
| `fleet/wake` | fleet-supervisor |
| `fleet/digest` | fleet-supervisor |
| `fleet/budget-warning` | fleet-budget |
| `fleet/budget-escalated` | fleet-budget |
| `fleet/policy-denied` | fleet-policy |
| `fleet/policy-updated` | fleet-policy |

## Key Files

- `plugins/fleet-bus/src/service.ts` — Core bus logic
- `plugins/fleet-bus/src/store.ts` — JSONL persistence
- `plugins/fleet-bus/src/types.ts` — Event types
- `plugins/fleet-bus/src/fingerprint.ts` — Deduplication

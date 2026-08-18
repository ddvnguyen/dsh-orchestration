---
type: concept
title: Event-Driven Communication
tags: [architecture, events, pubsub]
related: [fleet-bus, fleet-board, fleet-supervisor]
created: 2026-08-18
updated: 2026-08-18
---

# Event-Driven Communication

All fleet communication flows through fleet-bus events. Every lifecycle transition publishes an event; the board renders them; the supervisor acts on them.

## Event Flow

```
agent action → fleet-bus publish → event stored (JSONL)
                                      ├─► subscribers notified
                                      ├─► board renders feed
                                      └─► supervisor processes
```

## Event Origin Kinds

| originKind | Source | Purpose |
|------------|--------|---------|
| task | fleet-tasks | Task lifecycle events |
| supervisor | fleet-supervisor | Wake, digest, queue events |
| watchdog | fleet-watchdog | Verification events |
| teams | fleet-teams | Team/room events |
| extras | fleet-extras | Workspace change events |
| budget | fleet-budget | Budget warning/escalation |
| policy | fleet-policy | Policy denied/updated |

## Self-Trigger Guard

Every plugin publishes with its own originKind. Subscribers can filter to avoid self-triggers (e.g., lead watches `fleet/task-*` but excludes `supervisor` and `watchdog`).

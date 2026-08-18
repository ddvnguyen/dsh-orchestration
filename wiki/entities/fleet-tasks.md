---
type: entity
title: fleet-tasks
tags: [plugin, tasks, queue]
related: [fleet-supervisor, fleet-watchdog, fleet-job-protocol]
created: 2026-08-18
updated: 2026-08-18
---

# fleet-tasks

Shared task queue with goal ancestry, workflow-state taxonomy, single-assignee atomic claims, severity-routed escalation, artifact contracts, and the heartbeat-wake claim seam.

## Workflow States

```
Triage → Backlog → Unstarted → Started → Completed → (QA gate)
                                                              ├─ Accepted (PASS)
                                                              └─ Rejected (FAIL) → Unstarted
```

## Severity Ladder

| Severity | Description |
|----------|-------------|
| P0 | Urgent |
| P1 | Normal |
| P2 | Low |

## Tools

6 tools: task_create, task_list, task_claim, task_complete, task_escalate, task_accept

## Key Files

- `plugins/fleet-tasks/src/service.ts` — Task lifecycle logic
- `plugins/fleet-tasks/src/store.ts` — SQLite persistence
- `plugins/fleet-tasks/src/types.ts` — Task types and states

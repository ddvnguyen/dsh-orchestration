---
type: source
title: Job Protocol Source
tags: [protocol, v2-v3, tasks]
related: [fleet-job-protocol, fleet-tasks]
created: 2026-08-18
updated: 2026-08-18
---

# Job Protocol Source

V2 job kinds (43001-43006) → V3 fleet task mapping with dispatch flow and board rendering.

## Severity Ladder

P0 urgent, P1 normal, P2 low. Escalation raises severity + records owner + next action.

## Board Rendering

Every verb publishes to fleet-bus with originKind. Board reads the DURABLE store, not in-memory registry.

Source: [[job-protocol]] (team/job-protocol.md)

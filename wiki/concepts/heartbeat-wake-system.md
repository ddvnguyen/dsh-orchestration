---
type: concept
title: Heartbeat & Wake System
tags: [heartbeat, liveness, wake]
related: [fleet-heartbeat, fleet-supervisor, fleet-agent]
created: 2026-08-18
updated: 2026-08-18
---

# Heartbeat & Wake System

Agent liveness tracking and wake delivery mechanism.

## Heartbeat

- Every DSH session auto-registers with `ctx.fleet` on creation
- System scans every 30s
- No heartbeat for 10min → agent flips to `stalled`

## Wake Delivery

1. Leader calls `fleet_wake` with agentId + kind + context
2. Supervisor delivers wake as a follow-up turn to that agent
3. Agent claims the task via `claimWake` or `task_claim`

## Checking Liveness

| Tool | Purpose |
|------|---------|
| fleet_list_agents | All agents with status + last heartbeat |
| fleet_get_status | One agent's detail |
| fleet_digest_now | Immediate fleet-wide snapshot |

---
type: entity
title: fleet-watchdog
tags: [plugin, verification, gate]
related: [fleet-tasks, fleet-supervisor]
created: 2026-08-18
updated: 2026-08-18
---

# fleet-watchdog

Verification gate on stopped work — when every leaf of a watched task tree rests, verifies the stop against evidence.

## What It Does

- Verifies artifact contract present + evidence non-empty + metric in passRange
- **Verification-shaped, no LLM** — structural checks only
- Rejects false 'done': reopens leaf, creates marked review task, reassigns via org-chart role routing
- Stop-fingerprint reuse (bus dedupe) suppresses re-verification within a window

## Verification Flow

```
task completed → watchdog verifies stop
  ├─ PASS: artifact contract present, evidence non-empty, metric in range
  └─ FAIL: reopen task → create [watchdog] review task → reassign
```

## Key Files

- `plugins/fleet-watchdog/src/service.ts` — Verification logic
- `plugins/fleet-watchdog/src/types.ts` — Types

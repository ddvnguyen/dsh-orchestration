---
type: entity
title: fleet-bootstrap
tags: [bootstrap, setup, idempotent]
related: [fleet-agent-model, fleet-agent-presets]
created: 2026-08-18
updated: 2026-08-18
---

# fleet-bootstrap

Idempotent V3 team setup — registers roster agents, mints ed25519 keys, writes presets.

## What It Does

1. Registers 6 roster agents with fleet-agent (ed25519 keypairs minted once, NEVER rotated)
2. Seeds org chart into fleet-tasks (claimRole routing)
3. Mounts fleet presets on one Context
4. Safe to re-run any number of times

## Usage

```bash
tsx team/bootstrap.ts
# or with custom home:
FLEET_TEAM_HOME=/custom/path tsx team/bootstrap.ts
```

## Key File

`team/bootstrap.ts` — 19KB, full idempotent setup logic

---
type: entity
title: fleet-agent
tags: [plugin, identity, ed25519]
related: [fleet-heartbeat, fleet-supervisor, fleet-agent-presets]
created: 2026-08-18
updated: 2026-08-18
---

# fleet-agent

Agent identity + agent config — per-agent profiles (id/name/role/status/publicKey) + ed25519-signed fleet events + actor attribution ledger.

## What It Does

- Registers `ctx.fleetAgent` service on the cordis context
- Manages ed25519 keypairs (minted once, never rotated)
- Provides 8 admin tools: agent_whoami, agent_sign, agent_verify, agent_audit, agent_update, agent_disable, agent_enable, agent_list
- Serves `/admin` and `/api/agents` routes on dsh webServer
- Standalone admin API on port 3093

## Key Files

- `plugins/fleet-agent/src/service.ts` — Core service (registration, profiles, keys)
- `plugins/fleet-agent/src/audit-ledger.ts` — Attribution records
- `plugins/fleet-agent/src/key-store.ts` — Ed25519 key management
- `plugins/fleet-agent/src/page.ts` — Admin web page
- `plugins/fleet-agent/src/bin.ts` — Standalone admin server

## Config

```yaml
- id: fleet-agent
  name: '@hydra/dsh-fleet-agent'
  inject: ['webServer']
  config:
    home: !!js dshHomePath('')
    autoRegisterAgents: false
    injectTools: true
```

## Port

3093 (standalone admin API)

## Acceptance

agent identity + `/admin` + `/api/agents` + 15 tools (8 admin + 7 heartbeat)

---
type: source
title: Production Deployment Guide
tags: [deployment, prod, systemd]
related: [fleet-dsh-service, fleet-supervisor-script, fleet-up-script]
created: 2026-08-18
updated: 2026-08-18
---

# Production Deployment Guide

Step-by-step deployment of the fleet orchestration system on ddv-server.

## Architecture

```
ddv-server (Linux, Node 24, pnpm 11)
├── dsh-orchestration/           ← fleet source of truth
├── llm-server-monitoring/external/deepseek-harness/ ← DSH fork
├── ~/.dsh/                      ← runtime store
└── systemd --user
    └── fleet-dsh.service → fleet-supervisor.sh
         ├── dsh web → :3080
         └── fleet-board → :3090
```

## Prerequisites

| Requirement | Version |
|-------------|---------|
| Node.js | ≥ 22 |
| pnpm | ≥ 9 |
| Python 3 | ≥ 3.10 |
| DSH fork | dsh-orchestration branch |

## Fresh Deploy

1. Clone repo + init submodule
2. Create node_modules symlink
3. Seed ~/.dsh/settings.yaml
4. Run `tsx team/bootstrap.ts`
5. Install systemd service
6. Enable and start

## Update Deploy

1. `git pull`
2. `systemctl --user restart fleet-dsh.service`
3. Verify

## Ports

| Port | Service |
|------|---------|
| 3080 | DSH web UI |
| 3090 | fleet-board |
| 3091 | fleet-exporter (optional) |
| 3093 | fleet-agent-admin (optional) |

Source: [[deploy-prod]] (docs/deploy-prod.md)

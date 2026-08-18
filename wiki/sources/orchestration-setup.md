---
type: source
title: Orchestration Setup Guide
tags: [setup, host-services]
related: [deploy-prod, fleet-supervisor-script]
created: 2026-08-18
updated: 2026-08-18
---

# Orchestration Setup Guide

How to set up and run the fleet on a host (no container).

## Quick Start

```bash
tsx team/bootstrap.ts          # idempotent fleet setup
bin/fleet-supervisor.sh        # start web :3080 + board :3090
curl localhost:3080/api/agents  # verify
curl localhost:3090/health     # verify
```

## Supervisor Startup Order

1. Seed settings.yaml (if absent)
2. Create @hydra symlinks in profiles/node_modules/
3. Run V3 team bootstrap
4. Start dsh web on :3080
5. Start fleet-board-server on :3090

## Presets

6 presets in $DSH_HOME/.agent-presets/:
fleet-lead, fleet-arch, fleet-dev-1, fleet-dev-2, fleet-devops, fleet-qa

Source: [[orchestration-setup]] (docs/orchestration-setup.md)

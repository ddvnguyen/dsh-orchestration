---
type: entity
title: fleet-supervisor.sh
tags: [script, supervisor, host]
related: [fleet-dsh-service, fleet-up-script]
created: 2026-08-18
updated: 2026-08-18
---

# fleet-supervisor.sh

Host-side fleet supervisor running under systemd. Same runtime as container entrypoint but native host processes.

## Startup Order (all idempotent)

1. Seed `$DSH_HOME/settings.yaml` from repo template when absent
2. Create @hydra symlinks in `$DSH_HOME/profiles/node_modules/@hydra/`
3. Run V3 team bootstrap (registers 6-agent roster, mints keys once)
4. Start DSH web UI on :3080 (patched source, fleet patch overlay)
5. Start standalone fleet-board-server on :3090

## Key Details

- Resolves OPENCODE_ZEN_KEY and OPENCODE_GO_KEY from opencode auth store
- Hardcoded paths: REPO=/mnt/WorkDisk/Workplace/llm-server-monitoring, FLEET=/mnt/WorkDisk/Workplace/dsh-orchestration
- Supervisor loop: checks both children every 5s, exits if either dies
- systemd Restart=on-failure brings it back

## Logs

- `$DSH_HOME/fleet/logs/dsh-web.out.log`
- `$DSH_HOME/fleet/logs/fleet-board.out.log`

Source: bin/fleet-supervisor.sh

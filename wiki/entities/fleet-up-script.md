---
type: entity
title: fleet-up
tags: [script, startup, systemd]
related: [fleet-supervisor-script, fleet-dsh-service]
created: 2026-08-18
updated: 2026-08-18
---

# fleet-up

Bring up (or restart) the DSH fleet host services + exporter.

## Usage

```bash
bin/fleet-up              # start everything
bin/fleet-up --no-exporter  # skip metrics exporter
```

## What It Does

1. `systemctl --user daemon-reload`
2. `systemctl --user enable fleet-dsh.service`
3. `systemctl --user restart fleet-dsh.service`
4. Wait for :3080 and :3090 (up to 30 × 5s = 150s)
5. Optionally start fleet-exporter.service

## Rollback

bin/fleet-down (if it exists)

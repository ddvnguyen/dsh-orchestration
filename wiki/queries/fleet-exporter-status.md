---
type: query
title: fleet-exporter.service Status
tags: [issue, monitoring, prometheus]
related: [fleet-dsh-service, prod-status]
created: 2026-08-18
updated: 2026-08-18
---

# fleet-exporter.service Status

The Prometheus metrics exporter service is inactive (dead).

## Current State

```
fleet-exporter.service - dsh fleet metrics exporter
  Active: inactive (dead)
  Loaded: enabled
```

## What It Does

- Python-based Prometheus scrape target on port 3091
- Reads fleet logs from `$DSH_HOME/fleet/logs/`
- Exposes `/metrics` endpoint

## Location

- Service: `~/.config/systemd/user/fleet-exporter.service`
- App: `/mnt/WorkDisk/Workplace/llm-server-monitoring/monitoring/fleet-exporter/`

## Investigation Needed

Why is it dead? Possible causes:
- Python dependency issue (requirements.txt)
- Port conflict
- Never started after last reboot

## Status

Open question — needs investigation.

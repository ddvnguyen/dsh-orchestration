---
type: synthesis
title: Production Status
tags: [status, prod, ddv-server]
related: [fleet-dsh-service, fleet-exporter-status, dsh-gaps]
created: 2026-08-18
updated: 2026-08-18
---

# Production Status

Current state of the DSH fleet on ddv-server (2026-08-18).

## Services

| Service | Status | Port |
|---------|--------|------|
| fleet-dsh.service | ✅ Active (10h+) | 3080, 3090 |
| fleet-exporter.service | ❌ Inactive (dead) | 3091 |

## Fleet

- 31 agents registered (6 roster + 25 session agents)
- 18 plugins in dsh-orchestration
- 7 plugins composed into web profile + mcp-searxng
- SearXNG containers running (searxng + mcp-searxng)

## Known Issues

1. fleet-exporter dead — needs investigation
2. 11 fleet plugins not in fleet-web.patch.yml (standalone-only or disabled)
3. DSH lacks native file tools (bash workaround)
4. DSH lacks settings-based MCP config (cordis workaround)

## Recent Changes

- containers.conf fixed: added /usr/libexec/podman to helper_binaries_dir
- SearXNG containers recreated
- MCP SearXNG entry added to fleet-web.patch.yml

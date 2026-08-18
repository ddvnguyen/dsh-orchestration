---
type: entity
title: fleet-github
tags: [plugin, github, auth, mcp]
related: [fleet-mcp, cordis-composition]
created: 2026-08-18
updated: 2026-08-18
---

# fleet-github

GitHub App authentication + MCP server integration for DSH fleet.

## What It Does

- Manages GitHub App token lifecycle via Doppler
- Generates JWT and exchanges for installation token
- Spawns mcp-server-github with the token
- Proxies stdio between parent and child
- Handles pre-emptive token refresh, crash recovery, health checks
- Exposes GitHub tools (repos, PRs, issues, code search) as `mcp__github__*`

## Token Lifecycle

1. Fetch private key from Doppler (or env/file fallback)
2. Generate JWT (RS256, 10min expiry)
3. Exchange JWT for installation token (60min lifetime)
4. Spawn mcp-server-github with token
5. Refresh token at 55min (pre-emptive)
6. Health check every 5min
7. Crash recovery with exponential backoff

## Config

```yaml
- id: fleet-github
  name: '@hydra/dsh-fleet-github'
  inject: ['webServer']
  config:
    appId: '3906823'
    installationId: '136596398'
    dopplerProject: 'hydra-vortex'
    dopplerConfig: 'dev'
```

## Key Files

- `plugins/fleet-github/src/index.ts` — Plugin implementation (420 lines)
- `plugins/fleet-github/package.json` — Package metadata

## Port

N/A (stdio MCP server, no HTTP port)

## Tools

GitHub tools exposed via MCP:
- Repos: list, get, create, update
- PRs: list, get, create, update, merge, review
- Issues: list, get, create, update, close
- Code search: search repos, search code
- And more (depends on mcp-server-github version)

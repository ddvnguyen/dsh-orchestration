---
type: query
title: Missing MCP Configuration in DSH Settings
tags: [gap, mcp, config]
related: [dsh-gaps, opencode-vs-dsh-mcp, cordis-composition]
created: 2026-08-18
updated: 2026-08-18
---

# Missing MCP Configuration in DSH Settings

DSH has no `mcpServers` section in `settings.yaml`. MCP is only configurable through cordis composition entries.

## The Problem

- OpenCode configures MCP servers in `~/.config/opencode/opencode.jsonc` under `"mcp": { ... }`
- DSH requires editing `fleet-web.patch.yml` or `cordis.patch.yml` to add MCP servers
- No UI for MCP configuration
- No settings-based MCP config

## Workaround

Add `@deepseek-ai/dsh-mcp-client` entries to `fleet-web.patch.yml`:

```yaml
- id: mcp-searxng
  name: '@deepseek-ai/dsh-mcp-client'
  config:
    transport: streamable-http
    serverName: searxng
    url: http://127.0.0.1:3002/mcp
```

## Status

Open question — DSH limitation, not a fleet issue.

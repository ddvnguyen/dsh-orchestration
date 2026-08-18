---
type: entity
title: fleet-mcp
tags: [plugin, mcp, stdio]
related: [fleet-heartbeat, mcp-searxng]
created: 2026-08-18
updated: 2026-08-18
---

# fleet-mcp

MCP (stdio) server exposing the fleet registry as tools so ANY agent can message/task other agents.

## What It Does

- Standalone MCP server (`dsh-fleet-mcp` bin)
- Exposes: fleet/list_agents, fleet/get_status, fleet/send_message, fleet/wait_for_agent
- Enables cross-process agent communication

## Standalone Bin

```bash
dsh-fleet-mcp  # stdio MCP server
```

## Note

This is the fleet's OWN MCP server (outbound). For connecting to external MCP servers like SearXNG, DSH uses `@deepseek-ai/dsh-mcp-client` configured via cordis composition in `fleet-web.patch.yml`.

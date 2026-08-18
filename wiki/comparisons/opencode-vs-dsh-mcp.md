---
type: comparison
title: MCP Configuration — OpenCode vs DSH
tags: [comparison, mcp, config]
related: [missing-mcp-config, cordis-composition]
created: 2026-08-18
updated: 2026-08-18
---

# MCP Configuration — OpenCode vs DSH

How the two systems handle MCP server configuration.

## OpenCode

**Config file:** `~/.config/opencode/opencode.jsonc`

```json
{
  "mcp": {
    "mcp-searxng": {
      "enabled": true,
      "timeout": 60000,
      "type": "remote",
      "url": "http://127.0.0.1:3002/mcp"
    }
  }
}
```

**Pros:**
- Simple JSON config
- UI integration (settings page)
- Per-server enable/disable

**Cons:**
- Config file only, no programmatic API

## DSH

**Config method:** cordis composition in `fleet-web.patch.yml`

```yaml
- id: mcp-searxng
  name: '@deepseek-ai/dsh-mcp-client'
  config:
    transport: streamable-http
    serverName: searxng
    url: http://127.0.0.1:3002/mcp
```

**Pros:**
- Cordis lifecycle (auto-reconnect, disposal)
- Typed config with schemastery validation
- Composable with other plugins

**Cons:**
- No settings.yaml integration
- No UI for MCP configuration
- Requires editing YAML files
- Must restart service to apply changes

## Summary

| Aspect | OpenCode | DSH |
|--------|----------|-----|
| Config location | settings.jsonc | fleet-web.patch.yml |
| UI support | Yes | No |
| Lifecycle management | Manual | Cordis (auto-reconnect) |
| Restart required | No | Yes |
| Typed config | No | Yes (schemastery) |

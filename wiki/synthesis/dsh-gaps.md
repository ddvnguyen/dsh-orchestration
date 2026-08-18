---
type: synthesis
title: DSH Gaps — Missing Primitives
tags: [analysis, gaps, tools]
related: [missing-file-tools, missing-mcp-config, dsh-config-catalog]
created: 2026-08-18
updated: 2026-08-18
---

# DSH Gaps — Missing Primitives

Cross-cutting analysis of what DSH is missing compared to a fully-featured agent harness.

## Gap 1: No Native File Tools

DSH has `@deepseek-ai/dsh-tool-bash` but no `@deepseek-ai/dsh-tool-file`. All file operations go through bash, which means:
- No structured output
- No audit trail
- No sandbox integration
- No search tools (grep/glob are bash workarounds)

## Gap 2: No MCP Configuration in Settings

DSH's `settings.yaml` has no `mcpServers` section. MCP servers must be configured through cordis composition (fleet-web.patch.yml), not through the UI or settings.

## Gap 3: No Native Search Tools

No `search_code`, `search_files`, or `web_search` tools. The DSH tool catalog shows `@deepseek-ai/dsh-tool-web` exists (web_fetch, web_search) but it's not in the fleet-web.patch.yml composition.

## Impact on Fleet

The fleet works around these gaps by:
- Using bash for all file operations
- Adding MCP servers via fleet-web.patch.yml
- Delegating search to external MCP servers (SearXNG)

## Recommendations

1. File tools: Propose `@deepseek-ai/dsh-tool-file` package
2. MCP config: Add `mcpServers` section to settings.yaml schema
3. Search: Enable `@deepseek-ai/dsh-tool-web` in fleet composition

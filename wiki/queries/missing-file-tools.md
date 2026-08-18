---
type: query
title: Missing File Tools in DSH
tags: [gap, tools, files]
related: [dsh-gaps, dsh-config-catalog]
created: 2026-08-18
updated: 2026-08-18
---

# Missing File Tools in DSH

DSH has no native file read/write/search tools. Agents must use `bash` for all file operations.

## What's Missing

| Tool | Purpose | Workaround |
|------|---------|------------|
| file_read | Read file contents | `bash -c "cat file"` |
| file_write | Create/overwrite files | `bash -c "cat > file"` |
| file_edit | Surgical find-replace | `bash -c "sed -i ..."` |
| file_list / file_glob | Directory listing, pattern matching | `bash -c "find ..."` |
| search_code | Grep/ripgrep across codebase | `bash -c "grep ..."` |
| search_files | Find files by name/extension | `bash -c "find ..."` |

## Impact

- No structured output from file operations
- No audit trail in the harness
- No sandbox integration beyond bash policy
- Agent must parse raw stdout every time

## Status

Open question — no DSH issue or PR yet.

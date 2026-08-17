# Fleet status — 2026-08-18 (dsh-orchestration dogfooding)

## Fleet summary
- All 18 plugins migrated to dsh-orchestration
- Supervisor: systemd fleet-dsh.service from /mnt/WorkDisk/Workplace/dsh-orchestration
- Web UI: :3080, Board: :3090
- opencode-go provider: opencode.ai/zen/go/v1 (deepseek-v4-flash, mimo-v2.5, + 6 more)
- Compaction: thresholdRatio=0.4, retainRatio=0.20, maxTokens=30K (all fleet presets)

## Ready queue
(empty)

## In-flight
(empty — leader just started, no tasks dispatched yet)

## Completed
- [done] Q1 config-HMR verification
- [done] Q4 settings layout (right-side panel)
- [done] Q3 settings surface
- [done] E2E host-native suite
- [done] Leader preset implementation
- [done] Host-services migration (container → systemd)
- [done] V3 P0-P4.4 all plugins verified (20/20 suites)
- [done] Contract cleanup (0 Paseo refs, AGENTS.md 14K→4.3K)
- [done] dsh-orchestration repo setup + full plugin migration
- [done] settings.yaml opencode-go provider config
- [done] Compaction config in all fleet presets
- [done] §5.1 heartbeat & wake system documented
- [done] §14 status file binding

## Blocked / hold
- [hold] fleet-intake — owner HOLD
- [hold] nostr-bridge — deferred

## Follow-ups
- dsh-orchestration standalone dev (pnpm workspace for @deepseek-ai/* imports)
- fleet-agent-provider Phase 2-4 (preset param, worktree lifecycle, background+wake)
- fleet-mcp cross-process ACP wiring (blocked on upstream DSH)

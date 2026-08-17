# dsh-orchestration docs

Fleet orchestration on deepseek-harness (DSH). Everything DSH-native — plugins, presets, web UI.

## Quick links

| Doc | What it covers |
|---|---|
| [v3-design.md](v3-design.md) | V3 architecture, plugin inventory, phases |
| [plugin-inventory.md](plugin-inventory.md) | All 18 fleet plugins — status, ports, acceptance |
| [orchestration-setup.md](orchestration-setup.md) | How to set up and run the fleet on a host |
| [deploy-prod.md](deploy-prod.md) | Step-by-step production deploy on ddv-server |

## Key files

| Path | Purpose |
|---|---|
| `team/leader-contract.md` | Lead agent binding rules (§1–§13) |
| `team/job-protocol.md` | Task lifecycle + QA gate |
| `team/roster.yaml` + `roster.ts` | Agent profiles (6 roster entries) |
| `team/org-chart.ts` | claimRole routing |
| `team/prompts/lead.md` | Lead agent prompt |
| `team/bootstrap.ts` | Idempotent fleet setup (presets + roster + stores) |
| `plugins/` | Fleet plugin packages |
| `tests/` | Smoke tests (20/20 suites) |
| `lessons/` | Verified lessons from prior runs |
| `skills/` | Reference patterns (stall detection, deploy verification, PR review) |

# dsh-orchestration Migration Plan

Fleet orchestration code migrating from `LLM-Agents-Orchestration/experiments/dsh-fleet/` into this dedicated repo.

## What Migrates FROM LLM-Agents-Orchestration TO dsh-orchestration

| Source | Destination | Notes |
|---|---|---|
| `experiments/dsh-fleet/plugins/fleet-agent/` | `plugins/fleet-agent/` | Host-side plugin |
| `experiments/dsh-fleet/plugins/fleet-teams/` | `plugins/fleet-teams/` | Host-side plugin |
| `experiments/dsh-fleet/plugins/fleet-board/` | `plugins/fleet-board/` | Host-side plugin |
| `experiments/dsh-fleet/plugins/fleet-policy/` | `plugins/fleet-policy/` | Host-side plugin |
| `experiments/dsh-fleet/plugins/fleet-budget/` | `plugins/fleet-budget/` | Host-side plugin |
| `experiments/dsh-fleet/plugins/fleet-settings/` | `plugins/fleet-settings/` | Host-side API routes |
| `experiments/dsh-fleet/plugins/fleet-teams-ui/` | `plugins/fleet-teams-ui/` | Host-side UI |
| `external/deepseek-harness/packages/client/ui-fleet-settings/` | `plugins/ui-fleet-settings/` | Client-side React (MOVE OUT of harness) |
| `experiments/dsh-fleet/team/` | `team/` | Roster, bootstrap, presets, prompts |
| `experiments/dsh-fleet/tests/` | `tests/` | Fleet smoke tests |
| `dsh-fleet-container/` | `container/` | Dockerfile, patches, supervisor |
| `bin/fleet-*.sh` | `bin/` | Supervisor scripts |

## What STAYS in LLM-Agents-Orchestration

| File | Why |
|---|---|
| `external/deepseek-harness/` | DSH submodule (upstream dependency) |
| `external/dsh-orchestration/` | NEW submodule (fleet code) |
| `orchestration/state/` | Lead agent state (runtime, not code) |
| `AGENTS.md`, `orchestration/LEAD_CHARTER.md` | Leader contract (runtime) |
| `.agents/skills/` | Agent skills (runtime) |

## Migration Steps

1. **[DONE]** Create dsh-orchestration repo + submodule
2. Copy plugin source files to dsh-orchestration
3. Copy team/ and tests/
4. Move ui-fleet-settings from harness to dsh-orchestration
5. Update fleet-web.patch.yml to resolve plugins from dsh-orchestration
6. Update bin/fleet-supervisor.sh to resolve paths from dsh-orchestration
7. Update experiments/dsh-fleet/ to be a thin wrapper or remove
8. Verify: npm test, fleet-up, E2E all pass

## Constraints

- No changes to existing fleet plugins or DSH harness during initial migration
- Submodule addition must be clean (no uncommitted changes in parent)
- All paths in fleet-web.patch.yml must resolve correctly after migration
- Fleet supervisor scripts must find plugins relative to dsh-orchestration root

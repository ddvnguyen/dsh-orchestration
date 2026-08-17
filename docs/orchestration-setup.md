# Orchestration Setup — host services

Fleet runs as native host processes under systemd --user (no container).

## Prerequisites

- DSH submodule: `external/deepseek-harness` (fork branch `dsh-orchestration`)
- Fleet plugins: `experiments/dsh-fleet/plugins/` (or `external/dsh-orchestration/plugins/`)
- Node.js + pnpm
- ed25519 keypairs (minted once by bootstrap, stored in `$DSH_HOME/fleet/agent/`)

## Quick start

```bash
# 1. Bootstrap fleet (idempotent — safe to re-run)
tsx team/bootstrap.ts

# 2. Start supervisor (web :3080 + board :3090)
bin/fleet-supervisor.sh

# 3. Verify
curl localhost:3080/api/agents    # fleet-agent profiles
curl localhost:3090/health         # board health
```

## Supervisor script

`bin/fleet-supervisor.sh` order at start (all idempotent):
1. Seed `$DSH_HOME/settings.yaml` from repo template when absent
2. Make `@hydra` fleet plugin packages resolvable (symlinks in `$DSH_HOME/profiles/node_modules/@hydra/`)
3. Run V3 team bootstrap (registers 6-agent roster, mints keys once)
4. Start DSH web UI on :3080 (patched source, fleet patch overlay)
5. Start standalone fleet-board-server on :3090

Supervisor loop keeps both children alive; service exits if either dies (systemd Restart=on-failure brings it back).

## Systemd units

```ini
# ~/.config/systemd/user/fleet-dsh.service
[Unit]
Description=Fleet DSH Supervisor
After=network.target

[Service]
ExecStart=/path/to/bin/fleet-supervisor.sh
Restart=on-failure
RestartSec=5

[Install]
WantedBy=default.target
```

## Presets

Bootstrap writes 6 presets into `$DSH_HOME/.agent-presets/`:

| Preset | Agent | Fleet tools |
|---|---|---|
| fleet-lead | lead | agent, teams, board, policy, budget |
| fleet-arch | arch | agent, board, policy |
| fleet-dev-1 | dev-1 | agent, board |
| fleet-dev-2 | dev-2 | agent, board |
| fleet-devops | devops | agent, board, teams |
| fleet-qa | qa | agent, board |

Non-lead agents: NO fleet tools, but keep native DSH subagent capability for research.

## Store

`$DSH_HOME/` (default `$HOME/.dsh/`):
- `fleet/agent/` — ed25519 keypairs + profiles
- `fleet/fleet-bus.jsonl` — event store
- `fleet/fleet-tasks.sqlite` — task queue
- `fleet/fleet-budget.sqlite` — budget tracking
- `fleet/teams/` — teams.json + room memory files
- `.agent-presets/` — preset YAML + cordis.yml per agent

## Web composition

`dsh-fleet-container/fleet-web.patch.yml` — host-plane overlay for :3080. All fleet plugins have `injectTools: true` (fleet tools available to all sessions; persona constrains usage via presets).

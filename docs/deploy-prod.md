# Deploy dsh-orchestration → PROD (this rig)

Step-by-step deployment of the fleet orchestration system on the production host (`ddv-server`).

## Architecture on this rig

```
┌─────────────────────────────────────────────────────────────────┐
│ ddv-server (Linux, Node 24, pnpm 11)                           │
│                                                                 │
│  dsh-orchestration/           ← THIS REPO (fleet source of truth)
│  ├── plugins/ (18 fleet plugins)
│  ├── team/ (bootstrap, roster, contract)
│  ├── bin/fleet-supervisor.sh  ← systemd ExecStart
│  └── node_modules → symlink to llm-server-monitoring/           │
│                      experiments/dsh-fleet/node_modules          │
│                                                                 │
│  llm-server-monitoring/external/deepseek-harness/               │
│  └── DSH fork (dsh-orchestration branch, all patches)          │
│                                                                 │
│  ~/.dsh/                              ← runtime store            │
│  ├── settings.yaml                   LLM provider config        │
│  ├── fleet/agent/                    ed25519 keys + profiles    │
│  ├── fleet/fleet-bus.jsonl           event store                │
│  ├── fleet/fleet-tasks.sqlite        task queue                 │
│  ├── fleet/fleet-budget.sqlite       budget tracking            │
│  ├── fleet/teams/                    team JSON + room memory    │
│  ├── fleet/logs/                     dsh-web + fleet-board logs │
│  └── .agent-presets/                 6 fleet presets             │
│                                                                 │
│  systemd --user                                            │
│  └── fleet-dsh.service  → fleet-supervisor.sh              │
│       ├── dsh web (pnpm dsh web --patch)  → :3080         │
│       └── fleet-board-server                           → :3090         │
└─────────────────────────────────────────────────────────────────┘
```

## Prerequisites

| Requirement | Version | Check |
|---|---|---|
| Node.js | ≥ 22 | `node -v` |
| pnpm | ≥ 9 | `pnpm -v` |
| Python 3 | ≥ 3.10 | `python3 --version` (for OPENCODE_ZEN_KEY resolution) |
| DSH fork | dsh-orchestration branch | `external/deepseek-harness` submodule |
| OPENCODE_ZEN_KEY | valid API key | `~/.local/share/opencode/auth.json` |

## Fresh deploy (new rig)

```bash
# 1. Clone dsh-orchestration
git clone https://github.com/ddvnguyen/dsh-orchestration.git /mnt/WorkDisk/Workplace/dsh-orchestration
cd /mnt/WorkDisk/Workplace/dsh-orchestration

# 2. Init DSH submodule (fork branch with all patches)
git submodule update --init --recursive

# 3. Create node_modules symlink (resolves @deepseek-ai/* deps)
#    This links to the DSH fork's node_modules which has all vendor packages
ln -sfn /mnt/WorkDisk/Workplace/llm-server-monitoring/experiments/dsh-fleet/node_modules \
  /mnt/WorkDisk/Workplace/dsh-orchestration/node_modules

# 4. Seed DSH home
mkdir -p ~/.dsh
cp container/settings.yaml ~/.dsh/settings.yaml   # if first time

# 5. Run bootstrap (idempotent — safe to re-run)
cd /mnt/WorkDisk/Workplace/dsh-orchestration
tsx team/bootstrap.ts
# → registers 6 roster agents, mints ed25519 keys, writes presets

# 6. Install systemd service
mkdir -p ~/.config/systemd/user
cat > ~/.config/systemd/user/fleet-dsh.service << 'EOF'
[Unit]
Description=dsh fleet supervisor (dsh web :3080 + fleet-board :3090, host services)
After=network.target
Wants=network.target

[Service]
Type=simple
Environment=DSH_HOME=/home/ddv/.dsh
Environment=FLEET_WEB_PORT=3080
Environment=FLEET_BOARD_PORT=3090
Environment=FLEET_WEB_TRUSTED_HOSTS=harness.ddvnguyen.com 100.127.245.31
ExecStart=/mnt/WorkDisk/Workplace/dsh-orchestration/bin/fleet-supervisor.sh
Restart=on-failure
RestartSec=5

[Install]
WantedBy=default.target
EOF

# 7. Enable and start
systemctl --user daemon-reload
systemctl --user enable fleet-dsh.service
systemctl --user restart fleet-dsh.service

# 8. Verify
curl -s localhost:3080/api/agents | jq '.count'    # → 30
curl -s localhost:3090/health                       # → {"ok":true,...}
systemctl --user status fleet-dsh.service           # → active (running)
```

## Update deploy (existing rig)

```bash
cd /mnt/WorkDisk/Workplace/dsh-orchestration

# 1. Pull latest
git pull

# 2. Restart (supervisor re-runs bootstrap + relaunches web + board)
systemctl --user restart fleet-dsh.service

# 3. Verify
curl -s localhost:3090/health
curl -s localhost:3080/api/agents | jq '.count'
```

## Daily operations

```bash
# Status
systemctl --user status fleet-dsh.service

# Logs (live)
journalctl --user -u fleet-dsh.service -f
tail -f ~/.dsh/fleet/logs/dsh-web.out.log
tail -f ~/.dsh/fleet/logs/fleet-board.out.log

# Restart
systemctl --user restart fleet-dsh.service

# Stop
systemctl --user stop fleet-dsh.service

# Board health
curl -s localhost:3090/health | jq .

# Agent profiles
curl -s localhost:3080/api/agents | jq '.profiles[] | {agentId, cwd, tier}'
```

## Ports

| Port | Service | Purpose |
|---|---|---|
| 3080 | DSH web UI | Main UI + fleet plugins (web profile) |
| 3090 | fleet-board | Transparency feed HTTP API |
| 3091 | fleet-exporter | Prometheus metrics (optional) |
| 3093 | fleet-agent-admin | Standalone admin API (optional) |

## Troubleshooting

| Symptom | Fix |
|---|---|
| Bootstrap fails: `Cannot find module '@deepseek-ai/cordis'` | Re-create node_modules symlink: `ln -sfn <path>/node_modules /mnt/WorkDisk/Workplace/dsh-orchestration/node_modules` |
| Web returns empty / 503 | Check `~/.dsh/fleet/logs/dsh-web.out.log` — usually still booting (10-15s) |
| Board returns empty | Check `~/.dsh/fleet/logs/fleet-board.out.log` |
| Agent profiles show old cwd | Re-run bootstrap: `tsx team/bootstrap.ts` (ed25519 keys are NOT rotated) |
| systemd won't start | `systemctl --user daemon-reload` then `systemctl --user restart fleet-dsh.service` |
| OPENCODE_ZEN_KEY missing | Ensure `~/.local/share/opencode/auth.json` exists with opencode key |

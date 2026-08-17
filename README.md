# dsh-orchestration

Fleet orchestration layer for DSH (DeepSeek Harness). Composes on top of DSH without forking it.

## Structure

- `plugins/` — @hydra/dsh-fleet-* cordis plugins (host-side)
- `plugins/ui-fleet-settings/` — client-side React plugin (DSH settings integration)
- `team/` — roster, bootstrap, presets, prompts, leader-contract
- `tests/` — fleet smoke tests
- `container/` — Dockerfile, fleet-web.patch.yml, supervisor scripts
- `bin/` — fleet-supervisor.sh, fleet-e2e.sh

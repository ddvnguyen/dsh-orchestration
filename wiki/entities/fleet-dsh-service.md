---
type: entity
title: fleet-dsh.service
tags: [systemd, service, host]
related: [fleet-supervisor-script, fleet-up-script]
created: 2026-08-18
updated: 2026-08-18
---

# fleet-dsh.service

systemd --user unit for the fleet runtime.

## Unit File

```ini
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
```

## Management

```bash
systemctl --user status fleet-dsh.service
systemctl --user restart fleet-dsh.service
systemctl --user stop fleet-dsh.service
journalctl --user -u fleet-dsh.service -f
```

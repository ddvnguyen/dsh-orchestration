#!/usr/bin/env bash
# fleet-e2e — host-native wrapper: run the live E2E against HOST services.
#
# Post-container migration (2026-08-17): runs the fleet agent-loop E2E as
# native host processes against $HOME/.dsh/fleet store, board :3090, exporter :3091.
#
# Usage:  bin/fleet-e2e          (runs the full suite, prints PASS/FAIL)
#         bin/fleet-e2e --quick  (skip PROBE, faster for CI)
# Rollback: data in $HOME/.dsh is preserved; re-run anytime.
set -euo pipefail

REPO_ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
RUNNER="$REPO_ROOT/external/dsh-orchestration/scripts/live-e2e-run.sh"

export FLEET_TEAM_HOME="${HOME}/.dsh"
export DSH_HOME="${HOME}/.dsh"

echo "[fleet-e2e] host-native E2E against fleet services (board :3090, exporter :3091)"
echo "[fleet-e2e] store: $HOME/.dsh/fleet"

# Verify fleet services are up before running.
BOARD_OK=$(curl -s -o /dev/null -w '%{http_code}' http://127.0.0.1:3090/health 2>/dev/null || echo "000")
EXPO_OK=$(curl -s -o /dev/null -w '%{http_code}' http://127.0.0.1:3091/metrics 2>/dev/null || echo "000")
if [ "$BOARD_OK" != "200" ] || [ "$EXPO_OK" != "200" ]; then
  echo "[fleet-e2e] FATAL: fleet services not reachable (board=$BOARD_OK, exporter=$EXPO_OK)" >&2
  echo "[fleet-e2e] Hint: run bin/fleet-up first" >&2
  exit 1
fi

EXIT_CODE=0
if bash "$RUNNER" "$@"; then
  echo
  echo "========================================="
  echo "  E2E RESULT: PASS"
  echo "========================================="
else
  EXIT_CODE=$?
  echo
  echo "========================================="
  echo "  E2E RESULT: FAIL (exit $EXIT_CODE)"
  echo "========================================="
fi

exit $EXIT_CODE

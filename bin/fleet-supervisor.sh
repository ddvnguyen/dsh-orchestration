#!/usr/bin/env bash
# fleet-supervisor.sh — host-side dsh fleet supervisor (post-container migration,
# 2026-08-17). Runs the same fleet runtime the container entrypoint did, but as
# native host processes under systemd (fleet-dsh.service).
#
# Order at start (all idempotent):
#   1. seed $DSH_HOME/settings.yaml from the repo template when absent
#   2. make the @hydra fleet plugin packages resolvable from any dsh profile
#      (per-package symlinks in $DSH_HOME/profiles/node_modules/@hydra/)
#   3. run the V3 team bootstrap (registers the 6-agent roster, mints keys once)
#   4. start the dsh web UI on :3080 (patched source, fleet patch overlay)
#   5. start the standalone fleet-board-server on :3090
#
# A supervisor loop keeps both children alive; the service exits if either dies
# (systemd Restart=on-failure brings it back).
set -uo pipefail

REPO=/mnt/WorkDisk/Workplace/llm-server-monitoring
DSH_HOME="${DSH_HOME:-$HOME/.dsh}"
HARNESS="$REPO/external/deepseek-harness"
FLEET=/mnt/WorkDisk/Workplace/dsh-orchestration
SEED="$REPO/dsh-fleet-container"
TSX="$HARNESS/node_modules/.bin/tsx"
WEB_PORT="${FLEET_WEB_PORT:-3080}"
BOARD_PORT="${FLEET_BOARD_PORT:-3090}"
# Host authorities the /api browser-trust fence must accept (DNS-rebinding
# defense, client-connection api-request-trust.ts). LAN IP literals + loopback
# are auto-derived by resolveLanTrust when the web server binds 0.0.0.0; a
# hostname like the Cloudflare-facing harness.ddvnguyen.com is NOT derived, so
# it (and the tailscale IP) are granted explicitly. Space-separated; override
# via FLEET_WEB_TRUSTED_HOSTS.
FLEET_WEB_TRUSTED_HOSTS="${FLEET_WEB_TRUSTED_HOSTS:-harness.ddvnguyen.com 100.127.245.31}"

# Runtime LLM credentials: settings.yaml references apiKeyEnv for provider routes.
# Resolve from the opencode auth store if not already set. Fails loudly only
# when a turn actually needs the provider — dsh web keeps serving config/UI.
if [ -z "${OPENCODE_ZEN_KEY:-}" ] && [ -f "$HOME/.local/share/opencode/auth.json" ]; then
  OPENCODE_ZEN_KEY="$(python3 -c "import json,os;print(json.load(open(os.path.expanduser('~/.local/share/opencode/auth.json')))['opencode']['key'])" 2>/dev/null || true)"
  if [ -n "$OPENCODE_ZEN_KEY" ]; then
    export OPENCODE_ZEN_KEY
    echo "[fleet] OPENCODE_ZEN_KEY resolved from opencode auth store"
  else
    echo "[fleet] WARN: OPENCODE_ZEN_KEY not resolved (auth.json key missing)" >&2
  fi
else
  export OPENCODE_ZEN_KEY="${OPENCODE_ZEN_KEY:-}"
fi

if [ -z "${OPENCODE_GO_KEY:-}" ] && [ -f "$HOME/.local/share/opencode/auth.json" ]; then
  OPENCODE_GO_KEY="$(python3 -c "import json,os;print(json.load(open(os.path.expanduser('~/.local/share/opencode/auth.json')))['opencode-go']['key'])" 2>/dev/null || true)"
  if [ -n "$OPENCODE_GO_KEY" ]; then
    export OPENCODE_GO_KEY
    echo "[fleet] OPENCODE_GO_KEY resolved from opencode auth store"
  else
    echo "[fleet] WARN: OPENCODE_GO_KEY not resolved (auth.json key missing)" >&2
  fi
else
  export OPENCODE_GO_KEY="${OPENCODE_GO_KEY:-}"
fi

mkdir -p "$DSH_HOME"

# 1) seed settings.yaml (no secrets; apiKeyEnv references the runtime token)
if [ ! -f "$DSH_HOME/settings.yaml" ]; then
  echo "[fleet] seeding $DSH_HOME/settings.yaml (opencode-zen + local-llama fallback)"
  cp "$SEED/settings.yaml" "$DSH_HOME/settings.yaml"
else
  echo "[fleet] keeping existing $DSH_HOME/settings.yaml"
fi

# 1b) @hydra fleet plugin packages resolvable from any dsh profile
#
# MODE: symlink (default) or copy
#   - FLEET_PLUGIN_MODE=symlink: fast, live updates, but source-dependent
#   - FLEET_PLUGIN_MODE=copy: isolated, safer for prod, but requires re-copy on change
#
FALLBACK_NM="$DSH_HOME/profiles/node_modules"
HYDRA_DIR="$FALLBACK_NM/@hydra"
PLUGIN_MODE="${FLEET_PLUGIN_MODE:-symlink}"
mkdir -p "$HYDRA_DIR"

# All known fleet plugins
ALL_PLUGINS="fleet-agent fleet-teams fleet-teams-ui fleet-board fleet-bus fleet-budget fleet-policy fleet-settings fleet-schedule fleet-github fleet-searxng"

# Phase 1: Remove stale entries (plugins that no longer exist)
for existing in "$HYDRA_DIR"/dsh-*; do
  [ -e "$existing" ] || continue
  existing_name="${existing##*/dsh-}"
  # Check if this plugin is in our known list
  if ! echo "$ALL_PLUGINS" | grep -qw "$existing_name"; then
    echo "[fleet] cleanup: removing stale plugin entry: $existing_name"
    rm -rf "$existing"
  fi
done

# Phase 2: Create/update plugin entries
for plugin in $ALL_PLUGINS; do
  target="$FLEET/plugins/$plugin"
  link="$HYDRA_DIR/dsh-$plugin"
  
  if [ ! -d "$target" ]; then
    echo "[fleet] WARN: plugin dir missing: $target" >&2
    continue
  fi
  
  case "$PLUGIN_MODE" in
    symlink)
      # Remove existing entry (file or dir) before creating symlink
      [ -e "$link" ] && rm -rf "$link"
      ln -sfn "$target" "$link"
      ;;
    copy)
      # Only copy if target is newer or link doesn't exist
      if [ ! -d "$link" ] || [ "$target" -nt "$link" ]; then
        echo "[fleet] copying: $plugin"
        rm -rf "$link"
        cp -a "$target" "$link"
      fi
      ;;
    *)
      echo "[fleet] ERROR: unknown FLEET_PLUGIN_MODE: $PLUGIN_MODE" >&2
      exit 1
      ;;
  esac
done

# Phase 3: Validate all entries
VALID=0
INVALID=0
for entry in "$HYDRA_DIR"/dsh-*; do
  [ -e "$entry" ] || continue
  if [ -d "$entry" ] && [ -f "$entry/package.json" ]; then
    VALID=$((VALID + 1))
  else
    echo "[fleet] WARN: invalid plugin entry: $entry" >&2
    INVALID=$((INVALID + 1))
  fi
done

echo "[fleet] @hydra plugins ($PLUGIN_MODE): $VALID valid, $INVALID invalid"
echo "[fleet] @hydra plugins: $(ls "$HYDRA_DIR" 2>/dev/null | tr '\n' ' ')"

# 2) V3 team bootstrap (idempotent)
echo "[fleet] running team bootstrap (FLEET_TEAM_HOME=$DSH_HOME)"
cd "$FLEET"
if ! FLEET_TEAM_HOME="$DSH_HOME" "$TSX" team/bootstrap.ts; then
  echo "[fleet] ERROR: team bootstrap failed" >&2
  exit 1
fi

# 3) dsh web UI (:3080) — binds 0.0.0.0 so the LAN can reach it. The upstream
#    source guard that refused --host 0.0.0.0 (RCE safety) is removed by the
#    owner-approved patch allow-0.0.0.0-web-host.patch applied permanently to
#    the harness submodule working tree; Cloudflare Access still gates the
#    public path. The web profile is composed with the fleet plugin family via
#    a --patch overlay (fleet-web.patch.yml), so /admin, /api/agents,
#    /fleet-teams-ui*, and /fleet-board* mount real routes on the main web UI
#    and win over the SPA catch-all. --trusted-host grants the /api fence the
#    public hostname + tailscale IP (must precede --port: passThroughOptions
#    ordering, same as --patch).
TRUSTED_FLAGS=()
for host in $FLEET_WEB_TRUSTED_HOSTS; do
  TRUSTED_FLAGS+=(--trusted-host "$host")
done
echo "[fleet] starting dsh web on 0.0.0.0:$WEB_PORT (fleet patch overlay; trusted hosts: $FLEET_WEB_TRUSTED_HOSTS)"
cd "$HARNESS"
DSH_HOME="$DSH_HOME" pnpm --config.verify-deps-before-run=false dsh web \
  --patch "$SEED/fleet-web.patch.yml" \
  --host 0.0.0.0 \
  "${TRUSTED_FLAGS[@]}" \
  --port "$WEB_PORT" \
  > "$DSH_HOME/fleet/logs/dsh-web.out.log" 2>&1 &
WEB_PID=$!

# 4) fleet-board-server (:3090)
echo "[fleet] starting fleet-board-server on 127.0.0.1:$BOARD_PORT"
cd "$FLEET"
DSH_HOME="$DSH_HOME" FLEET_BOARD_PORT="$BOARD_PORT" \
  "$TSX" plugins/fleet-board/src/bin.ts > "$DSH_HOME/fleet/logs/fleet-board.out.log" 2>&1 &
BOARD_PID=$!

echo "[fleet] children: web=$WEB_PID board=$BOARD_PID"
echo "[fleet] logs: $DSH_HOME/fleet/logs/dsh-web.out.log $DSH_HOME/fleet/logs/fleet-board.out.log"

# supervisor loop
while :; do
  if ! kill -0 "$WEB_PID" 2>/dev/null; then
    echo "[fleet] FATAL: dsh web ($WEB_PID) exited" >&2
    tail -n 30 "$DSH_HOME/fleet/logs/dsh-web.out.log" >&2
    exit 1
  fi
  if ! kill -0 "$BOARD_PID" 2>/dev/null; then
    echo "[fleet] FATAL: fleet-board-server ($BOARD_PID) exited" >&2
    tail -n 30 "$DSH_HOME/fleet/logs/fleet-board.out.log" >&2
    exit 1
  fi
  sleep 5
done

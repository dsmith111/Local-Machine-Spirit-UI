#!/usr/bin/env bash
# Installs the cogitator as a systemd service that starts at boot and restarts
# on failure. Fills in your user, this folder, and the full path to node, so
# the placeholder unit in deploy/ needs no hand-editing.
#
#   ./scripts/install-service.sh            # install (asks for sudo) and start
#   ./scripts/install-service.sh --print    # only show the unit it would write
#   ./scripts/install-service.sh --uninstall
set -euo pipefail

NAME=local-cogitator-interface
UNIT_PATH=/etc/systemd/system/$NAME.service
APP_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
RUN_USER="${SUDO_USER:-$(id -un)}"

if [[ "${1:-}" == "--uninstall" ]]; then
  sudo systemctl disable --now "$NAME" 2>/dev/null || true
  sudo rm -f "$UNIT_PATH"
  sudo systemctl daemon-reload
  echo "+++ Service removed. The machine spirit sleeps. +++"
  exit 0
fi

if ! command -v systemctl >/dev/null 2>&1; then
  echo "systemd was not found on this machine. Use another process manager (pm2, launchd, Docker, ...)." >&2
  exit 1
fi

# systemd does not load your shell profile, so nvm/asdf/fnm installs of node
# are invisible to it. Resolve the absolute path now, as the invoking user.
NODE_BIN="${NODE_BIN:-}"
if [[ -z "$NODE_BIN" ]]; then
  if [[ -n "${SUDO_USER:-}" ]]; then
    NODE_BIN="$(sudo -u "$SUDO_USER" -i bash -lc 'command -v node' 2>/dev/null || true)"
  fi
  NODE_BIN="${NODE_BIN:-$(command -v node || true)}"
fi
if [[ -z "$NODE_BIN" ]]; then
  echo "Could not find node. Install Node.js 18+ or run: NODE_BIN=/path/to/node $0" >&2
  exit 1
fi
NODE_BIN="$(readlink -f "$NODE_BIN")"
NODE_MAJOR="$("$NODE_BIN" -p 'process.versions.node.split(".")[0]')"
if (( NODE_MAJOR < 18 )); then
  echo "Node $("$NODE_BIN" -v) at $NODE_BIN is too old; 18 or newer is required." >&2
  exit 1
fi

if [[ ! -f "$APP_DIR/.env" ]]; then
  echo "WARNING: $APP_DIR/.env does not exist. Copy .env.example to .env and fill it in first." >&2
fi

UNIT="[Unit]
Description=Local Cogitator Interface (chat UI for a local agentic harness)
After=network-online.target
Wants=network-online.target

[Service]
Type=simple
User=$RUN_USER
WorkingDirectory=$APP_DIR
ExecStart=$NODE_BIN $APP_DIR/server.js
Restart=on-failure
RestartSec=3
NoNewPrivileges=true
PrivateTmp=true

[Install]
WantedBy=multi-user.target
"

if [[ "${1:-}" == "--print" ]]; then
  printf '%s' "$UNIT"
  exit 0
fi

echo "+++ Installing $NAME +++"
echo "    user: $RUN_USER"
echo "    dir:  $APP_DIR"
echo "    node: $NODE_BIN ($("$NODE_BIN" -v))"
printf '%s' "$UNIT" | sudo tee "$UNIT_PATH" >/dev/null
sudo systemctl daemon-reload
sudo systemctl enable "$NAME" >/dev/null 2>&1
sudo systemctl restart "$NAME"
sleep 2

if systemctl is-active --quiet "$NAME"; then
  echo "+++ The machine spirit is awake. +++"
  sudo journalctl -u "$NAME" -n 6 --no-pager -o cat || true
  echo
  echo "Logs:     journalctl -u $NAME -f"
  echo "Restart:  sudo systemctl restart $NAME   (after editing .env or pulling updates)"
  echo "Remove:   $0 --uninstall"
else
  echo "!!! The service failed to start. Recent logs:" >&2
  sudo journalctl -u "$NAME" -n 30 --no-pager -o cat >&2 || true
  exit 1
fi

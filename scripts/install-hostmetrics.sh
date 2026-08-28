#!/bin/bash
set -euo pipefail

# Installs the host metrics agent as a LaunchAgent. Only needed when the
# manager runs in Docker: apps that report on this Mac (mac-monitor) cannot
# read it from inside a Linux container and ask this agent instead.
#
#   BUSYBAR_HOST_METRICS_PORT=9000 ./scripts/install-hostmetrics.sh
#   BUSYBAR_HOST_METRICS_BIND=0.0.0.0 ./scripts/install-hostmetrics.sh

# Resolve project directory from script location
SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
PROJECT_DIR="$(cd "$(dirname "$SCRIPT_DIR")" && pwd)"

LABEL="busybar-hostmetrics"
PORT="${BUSYBAR_HOST_METRICS_PORT:-8322}"
# Loopback is enough for Docker Desktop, which proxies host.docker.internal
# from the host side. Set 0.0.0.0 for a manager on another machine; the agent
# has no authentication, so only on a trusted network.
BIND="${BUSYBAR_HOST_METRICS_BIND:-127.0.0.1}"

# Resolve a real interpreter rather than a shim: pyenv's python3 depends on
# shell setup that launchd does not do, and sys.executable points at the
# versioned binary behind it. Apple's python3 is the fallback, and is fine
# since the agent is stdlib only.
PYTHON_CMD="$(python3 -c 'import sys; print(sys.executable)' 2>/dev/null || true)"
if [ -z "$PYTHON_CMD" ] || [ ! -x "$PYTHON_CMD" ]; then
	PYTHON_CMD="/usr/bin/python3"
fi

if [ ! -x "$PYTHON_CMD" ]; then
	echo "Fout: python3 niet gevonden. Installeer via Homebrew:" >&2
	echo "  brew install python3" >&2
	exit 1
fi

# Fail here rather than in a log file nobody reads: a port already in use
# means launchd would restart the agent forever.
if lsof -nP -iTCP:"$PORT" -sTCP:LISTEN >/dev/null 2>&1; then
	echo "Fout: poort $PORT is al bezet. Kies een andere:" >&2
	echo "  BUSYBAR_HOST_METRICS_PORT=9000 ./scripts/install-hostmetrics.sh" >&2
	exit 1
fi

mkdir -p "$PROJECT_DIR/logs"

PLIST_SRC="$PROJECT_DIR/launchd/$LABEL.plist"
PLIST_DEST="$HOME/Library/LaunchAgents/$LABEL.plist"
mkdir -p "$(dirname "$PLIST_DEST")"

# Substitute placeholders
sed "s|__PYTHON__|$PYTHON_CMD|g; s|__PROJECT_DIR__|$PROJECT_DIR|g; s|__BIND__|$BIND|g; s|__PORT__|$PORT|g" \
	"$PLIST_SRC" > "$PLIST_DEST"

# Unload if already running (suppress error if not loaded)
launchctl bootout "gui/$(id -u)/$LABEL" 2>/dev/null || true

# Load the service
launchctl bootstrap "gui/$(id -u)" "$PLIST_DEST"

# Kick it to start immediately
launchctl kickstart -k "gui/$(id -u)/$LABEL"

echo ""
echo "✓ host metrics agent geactiveerd!"
echo ""
echo "Meetwaarden op: http://$BIND:$PORT/metrics"
echo "Vanuit de container: http://host.docker.internal:$PORT/metrics"
echo ""
echo "Logboeken bekijken:"
echo "  tail -f \"$PROJECT_DIR/logs/hostmetrics.log\""
echo "  tail -f \"$PROJECT_DIR/logs/hostmetrics.err.log\""
echo ""
echo "Service stoppen:"
echo "  ./scripts/uninstall-hostmetrics.sh"
echo ""

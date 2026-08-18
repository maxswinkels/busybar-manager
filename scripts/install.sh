#!/bin/bash
set -euo pipefail

# Resolve project directory from script location
SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
PROJECT_DIR="$(cd "$(dirname "$SCRIPT_DIR")" && pwd)"

# Check Node.js >= 22
NODE_CMD=$(command -v node || true)
if [ -z "$NODE_CMD" ]; then
	NODE_CMD="/opt/homebrew/bin/node"
fi

if [ ! -x "$NODE_CMD" ]; then
	echo "Fout: Node.js niet gevonden. Installeer Node.js >=22 via Homebrew:" >&2
	echo "  brew install node" >&2
	exit 1
fi

NODE_VERSION=$("$NODE_CMD" -v 2>/dev/null | sed 's/^v//' | cut -d. -f1)
if [ -z "$NODE_VERSION" ] || [ "$NODE_VERSION" -lt 22 ]; then
	echo "Fout: Node.js >=22 vereist (gevonden: $("$NODE_CMD" -v))." >&2
	exit 1
fi

# Check python3
if ! command -v python3 &> /dev/null; then
	echo "Fout: python3 niet gevonden. Installeer via Homebrew:" >&2
	echo "  brew install python3" >&2
	exit 1
fi

# Build the dashboard: web/dist is not in git, so a fresh clone has nothing to
# serve until Vite has run once. Rebuilding every install also keeps the bundle
# in sync with web/src after a pull.
NPM_CMD=$(command -v npm || true)
if [ -z "$NPM_CMD" ]; then
	NPM_CMD="$(dirname "$NODE_CMD")/npm"
fi

if [ ! -x "$NPM_CMD" ]; then
	echo "Fout: npm niet gevonden. Installeer Node.js >=22 via Homebrew:" >&2
	echo "  brew install node" >&2
	exit 1
fi

echo "Dashboard bouwen (web/dist)..."
"$NPM_CMD" --prefix "$PROJECT_DIR/web" install
"$NPM_CMD" --prefix "$PROJECT_DIR/web" run build

# Create logs directory
mkdir -p "$PROJECT_DIR/logs"

# Prepare plist for installation
PLIST_SRC="$PROJECT_DIR/launchd/nl.backspaced.busybar-manager.plist"
PLIST_DEST="$HOME/Library/LaunchAgents/nl.backspaced.busybar-manager.plist"
mkdir -p "$(dirname "$PLIST_DEST")"

# Substitute placeholders
sed "s|__NODE__|$NODE_CMD|g; s|__PROJECT_DIR__|$PROJECT_DIR|g" "$PLIST_SRC" > "$PLIST_DEST"

# Unload if already running (suppress error if not loaded)
launchctl bootout "gui/$(id -u)/nl.backspaced.busybar-manager" 2>/dev/null || true

# Load the service
launchctl bootstrap "gui/$(id -u)" "$PLIST_DEST"

# Kick it to start immediately
launchctl kickstart -k "gui/$(id -u)/nl.backspaced.busybar-manager"

# Print success message in Dutch
echo ""
echo "✓ busybar-manager geactiveerd!"
echo ""
echo "Dashboard draait op: http://127.0.0.1:8321"
echo ""
echo "Logboeken bekijken:"
echo "  tail -f \"$PROJECT_DIR/logs/manager.log\""
echo "  tail -f \"$PROJECT_DIR/logs/manager.err.log\""
echo ""
echo "Service stoppen:"
echo "  launchctl bootout gui/\$(id -u)/nl.backspaced.busybar-manager"
echo ""

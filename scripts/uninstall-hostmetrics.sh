#!/bin/bash
set -euo pipefail

# Resolve project directory from script location
SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
PROJECT_DIR="$(cd "$(dirname "$SCRIPT_DIR")" && pwd)"

LABEL="busybar-hostmetrics"
PLIST_DEST="$HOME/Library/LaunchAgents/$LABEL.plist"

# Unload the service (suppress error if not loaded)
launchctl bootout "gui/$(id -u)/$LABEL" 2>/dev/null || true

# Remove the plist
if [ -f "$PLIST_DEST" ]; then
	rm -f "$PLIST_DEST"
	echo "✓ host metrics agent verwijderd."
	echo ""
	echo "De projectbestanden in $PROJECT_DIR blijven intact."
	echo "Let op: apps die deze Mac uitlezen (mac-monitor) vallen nu stil in Docker."
else
	echo "⚠ LaunchAgent niet gevonden op $PLIST_DEST"
fi

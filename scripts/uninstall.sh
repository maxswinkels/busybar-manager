#!/bin/bash
set -euo pipefail

# Resolve project directory from script location
SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
PROJECT_DIR="$(cd "$(dirname "$SCRIPT_DIR")" && pwd)"

PLIST_DEST="$HOME/Library/LaunchAgents/nl.backspaced.busybar-manager.plist"
APP_DEST="$HOME/Applications/BusyBar Manager.app"

# Ask the app to quit so it can gracefully stop Node and all managed apps.
if pgrep -x BusyBarManager >/dev/null 2>&1; then
	/usr/bin/osascript -e 'tell application id "nl.backspaced.busybar-manager" to quit' 2>/dev/null || true
fi

# Unload the service (suppress error if not loaded)
launchctl bootout "gui/$(id -u)/nl.backspaced.busybar-manager" 2>/dev/null || true

# Remove the generated LaunchAgent and app bundle. Project data stays intact.
REMOVED=false
if [ -f "$PLIST_DEST" ]; then
	rm -f "$PLIST_DEST"
	REMOVED=true
fi
if [ -d "$APP_DEST" ]; then
	rm -rf "$APP_DEST"
	REMOVED=true
fi

if [ "$REMOVED" = true ]; then
	echo "✓ busybar-manager verwijderd."
	echo ""
	echo "De projectbestanden in $PROJECT_DIR blijven intact."
else
	echo "⚠ Geen geïnstalleerde BusyBar Manager-app of LaunchAgent gevonden."
fi

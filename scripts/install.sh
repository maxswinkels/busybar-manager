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
PYTHON_CMD=$(command -v python3 || true)
if [ -z "$PYTHON_CMD" ] || [ ! -x "$PYTHON_CMD" ]; then
	echo "Fout: python3 niet gevonden. Installeer via Homebrew:" >&2
	echo "  brew install python3" >&2
	exit 1
fi

# The menu-bar app is a tiny native Swift binary built for this Mac. Pass both
# SDK and deployment target explicitly: developer shells can otherwise make
# Swift target the host OS version without a matching standard library.
SWIFTC=$(/usr/bin/xcrun --sdk macosx --find swiftc 2>/dev/null || true)
if [ -z "$SWIFTC" ] || [ ! -x "$SWIFTC" ]; then
	echo "Fout: Swift compiler niet gevonden. Installeer de Xcode Command Line Tools:" >&2
	echo "  xcode-select --install" >&2
	exit 1
fi
MACOS_SDK=$(/usr/bin/xcrun --sdk macosx --show-sdk-path 2>/dev/null || true)
if [ -z "$MACOS_SDK" ] || [ ! -d "$MACOS_SDK" ]; then
	echo "Fout: macOS SDK niet gevonden. Installeer de Xcode Command Line Tools opnieuw:" >&2
	echo "  xcode-select --install" >&2
	exit 1
fi
MACOS_TARGET="$(/usr/bin/uname -m)-apple-macosx26.0"

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

# Build the native app in a temporary directory, then replace the installed
# copy only after the complete bundle has been created successfully.
APP_DEST="$HOME/Applications/BusyBar Manager.app"
APP_STAGE_ROOT=$(mktemp -d "${TMPDIR:-/tmp}/busybar-manager.XXXXXX")
trap 'rm -rf "$APP_STAGE_ROOT"' EXIT
APP_BUILD="$APP_STAGE_ROOT/BusyBar Manager.app"
CONTENTS="$APP_BUILD/Contents"
mkdir -p "$CONTENTS/MacOS" "$CONTENTS/Resources"

cp "$PROJECT_DIR/macos/Info.plist" "$CONTENTS/Info.plist"
/usr/bin/plutil -replace BusyBarNodeExecutable -string "$NODE_CMD" "$CONTENTS/Info.plist"
/usr/bin/plutil -replace BusyBarPythonExecutable -string "$PYTHON_CMD" "$CONTENTS/Info.plist"
/usr/bin/plutil -replace BusyBarProjectDirectory -string "$PROJECT_DIR" "$CONTENTS/Info.plist"

echo "macOS-app bouwen..."
"$SWIFTC" -target "$MACOS_TARGET" -sdk "$MACOS_SDK" -O -framework AppKit \
	"$PROJECT_DIR/macos/BusyBarManager.swift" \
	-o "$CONTENTS/MacOS/BusyBarManager"

# Reuse the dashboard favicon for the Finder app icon. The status-bar icon is
# a monochrome system symbol rendered by AppKit.
ICONSET="$APP_STAGE_ROOT/AppIcon.iconset"
mkdir -p "$ICONSET"
make_icon() {
	/usr/bin/sips -z "$1" "$1" "$PROJECT_DIR/web/public/favicon.png" --out "$ICONSET/$2" >/dev/null
}
make_icon 16 icon_16x16.png
make_icon 32 icon_16x16@2x.png
make_icon 32 icon_32x32.png
make_icon 64 icon_32x32@2x.png
make_icon 128 icon_128x128.png
make_icon 256 icon_128x128@2x.png
make_icon 256 icon_256x256.png
make_icon 512 icon_256x256@2x.png
make_icon 512 icon_512x512.png
make_icon 1024 icon_512x512@2x.png
/usr/bin/iconutil -c icns "$ICONSET" -o "$CONTENTS/Resources/AppIcon.icns"
/usr/bin/codesign --force --sign - --timestamp=none "$APP_BUILD" >/dev/null

# Stop either the old direct Node LaunchAgent or a currently-running app before
# replacing the app bundle.
launchctl bootout "gui/$(id -u)/nl.backspaced.busybar-manager" 2>/dev/null || true
if pgrep -x BusyBarManager >/dev/null 2>&1; then
	/usr/bin/osascript -e 'tell application id "nl.backspaced.busybar-manager" to quit' 2>/dev/null || true
fi

mkdir -p "$(dirname "$APP_DEST")"
rm -rf "$APP_DEST"
mv "$APP_BUILD" "$APP_DEST"

# Prepare plist for installation
PLIST_SRC="$PROJECT_DIR/launchd/nl.backspaced.busybar-manager.plist"
PLIST_DEST="$HOME/Library/LaunchAgents/nl.backspaced.busybar-manager.plist"
mkdir -p "$(dirname "$PLIST_DEST")"

# Install the LaunchAgent and set its app path without XML-escaping assumptions.
cp "$PLIST_SRC" "$PLIST_DEST"
/usr/libexec/PlistBuddy \
	-c "Set :ProgramArguments:0 $APP_DEST/Contents/MacOS/BusyBarManager" "$PLIST_DEST"

# Load the service
launchctl bootstrap "gui/$(id -u)" "$PLIST_DEST"

# RunAtLoad normally starts it during bootstrap; kickstart also covers an
# already-loaded but inactive job without killing a running instance.
launchctl kickstart "gui/$(id -u)/nl.backspaced.busybar-manager"

# Print success message in Dutch
echo ""
echo "✓ busybar-manager geactiveerd!"
echo ""
echo "App: $APP_DEST"
echo "Dashboard draait op: http://127.0.0.1:8321"
echo ""
echo "Logboeken bekijken:"
echo "  tail -f \"$PROJECT_DIR/logs/manager.log\""
echo "  tail -f \"$PROJECT_DIR/logs/manager.err.log\""
echo ""
echo "Stoppen: klik op het menubalk-icoon en kies Quit."
echo "Opnieuw starten:"
echo "  open \"$APP_DEST\""
echo ""

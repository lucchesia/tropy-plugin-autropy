#!/usr/bin/env bash
#
# Build and install this plugin into a local Tropy for testing (macOS).
#
#   npm run install-local            # Tropy Beta
#   npm run install-local -- Tropy   # Tropy stable
#
# Why this exists: after a rebuild it is easy to leave a STALE build installed
# and then debug identical symptoms against code that is not running. This
# always reports the version it installed, and refuses to overwrite a backup.
#
# Installs only the runtime files a plugin needs. Tropy must be fully quit
# afterwards (Cmd+Q) and relaunched — reopening the window does not reload
# plugin code.

set -euo pipefail

APP="${1:-Tropy Beta}"
REPO="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
PLUGINS="$HOME/Library/Application Support/$APP/plugins"
TARGET="$PLUGINS/tropy-plugin-autropy"

if [ ! -d "$PLUGINS" ]; then
  echo "error: no plugins directory for '$APP' at:" >&2
  echo "  $PLUGINS" >&2
  exit 1
fi

cd "$REPO"
npm run --silent build

VERSION="$(node -p "require('./package.json').version")"

if [ -e "$TARGET" ]; then
  BACKUP="$TARGET.backup-$(date +%Y%m%d-%H%M%S)"
  mv "$TARGET" "$BACKUP"
  echo "backed up previous install → $(basename "$BACKUP")"
fi

mkdir -p "$TARGET"
cp index.js package.json LICENSE third-party-licenses.txt "$TARGET/"

INSTALLED="$(node -p "require('$TARGET/package.json').version")"

if [ "$INSTALLED" != "$VERSION" ]; then
  echo "error: installed version $INSTALLED does not match built $VERSION" >&2
  exit 1
fi

echo
echo "installed v$INSTALLED → $APP"
echo
echo "Now QUIT Tropy completely (Cmd+Q) and relaunch. Then check the log:"
echo "  tail -f ~/Library/Logs/$APP/*.log | grep -i autropy"
echo "The first Autropy line should read: [AUTROPY] v$INSTALLED loaded"

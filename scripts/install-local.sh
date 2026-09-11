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

# Backups must live OUTSIDE the plugins root. Tropy scans every subdirectory of
# it, so a backup left alongside the install is scanned as another plugin and
# shows up in Preferences > Plugins ("plugins scanned: 15" for 14 real ones).
BACKUPS="$HOME/Library/Application Support/$APP/autropy-install-backups"

if [ ! -d "$PLUGINS" ]; then
  echo "error: no plugins directory for '$APP' at:" >&2
  echo "  $PLUGINS" >&2
  exit 1
fi

# Sweep up backups written into the plugins root by earlier versions of this
# script, so the scan stops seeing them.
shopt -s nullglob
for stray in "$PLUGINS"/tropy-plugin-autropy.*backup*; do
  mkdir -p "$BACKUPS"
  mv "$stray" "$BACKUPS/$(basename "$stray")"
  echo "moved stray backup out of the plugins directory → $(basename "$stray")"
done
shopt -u nullglob

cd "$REPO"
npm run --silent build

VERSION="$(node -p "require('./package.json').version")"

if [ -e "$TARGET" ]; then
  mkdir -p "$BACKUPS"
  BACKUP="$BACKUPS/tropy-plugin-autropy.$(date +%Y%m%d-%H%M%S)"
  mv "$TARGET" "$BACKUP"
  echo "backed up previous install → autropy-install-backups/$(basename "$BACKUP")"
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

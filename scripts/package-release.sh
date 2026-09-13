#!/usr/bin/env bash
# Build the zip a Tropy user installs through Preferences > Plugins.
#
# Tropy expects the archive to contain ONE directory holding package.json and
# the built bundle. node_modules and the git history are excluded: the bundle is
# already rolled up, and shipping a repository inside a plugin is how a stale
# build ends up installed alongside a fresh one.
#
# The tests run first. A release artifact built from a red suite is worse than
# no artifact, because it looks finished.
set -euo pipefail

cd "$(dirname "$0")/.."

version=$(node -p "require('./package.json').version")
name="tropy-plugin-autropy"

npm run build
node --test "test/*.test.mjs" > /dev/null

stage=$(mktemp -d)
mkdir -p "${stage}/${name}" dist

cp index.js package.json README.md LICENSE "${stage}/${name}/"

out="$(pwd)/dist/${name}-v${version}.zip"
rm -f "$out"
( cd "$stage" && zip -qr "$out" "$name" )

echo "Built dist/${name}-v${version}.zip"
unzip -l "$out" | tail -8

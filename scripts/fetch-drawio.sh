#!/usr/bin/env bash
# Fetches the draw.io web app (Apache-2.0, https://github.com/jgraph/drawio)
# that Corestone serves under /drawio/ for diagrams in rich text: a pinned
# release, checked against its SHA-256. Without it, diagrams are off.
#
#   ./scripts/fetch-drawio.sh [target directory, default web/drawio]
set -euo pipefail
VERSION=32.6.10
SHA256=a57b06b3b6a876a351dacfe65d027d9509319cd030e9bacf6ae04a034d66a38f
DEST=${1:-web/drawio}

tmp=$(mktemp -d)
trap 'rm -rf "$tmp"' EXIT
curl -fsSL -o "$tmp/draw.war" "https://github.com/jgraph/drawio/releases/download/v$VERSION/draw.war"
echo "$SHA256  $tmp/draw.war" | sha256sum -c --quiet -
mkdir "$tmp/app"
unzip -q "$tmp/draw.war" -d "$tmp/app"
# the servlet parts are for a Java server; Corestone serves the files only
rm -rf "$tmp/app/WEB-INF" "$tmp/app/META-INF"
echo "$VERSION" > "$tmp/app/VERSION"
rm -rf "$DEST"
mkdir -p "$(dirname "$DEST")"
mv "$tmp/app" "$DEST"
echo "draw.io $VERSION in $DEST"

#!/bin/sh
# Packs extension/ into release/sitr-v<version>.zip (plus a .sha256).
# The zip holds one folder, so unzipping it gives something Chrome's
# "Load unpacked" can point straight at. Unit tests must pass first.
set -eu

cd "$(dirname "$0")/.."
version=$(node -p "require('./extension/manifest.json').version")
name="sitr-v$version"
stage=$(mktemp -d)
trap 'rm -rf "$stage"' EXIT

node --test test/unit.test.mjs >/dev/null

mkdir -p "$stage/$name" release
cp -R extension/. "$stage/$name/"
find "$stage" -name '.DS_Store' -delete

rm -f "release/$name.zip"
if command -v zip >/dev/null; then
  (cd "$stage" && zip -qrX "$OLDPWD/release/$name.zip" "$name")
else
  (cd "$stage" && python3 -m zipfile -c "$OLDPWD/release/$name.zip" "$name")
fi
if command -v sha256sum >/dev/null; then
  (cd release && sha256sum "$name.zip" > "$name.zip.sha256")
else
  (cd release && shasum -a 256 "$name.zip" > "$name.zip.sha256")
fi

echo "release/$name.zip"
cat "release/$name.zip.sha256"

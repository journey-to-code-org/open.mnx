#!/usr/bin/env sh
# Set the version in every package and crate that carries the project's version.
# Usage: scripts/bump-version.sh 3.1.0
set -e
v="$1"; [ -n "$v" ] || { echo "usage: $0 <version>" >&2; exit 1; }
for f in compiler/package.json create/package.json plugin/package.json runtime/package.json server/package.json editors/language-server/package.json editors/vscode/package.json; do
  sed -i -E "0,/\"version\": \"[0-9.]+\"/s//\"version\": \"$v\"/" "$f"
done
sed -i -E "0,/^version = \"[0-9.]+\"/s//version = \"$v\"/" Cargo.toml
for f in compiler/package-lock.json plugin/package-lock.json runtime/package-lock.json server/package-lock.json; do
  # the root package appears twice at the top of a lockfile (lines 3 and 9)
  sed -i -E "1,12s/\"version\": \"[0-9.]+\"/\"version\": \"$v\"/" "$f"
done
sed -i -E "/^name = \"mnx-compiler\"$/{n;s/^version = \"[0-9.]+\"/version = \"$v\"/}" Cargo.lock
echo "version $v"

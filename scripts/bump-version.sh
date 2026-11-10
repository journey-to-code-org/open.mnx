#!/usr/bin/env sh
# Set the version in every package and crate that carries the project's version.
# Usage: scripts/bump-version.sh 3.1.0
set -e
v="$1"; [ -n "$v" ] || { echo "usage: $0 <version>" >&2; exit 1; }
for f in compiler/package.json create/package.json plugin/package.json runtime/package.json server/package.json actions/package.json sync/package.json editors/language-server/package.json editors/vscode/package.json editors/devtools/manifest.json editors/devtools/package.json prettier-plugin/package.json; do
  sed -i -E "0,/\"version\": \"[0-9.]+\"/s//\"version\": \"$v\"/" "$f"
done
sed -i -E "0,/^version = \"[0-9.]+\"/s//version = \"$v\"/" Cargo.toml
for f in compiler/package-lock.json plugin/package-lock.json runtime/package-lock.json server/package-lock.json actions/package-lock.json sync/package-lock.json prettier-plugin/package-lock.json; do
  # the root package appears twice at the top of a lockfile (lines 3 and 9)
  sed -i -E "1,12s/\"version\": \"[0-9.]+\"/\"version\": \"$v\"/" "$f"
done
# sync installs the repository's packages as copies (its .npmrc), so its lockfile records their
# versions too, beside "resolved": "file:../…".
perl -0pi -e "s/\"version\": \"[0-9.]+\",(\s*\"resolved\": \"file:)/\"version\": \"$v\",\1/g" sync/package-lock.json
sed -i -E "/^name = \"zubra\"$/{n;s/^version = \"[0-9.]+\"/version = \"$v\"/}" Cargo.lock
# The packages that need the compiler, runtime or server ask for this release or later in its major.
range="^$(echo "$v" | sed -E 's/^([0-9]+\.[0-9]+)\..*/\1.0/')"
for f in plugin/package.json plugin/package-lock.json server/package.json server/package-lock.json actions/package.json actions/package-lock.json sync/package.json sync/package-lock.json; do
  sed -i -E "s#(\"@zubra/(compiler|runtime|server)\": \")\^[0-9.]+\"#\1$range\"#g" "$f"
done
echo "version $v"

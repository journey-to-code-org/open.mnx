#!/usr/bin/env bash
# Packs the built `zubra` CLI for one target into dist/zubra-<version>-<target>.tar.gz (.zip for
# Windows), with the licence and readme beside it, and prints the archive's path.
#
#   cargo build --release --locked --bin zubra --target <target>
#   scripts/package-binary.sh <target> [version]
#
# <version> defaults to the one in Cargo.toml. The binary is read from target/<target>/release,
# or target/release when <target> is "host" (ZUBRA_PROFILE=debug for a debug build). Used by .github/workflows/release.yml; runs anywhere
# with bash, tar (and zip or 7z for Windows).
set -euo pipefail

target="${1:?usage: package-binary.sh <target|host> [version]}"
root="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
version="${2:-$(sed -n 's/^version = "\(.*\)"/\1/p' "$root/Cargo.toml" | head -n 1)}"

exe=zubra
case "$target" in *windows*) exe=zubra.exe ;; esac
if [ "$target" = host ]; then
  built="$root/target/${ZUBRA_PROFILE:-release}/$exe"
  target="$(rustc -vV | sed -n 's/^host: //p')"
else
  built="$root/target/$target/release/$exe"
fi
[ -f "$built" ] || { echo "package-binary: $built is not built" >&2; exit 1; }

name="zubra-$version-$target"
stage="$(mktemp -d)"
trap 'rm -rf "$stage"' EXIT
mkdir -p "$stage/$name" "$root/dist"
cp "$built" "$stage/$name/$exe"
cp "$root/LICENSE" "$root/README.md" "$stage/$name/"

case "$target" in
  *windows*)
    archive="$root/dist/$name.zip"
    rm -f "$archive"
    if command -v 7z > /dev/null; then
      (cd "$stage" && 7z a -tzip -bso0 "$archive" "$name")
    else
      (cd "$stage" && zip -qr "$archive" "$name")
    fi
    ;;
  *)
    archive="$root/dist/$name.tar.gz"
    # Reproducible: sorted names, no owner, the same mtime for the same commit.
    (cd "$stage" && tar --sort=name --owner=0 --group=0 --numeric-owner -czf "$archive" "$name" 2> /dev/null \
      || tar -czf "$archive" "$name")
    ;;
esac
echo "$archive"

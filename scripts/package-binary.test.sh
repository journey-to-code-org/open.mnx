#!/usr/bin/env bash
# Checks scripts/package-binary.sh against a debug build of the CLI (cargo build --bin zubra).
set -euo pipefail
root="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
out="$(mktemp -d)"; trap 'rm -rf "$out" "$root/dist"' EXIT
rm -rf "$root/dist"
host="$(rustc -vV | sed -n 's/^host: //p')"

fail() { echo "FAIL: $*" >&2; exit 1; }

# The archive is named for the version and target, and holds the binary, licence and readme.
archive="$(ZUBRA_PROFILE=debug "$root/scripts/package-binary.sh" host 9.8.7)"
[ "$archive" = "$root/dist/zubra-9.8.7-$host.tar.gz" ] || fail "archive named $archive"
tar -xzf "$archive" -C "$out"
dir="$out/zubra-9.8.7-$host"
for file in zubra LICENSE README.md; do [ -f "$dir/$file" ] || fail "$file missing from the archive"; done
[ -x "$dir/zubra" ] || fail "the binary is not executable"

# The packed binary is the built one, and runs.
cmp "$dir/zubra" "$root/target/debug/zubra" || fail "the packed binary differs from the built one"
[ "$(printf '<hello-x></hello-x>\n' | "$dir/zubra" fmt --stdin)" = "<hello-x></hello-x>" ] || fail "the packed binary doesn't run"

# The version defaults to Cargo.toml's.
default="$(ZUBRA_PROFILE=debug "$root/scripts/package-binary.sh" host)"
cargo_version="$(sed -n 's/^version = "\(.*\)"/\1/p' "$root/Cargo.toml" | head -n 1)"
[ "$default" = "$root/dist/zubra-$cargo_version-$host.tar.gz" ] || fail "default version: $default"

# Packing something that wasn't built is an error, not an empty archive.
if message="$("$root/scripts/package-binary.sh" aarch64-unknown-linux-musl 1.0.0 2>&1)"; then fail "packed a target that wasn't built"; fi
case "$message" in *"is not built"*) ;; *) fail "unhelpful error: $message" ;; esac
[ ! -e "$root/dist/zubra-1.0.0-aarch64-unknown-linux-musl.tar.gz" ] || fail "left an archive behind"

# Windows archives are zips and name the .exe.
if command -v zip > /dev/null || command -v 7z > /dev/null; then
  mkdir -p "$root/target/x86_64-pc-windows-msvc/release"
  cp "$root/target/debug/zubra" "$root/target/x86_64-pc-windows-msvc/release/zubra.exe"
  zipped="$("$root/scripts/package-binary.sh" x86_64-pc-windows-msvc 9.8.7)"
  rm -rf "$root/target/x86_64-pc-windows-msvc"
  [ "$zipped" = "$root/dist/zubra-9.8.7-x86_64-pc-windows-msvc.zip" ] || fail "windows archive named $zipped"
  python3 - "$zipped" <<'PY' || fail "the windows archive lacks zubra.exe"
import sys, zipfile
names = zipfile.ZipFile(sys.argv[1]).namelist()
assert "zubra-9.8.7-x86_64-pc-windows-msvc/zubra.exe" in names, names
PY
fi
echo "package-binary: ok"

#!/usr/bin/env python3
"""Builds a platform wheel: the `zubra` package with the compiler from a release archive inside it.

    build_wheel.py zubra-5.4.0-x86_64-unknown-linux-musl.tar.gz [--out dist]
    build_wheel.py --binary target/x86_64-unknown-linux-musl/release/zubra --target x86_64-unknown-linux-musl

The archive is one of the release's (scripts/package-binary.sh in the repository root); its name
carries the target. The wheel is written by hand (a wheel is a zip with three metadata files), so
this needs nothing but the standard library.
"""
from __future__ import annotations

import argparse
import base64
import hashlib
import re
import stat
import sys
import tarfile
import tomllib
import zipfile
from pathlib import Path

ROOT = Path(__file__).resolve().parent.parent

# The tag says which machines the binary runs on.
#
# Linux wheels are built from the musl archives. Those binaries are static: they need no libc from
# the machine, so one wheel serves every glibc distribution back to manylinux2014 (glibc 2.17) and
# Alpine as well, and its tag says all three. The glibc archives are built on Ubuntu 22.04
# (glibc 2.35); a wheel from one would have to be tagged manylinux_2_35, which pip refuses on
# RHEL 9, Amazon Linux 2023 (both 2.34) and Debian 11 (2.31).
TAGS = {
    "x86_64-unknown-linux-musl": "manylinux_2_17_x86_64.manylinux2014_x86_64.musllinux_1_1_x86_64",
    "aarch64-unknown-linux-musl": "manylinux_2_17_aarch64.manylinux2014_aarch64.musllinux_1_1_aarch64",
    "x86_64-apple-darwin": "macosx_10_12_x86_64",
    "aarch64-apple-darwin": "macosx_11_0_arm64",
    "x86_64-pc-windows-msvc": "win_amd64",
}
# Release targets that get no wheel of their own, and the target whose wheel covers them.
COVERED_BY = {
    "x86_64-unknown-linux-gnu": "x86_64-unknown-linux-musl",
    "aarch64-unknown-linux-gnu": "aarch64-unknown-linux-musl",
}


def target_of(archive_name: str) -> str:
    match = re.match(r"zubra-[^-]+-(.+?)(\.tar\.gz|\.zip)$", archive_name)
    if match and match.group(1) in COVERED_BY:
        raise SystemExit(
            f"build_wheel: no wheel is built from {archive_name!r}: build the Linux wheel from the "
            f"{COVERED_BY[match.group(1)]} archive, whose static binary runs on glibc systems too "
            "(and on older ones than this build does)"
        )
    if not match or match.group(1) not in TAGS:
        raise SystemExit(f"build_wheel: can't tell the target from {archive_name!r}")
    return match.group(1)


def binary_from(archive: Path) -> bytes:
    exe = "zubra.exe" if archive.name.endswith(".zip") else "zubra"
    if archive.name.endswith(".zip"):
        with zipfile.ZipFile(archive) as bundle:
            name = next(n for n in bundle.namelist() if n.endswith("/" + exe))
            return bundle.read(name)
    with tarfile.open(archive) as bundle:
        member = next(m for m in bundle.getmembers() if m.name.endswith("/" + exe))
        return bundle.extractfile(member).read()


def metadata() -> tuple[str, str]:
    project = tomllib.loads((ROOT / "pyproject.toml").read_text())["project"]
    text = [
        "Metadata-Version: 2.1",
        f"Name: {project['name']}",
        f"Version: {project['version']}",
        f"Summary: {project['description']}",
        f"License: {project['license']['text']}",
        f"Requires-Python: {project['requires-python']}",
        f"Project-URL: Repository, {project['urls']['Repository']}",
    ]
    for classifier in project.get("classifiers", []):
        text.append(f"Classifier: {classifier}")
    for extra, requirements in project.get("optional-dependencies", {}).items():
        text.append(f"Provides-Extra: {extra}")
        for requirement in requirements:
            text.append(f'Requires-Dist: {requirement} ; extra == "{extra}"')
    text += ["Description-Content-Type: text/markdown", "", (ROOT / "README.md").read_text()]
    return project["version"], "\n".join(text)


def record_line(path: str, data: bytes) -> str:
    digest = base64.urlsafe_b64encode(hashlib.sha256(data).digest()).rstrip(b"=").decode()
    return f"{path},sha256={digest},{len(data)}"


def build(binary: bytes, target: str, out: Path) -> Path:
    version, meta = metadata()
    tag = TAGS[target]
    wheel_name = f"zubra-{version}-py3-none-{tag}.whl"
    dist_info = f"zubra-{version}.dist-info"
    exe = "zubra.exe" if "windows" in target else "zubra"
    files: list[tuple[str, bytes, int]] = []
    for path in sorted((ROOT / "src" / "zubra").rglob("*")):
        if path.is_file() and "__pycache__" not in path.parts and path.parent.name != "bin":
            files.append((path.relative_to(ROOT / "src").as_posix(), path.read_bytes(), 0o644))
    files.append((f"zubra/bin/{exe}", binary, 0o755))
    files.append((f"{dist_info}/METADATA", meta.encode(), 0o644))
    # A compressed tag set (`a.b.c`) in the file name is one `Tag:` line each in WHEEL.
    tags = "".join(f"Tag: py3-none-{platform}\n" for platform in tag.split("."))
    files.append((f"{dist_info}/WHEEL", (
        f"Wheel-Version: 1.0\nGenerator: zubra build_wheel\nRoot-Is-Purelib: false\n{tags}"
    ).encode(), 0o644))
    record = "\n".join(record_line(name, data) for name, data, _ in files)
    record += f"\n{dist_info}/RECORD,,\n"
    files.append((f"{dist_info}/RECORD", record.encode(), 0o644))
    out.mkdir(parents=True, exist_ok=True)
    wheel = out / wheel_name
    with zipfile.ZipFile(wheel, "w", zipfile.ZIP_DEFLATED) as bundle:
        for name, data, mode in files:
            info = zipfile.ZipInfo(name, date_time=(2020, 1, 1, 0, 0, 0))
            info.external_attr = (stat.S_IFREG | mode) << 16
            info.compress_type = zipfile.ZIP_DEFLATED
            bundle.writestr(info, data)
    return wheel


def main() -> None:
    parser = argparse.ArgumentParser(description=__doc__, formatter_class=argparse.RawDescriptionHelpFormatter)
    parser.add_argument("archive", nargs="?", type=Path, help="a release archive (zubra-<version>-<target>.tar.gz|.zip)")
    parser.add_argument("--binary", type=Path, help="a built binary, instead of an archive (with --target)")
    parser.add_argument("--target", choices=sorted(TAGS))
    parser.add_argument("--out", type=Path, default=ROOT / "dist")
    args = parser.parse_args()
    if args.archive:
        target, binary = target_of(args.archive.name), binary_from(args.archive)
    elif args.binary and args.target:
        target, binary = args.target, args.binary.read_bytes()
    else:
        parser.error("give an archive, or --binary with --target")
    print(build(binary, target, args.out))


if __name__ == "__main__":
    sys.exit(main())

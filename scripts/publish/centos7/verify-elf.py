#!/usr/bin/env python3
"""Reject CentOS 7 ZIP members that need glibc newer than 2.17."""

import pathlib
import re
import subprocess
import sys

GLIBC_VERSION = re.compile(r"\bGLIBC_(\d+)\.(\d+)(?:\.\d+)?\b")


def main(root: pathlib.Path) -> int:
    if not root.is_dir():
        raise ValueError(f"Missing release staging directory: {root}")

    checked = 0
    for path in root.rglob("*"):
        if not path.is_file() or path.is_symlink():
            continue
        with path.open("rb") as binary:
            if binary.read(4) != b"\x7fELF":
                continue
        result = subprocess.run(
            ["readelf", "--version-info", str(path)],
            check=True,
            text=True,
            capture_output=True,
        )
        checked += 1
        for major, minor in GLIBC_VERSION.findall(result.stdout):
            if (int(major), int(minor)) > (2, 17):
                print(f"CentOS 7 incompatible GLIBC_{major}.{minor}: {path}", file=sys.stderr)
                return 1
    if checked == 0:
        raise ValueError("Release staging directory contains no ELF binaries")
    print(f"Verified {checked} ELF files against glibc 2.17")
    return 0


if __name__ == "__main__":
    raise SystemExit(main(pathlib.Path(sys.argv[1])))

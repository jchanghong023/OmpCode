#!/usr/bin/env python3
"""Static filesystem ELF/loader audit. Never executes packaged programs."""
import hashlib
import json
import os
from pathlib import Path
import re
import subprocess
import sys

POLICY = json.loads(Path(__file__).with_name("runtime-assets.json").read_text())
BASELINE = set(POLICY["baselineSonames"])


def command(*args):
    result = subprocess.run(args, stdout=subprocess.PIPE, stderr=subprocess.PIPE,
                            text=True, env={**os.environ, "LC_ALL": "C"})
    if result.returncode:
        raise ValueError("{}: {}".format(" ".join(map(str, args)), result.stderr.strip()))
    return result.stdout


def inside(path, root):
    return path == root or root in path.parents


def digest(path):
    value = hashlib.sha256()
    with path.open("rb") as stream:
        for block in iter(lambda: stream.read(1024 * 1024), b""):
            value.update(block)
    return value.hexdigest()


def inspect(path):
    header = command("readelf", "-hW", str(path))
    if not re.search(r"Class:\s+ELF64", header) or not re.search(r"Machine:\s+Advanced Micro Devices X86-64", header):
        raise ValueError("not x86-64 ELF64: {}".format(path))
    dynamic = command("readelf", "-dW", str(path))
    program = command("readelf", "-lW", str(path))
    versions = command("readelf", "-VW", str(path))
    needed = re.findall(r"\(NEEDED\).*?\[(.*?)\]", dynamic)
    sonames = re.findall(r"\(SONAME\).*?\[(.*?)\]", dynamic)
    paths = re.findall(r"\((?:RPATH|RUNPATH)\).*?\[(.*?)\]", dynamic)
    interpreter = re.findall(r"Requesting program interpreter:\s*([^\]]+)", program)
    if interpreter and interpreter != ["/lib64/ld-linux-x86-64.so.2"]:
        raise ValueError("unexpected interpreter: {} {}".format(path, interpreter))
    # Only version NEEDS are requirements; version definitions are provider capabilities.
    needs = versions.split("Version needs section", 1)[1] if "Version needs section" in versions else ""
    requirements = {}
    provider = None
    for line in needs.splitlines():
        match = re.search(r"File:\s*(\S+)", line)
        if match:
            provider = match.group(1)
            requirements.setdefault(provider, [])
        match = re.search(r"Name:\s*(\S+)", line)
        if match and provider:
            requirements[provider].append(match.group(1))
    for names in requirements.values():
        for name in names:
            if name.startswith("GLIBC_"):
                suffix = name[6:]
                if not re.fullmatch(r"\d+(?:\.\d+)+", suffix):
                    raise ValueError("unsupported/private GLIBC requirement {}: {}".format(name, path))
                version = tuple(map(int, suffix.split(".")))
                if version + (0,) * max(0, 2 - len(version)) > (2, 17) + (0,) * max(0, len(version) - 2):
                    raise ValueError("{} requires {} > GLIBC_2.17".format(path, name))
    definitions = versions.split("Version definition section", 1)
    provided = set()
    if len(definitions) == 2:
        provided = set(re.findall(r"Name:\s*(\S+)", definitions[1].split("Version needs section", 1)[0]))
    return {"needed": needed, "soname": sonames[0] if sonames else None,
            "rpaths": paths, "interpreter": interpreter, "requirements": requirements,
            "provided": sorted(provided), "sha256": digest(path)}


def audit(root):
    root = root.resolve(strict=True)
    records = {}
    for directory, dirs, files in os.walk(str(root), followlinks=False):
        for name in dirs + files:
            path = Path(directory) / name
            if path.is_symlink():
                target = path.resolve(strict=True)
                if os.path.isabs(os.readlink(str(path))) or not inside(target, root):
                    raise ValueError("absolute/escaping symlink: {}".format(path))
        for name in files:
            path = Path(directory) / name
            if path.is_symlink():
                continue
            with path.open("rb") as stream:
                magic = stream.read(4)
            if magic == b"\x7fELF":
                records[path] = inspect(path)
    if not records:
        raise ValueError("no ELF files found: {}".format(root))
    for path, record in records.items():
        if path.name in BASELINE or record["soname"] in BASELINE or re.fullmatch(r"(?:libc|libm|libpthread|libdl|librt|libresolv|libutil|libanl)-[\d.]+\.so", path.name) or path.name.startswith("ld-2."):
            raise ValueError("bundled glibc/loader forbidden: {}".format(path))
        search = [root / "lib"]
        for value in record["rpaths"]:
            for entry in value.split(":"):
                if not entry or not re.match(r"^\$(?:ORIGIN|\{ORIGIN\})(?:/|$)", entry):
                    raise ValueError("non-relocatable RPATH/RUNPATH {}: {}".format(entry, path))
                candidate = Path(entry.replace("${ORIGIN}", str(path.parent)).replace("$ORIGIN", str(path.parent))).resolve()
                if not inside(candidate, root):
                    raise ValueError("escaping RPATH {}: {}".format(entry, path))
                search.append(candidate)
        resolved = {}
        for soname in record["needed"]:
            if "/" in soname:
                raise ValueError("path-valued DT_NEEDED {}: {}".format(soname, path))
            if soname in BASELINE:
                resolved[soname] = "CentOS 7 glibc baseline"
                continue
            provider = next((directory / soname for directory in search if (directory / soname).is_file()), None)
            if provider is None:
                raise ValueError("missing DT_NEEDED {} required by {}".format(soname, path))
            provider = provider.resolve(strict=True)
            if not inside(provider, root) or provider not in records:
                raise ValueError("invalid ELF provider {}: {}".format(soname, provider))
            missing = set(record["requirements"].get(soname, [])) - set(records[provider]["provided"])
            if missing:
                raise ValueError("{} lacks {} required by {}".format(provider, sorted(missing), path))
            resolved[soname] = str(provider.relative_to(root))
        record["resolved"] = resolved
    return {"schemaVersion": 1, "target": POLICY["target"],
            "limitations": POLICY["evidenceLimitations"],
            "files": {str(path.relative_to(root)): record for path, record in records.items()}}


if __name__ == "__main__":
    try:
        if len(sys.argv) != 2:
            raise ValueError("usage: verify-elf.py <root>")
        print(json.dumps(audit(Path(sys.argv[1])), indent=2, sort_keys=True))
    except (OSError, ValueError, KeyError, subprocess.SubprocessError) as error:
        print("ELF integrity failure: {}".format(error), file=sys.stderr)
        sys.exit(1)

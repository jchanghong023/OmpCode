#!/bin/bash
set -euo pipefail

if [[ $# -ne 5 ]]; then
  echo "Usage: $0 <linux-unpacked> <ubuntu-rootfs> <static-proot> <version> <output-dir>" >&2
  exit 2
fi
app=$(realpath "$1")
runtime=$(realpath "$2")
proot=$(realpath "$3")
version=$4
output=$(realpath -m "$5")
repo=$(realpath "$(dirname "$0")/../../..")
[[ $version =~ ^[0-9]+\.[0-9]+\.[0-9]+$ ]] || { echo 'Invalid ZIP version.' >&2; exit 2; }
[[ -x "$app/zcode" && -x "$app/resources/glm/omp/omp" && -f "$app/resources/app.asar" ]] || {
  echo 'Unpacked desktop is incomplete or embedded omp is not executable.' >&2
  exit 1
}
[[ -f "$runtime/lib64/ld-linux-x86-64.so.2" && -x "$proot" ]] || {
  echo 'Isolated runtime or static PRoot is missing.' >&2
  exit 1
}
command -v zip >/dev/null
mkdir -p "$output"
work=$(mktemp -d)
trap 'rm -rf "$work"' EXIT
name="OmpCode-$version-centos7-x64"
stage="$work/$name"
mkdir -p "$stage/app" "$stage/runtime" "$stage/bin"
cp -a "$app/." "$stage/app/"
cp -a "$runtime/." "$stage/runtime/"
install -m 755 "$proot" "$stage/proot"
install -m 755 "$repo/scripts/publish/centos7/launch.sh" "$stage/bin/ompcode-centos7"
install -m 644 "$repo/LICENSE" "$repo/NOTICE.md" "$stage/"
(cd "$work" && zip -qry "$output/$name.zip" "$name")
[[ -s "$output/$name.zip" ]] || { echo 'ZIP build produced no artifact.' >&2; exit 1; }

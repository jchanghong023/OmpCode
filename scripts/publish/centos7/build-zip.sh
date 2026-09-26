#!/bin/bash
set -euo pipefail

if [[ $# -ne 4 ]]; then
  echo "Usage: $0 <linux-unpacked> <centos7-native-assets> <version> <output-dir>" >&2
  exit 2
fi
app=$(realpath "$1")
native=$(realpath "$2")
version=$3
output=$(realpath -m "$4")
repo=$(realpath "$(dirname "$0")/../../..")
[[ $version =~ ^[0-9]+\.[0-9]+\.[0-9]+$ ]] || { echo 'Invalid ZIP version.' >&2; exit 2; }
[[ -x "$app/zcode" && -x "$app/resources/glm/omp/omp" && -f "$app/resources/app.asar" ]] || {
  echo 'Unpacked desktop is incomplete or embedded omp is not executable.' >&2
  exit 1
}
[[ -f "$native/app/node_modules/better-sqlite3/build/Release/better_sqlite3.node" &&
  -f "$native/app/node_modules/node-pty/prebuilds/linux-x64/pty.node" &&
  -f "$native/app/node_modules/cpu-features/build/Release/cpufeatures.node" &&
  -x "$native/app/resources/tools/bfs/bfs" && -x "$native/app/resources/tools/ugrep/ugrep" ]] || {
  echo 'Required CentOS 7 native addons or search tools are missing.' >&2
  exit 1
}
command -v node >/dev/null
command -v python3 >/dev/null
command -v readelf >/dev/null
command -v zip >/dev/null
mkdir -p "$output"
work=$(mktemp -d)
output_stage=$(mktemp -d "$output/.centos7-zip.XXXXXX")
trap 'rm -rf "$work" "$output_stage"' EXIT
name="OmpCode-$version-centos7-x64"
stage="$work/$name"
mkdir -p "$stage/app/resources" "$stage/bin"
cp -a "$app/." "$stage/app/"
cp -a "$native/app/resources/." "$stage/app/resources/"
if [[ -d "$native/lib" ]]; then
  mkdir -p "$stage/lib"
  cp -a "$native/lib/." "$stage/lib/"
fi
node "$repo/scripts/publish/centos7/merge-app-asar.mjs" \
  "$native/app/node_modules" "$stage/app/resources/app.asar"
install -m 755 "$repo/scripts/publish/centos7/launch.sh" "$stage/bin/ompcode-centos7"
install -m 644 "$repo/LICENSE" "$repo/NOTICE.md" "$stage/"
python3 "$repo/scripts/publish/centos7/verify-elf.py" "$stage"
node "$repo/scripts/publish/centos7/verify-ssh.mjs" "$stage"
(cd "$work" && zip -qry "$output_stage/$name.zip" "$name")
[[ -s "$output_stage/$name.zip" ]] || { echo 'ZIP build produced no artifact.' >&2; exit 1; }
mv -f "$output_stage/$name.zip" "$output/$name.zip"

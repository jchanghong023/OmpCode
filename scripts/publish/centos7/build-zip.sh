#!/usr/bin/env bash
set -euo pipefail

if [[ $# -ne 4 ]]; then
  echo "Usage: $0 <linux-unpacked> <centos7-native> <version> <output>" >&2
  exit 2
fi
app=$(realpath "$1")
native=$(realpath "$2")
version=$3
output=$(realpath -m "$4")
repo=$(realpath "$(dirname "$0")/../../..")
[[ $version =~ ^[0-9]+\.[0-9]+\.[0-9]+(-[0-9A-Za-z.-]+)?$ ]] || { echo 'Invalid ZIP version.' >&2; exit 2; }
for tool in node zip sha256sum; do command -v "$tool" >/dev/null; done
[[ -x "$app/ompcode" && -s "$app/resources/app.asar" ]] || { echo 'Unpacked desktop is incomplete.' >&2; exit 1; }
for file in better-sqlite3/build/Release/better_sqlite3.node node-pty/prebuilds/linux-x64/pty.node cpu-features/build/Release/cpufeatures.node; do
  [[ -s "$native/app/node_modules/$file" ]] || { echo "Missing native addon: $file" >&2; exit 1; }
done
for tool in bfs/bfs ugrep/ugrep; do
  [[ -x "$native/app/resources/tools/$tool" ]] || { echo "Missing native search tool: $tool" >&2; exit 1; }
done
for directory in lib fonts; do
  [[ -d "$native/$directory" ]] || { echo "Missing runtime stage: $directory" >&2; exit 1; }
done
mkdir -p "$output"
work=$(mktemp -d)
output_stage=$(mktemp -d "$output/.centos7-zip.XXXXXX")
trap 'rm -rf "$work" "$output_stage"' EXIT
name="OmpCode-$version-centos7-x64"
stage="$work/$name"
mkdir -p "$stage/app/resources" "$stage/bin" "$stage/licenses"
cp -a "$app/." "$stage/app/"
# Native plugin stages are complete runtime module replacements, not partial host overlays.
for plugin in node-repl-host browser-use-plugin zcode-cua-plugin; do
  modules="app/resources/glm/packages/$plugin/node_modules"
  if [[ -d "$native/$modules/koffi" ]]; then
    rm -rf "$stage/$modules/koffi"
  fi
  if [[ -d "$native/$modules/sharp" ]]; then
    rm -rf "$stage/$modules/sharp" \
      "$stage/$modules/@img/sharp-linux-x64" \
      "$stage/$modules/@img/sharp-libvips-linux-x64" \
      "$stage/$modules/@img/colour"
  fi
done
cp -a "$native/app/resources/." "$stage/app/resources/"
for directory in lib fonts; do cp -a "$native/$directory" "$stage/$directory"; done
install -m 644 "$native/licenses/runtime-assets-manifest.json" "$stage/licenses/runtime-assets-manifest.json"
install -m 644 "$native/native-build-manifest.json" "$stage/licenses/native-build-manifest.json"
install -m 644 "$native/plugin-native-build-manifest.json" "$stage/licenses/plugin-native-build-manifest.json"
node "$repo/scripts/publish/centos7/merge-app-asar.mjs" \
  "$native/app/node_modules" "$stage/app/resources/app.asar"
install -m 755 "$repo/scripts/publish/centos7/launch.sh" "$stage/bin/ompcode-centos7"
# -y stores relative symlinks instead of silently dereferencing SONAME chains.
(cd "$work" && zip -qry "$output_stage/$name.zip" "$name")
[[ -s "$output_stage/$name.zip" ]] || { echo 'ZIP build produced no artifact.' >&2; exit 1; }
# Generate the checksum sidecar from the final archive bytes.
(cd "$output_stage" && sha256sum "$name.zip" > "$name.zip.sha256")
mv -f "$output_stage/$name.zip" "$output/$name.zip"
mv -f "$output_stage/$name.zip.sha256" "$output/$name.zip.sha256"
printf '%s\n' "$output/$name.zip" "$output/$name.zip.sha256"

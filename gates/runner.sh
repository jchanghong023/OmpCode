#!/usr/bin/env bash
set -euo pipefail

mode="$1"
stage="$2"
# 原生 TestRunner 只给出整段墙钟；保留最小边界，区分 shell/runfiles 与 Node 子进程。
printf '[gate] shell-start stage=%s epoch=%s\n' "$stage" "${EPOCHREALTIME:-unavailable}"

# Build actions run in the execroot and consume declared srcs, not test runfiles.
# run_binary invokes the official sh_binary native launcher on Windows.
if [[ "$mode" == build ]]; then
  exec "$JCH_GATES_NODE" scripts/test-gates-action.mjs --stage "$stage" --output "$3"
fi

# --- begin runfiles.bash initialization v3 ---
# Copy-pasted from the Bazel Bash runfiles library v3.
set -uo pipefail; set +e; f=bazel_tools/tools/bash/runfiles/runfiles.bash
# shellcheck disable=SC1090
source "${RUNFILES_DIR:-/dev/null}/$f" 2>/dev/null || \
  source "$(grep -sm1 "^$f " "${RUNFILES_MANIFEST_FILE:-/dev/null}" | cut -f2- -d' ')" 2>/dev/null || \
  source "$0.runfiles/$f" 2>/dev/null || \
  source "$(grep -sm1 "^$f " "$0.runfiles_manifest" | cut -f2- -d' ')" 2>/dev/null || \
  source "$(grep -sm1 "^$f " "$0.exe.runfiles_manifest" | cut -f2- -d' ')" 2>/dev/null || \
  { echo>&2 "ERROR: cannot find $f"; exit 1; }; f=; set -e
# --- end runfiles.bash initialization v3 ---

# 入口已是 canonical _main 路径，直接使用官方已规范化查找，避免重复仓库映射的外部进程。
case "$mode" in
  preparation)
    executor="$(runfiles_rlocation_checked "_main/scripts/test-gates-action.mjs")"
    printf '[gate] shell-ready stage=%s epoch=%s\n' "$stage" "${EPOCHREALTIME:-unavailable}"
    exec "$JCH_GATES_NODE" "$executor" --stage "$stage" --output "$TEST_TMPDIR/gate-artifact"
    ;;
  test)
    executor="$(runfiles_rlocation_checked "_main/scripts/test-gates-bazel-exec.mjs")"
    printf '[gate] shell-ready stage=%s epoch=%s\n' "$stage" "${EPOCHREALTIME:-unavailable}"
    exec "$JCH_GATES_NODE" "$executor" --stage "$stage"
    ;;
  *)
    echo >&2 "Unknown gate runner mode: $mode"
    exit 1
    ;;
esac

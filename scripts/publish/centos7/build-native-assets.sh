#!/usr/bin/env bash
set -euo pipefail

SCRIPT_DIR="$(cd -- "$(dirname -- "${BASH_SOURCE[0]}")" && pwd)"
if [[ "$#" -gt 1 ]]; then
  printf 'Usage: %s [repository-root]\n' "$0" >&2
  exit 2
fi
REPO_ROOT="${1:-$(cd -- "$SCRIPT_DIR/../../.." && pwd)}"

if [[ -f /opt/rh/devtoolset-11/enable ]]; then
  # devtoolset 的 enable 脚本不保证在 nounset 下可 source；只在加载工具链时临时关闭。
  set +u
  # shellcheck disable=SC1091
  source /opt/rh/devtoolset-11/enable
  set -u
fi

export CC="${CC:-gcc}"
export CXX="${CXX:-g++}"
export AR="${AR:-ar}"
export RANLIB="${RANLIB:-ranlib}"
export CFLAGS="${CFLAGS:+$CFLAGS }-O2 -fPIC"
export CXXFLAGS="${CXXFLAGS:+$CXXFLAGS }-O2 -fPIC -static-libgcc -static-libstdc++"
export LDFLAGS="${LDFLAGS:+$LDFLAGS }-static-libgcc -static-libstdc++"
# 这里只使用构建器 Node20；暂存树只收集目标 addon/搜索/库/字体，不携带该宿主 runtime。
exec node "$SCRIPT_DIR/build-native-assets.mjs" "$REPO_ROOT"

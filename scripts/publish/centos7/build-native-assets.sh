#!/usr/bin/env bash
set -euo pipefail

SCRIPT_DIR="$(cd -- "$(dirname -- "${BASH_SOURCE[0]}")" && pwd)"
REPO_ROOT="$(cd -- "$SCRIPT_DIR/../../.." && pwd)"

if [[ -f /opt/rh/devtoolset-11/enable ]]; then
  # shellcheck disable=SC1091
  source /opt/rh/devtoolset-11/enable
fi

export CC="${CC:-gcc}"
export CXX="${CXX:-g++}"
export AR="${AR:-ar}"
export RANLIB="${RANLIB:-ranlib}"
export CFLAGS="${CFLAGS:+$CFLAGS }-O2 -fPIC"
export CXXFLAGS="${CXXFLAGS:+$CXXFLAGS }-O2 -fPIC -static-libgcc -static-libstdc++"
export LDFLAGS="${LDFLAGS:+$LDFLAGS }-static-libgcc -static-libstdc++"

exec node "$SCRIPT_DIR/build-native-assets.mjs" "$REPO_ROOT" "$@"

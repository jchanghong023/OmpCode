#!/bin/bash
set -euo pipefail

package_root=$(dirname "$(dirname "$(readlink -f "$0")")")
app="$package_root/app"
[[ -x "$app/zcode" && -x "$app/resources/glm/omp/omp" && -f "$app/resources/app.asar" ]] || {
  echo 'OmpCode CentOS 7 package is incomplete.' >&2
  exit 1
}

# 修复依据：主机的旧版 libstdc++ 不提供 Electron 28 与本地编译插件所需的 C++ 符号。
# 仅优先使用随包发布的 C++ 库，不替换宿主的 glibc。
if [[ -d "$package_root/lib" ]]; then
  export LD_LIBRARY_PATH="$package_root/lib${LD_LIBRARY_PATH:+:$LD_LIBRARY_PATH}"
fi
export XDG_CONFIG_HOME="$HOME/.config/ompcode-centos7"
export XDG_DATA_HOME="$HOME/.local/share/ompcode-centos7"
exec "$app/zcode" --no-sandbox "$@"

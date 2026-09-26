#!/bin/bash
set -euo pipefail

package_root=/opt/ompcode-centos7
runtime="$package_root/runtime"
app="$package_root/app"
[[ -x "$package_root/proot" && -x "$app/zcode" && -x "$app/resources/glm/omp/omp" && -f "$runtime/lib64/ld-linux-x86-64.so.2" ]] || {
  echo 'OmpCode CentOS 7 runtime is incomplete.' >&2
  exit 1
}

# 修复依据：桌面启动器的 cwd 可能是 /；将其 bind 到 guest 根会覆盖隔离的 glibc。
is_guest_system_path() {
  case "$1" in
    / | /usr | /usr/* | /bin | /bin/* | /sbin | /sbin/* | /lib | /lib/* | /lib64 | /lib64/* | /etc | /etc/* | /dev | /dev/* | /proc | /proc/* | /sys | /sys/* | /run | /run/* | /var | /var/* | /opt | /opt/* | /boot | /boot/*) return 0 ;;
  esac
  return 1
}

workdir=$(pwd -P)
bind=( -b "$app:/opt/ompcode" )
if is_guest_system_path "$workdir"; then
  workdir=$HOME
else
  bind+=( -b "$workdir:$workdir" )
fi
# Additional workspace roots outside HOME can be exposed explicitly, without exposing host libraries.
if [[ -n ${OMPCODE_CENTOS7_BIND:-} ]]; then
  [[ -d $OMPCODE_CENTOS7_BIND && $OMPCODE_CENTOS7_BIND == /* ]] || {
    echo 'OMPCODE_CENTOS7_BIND must be an absolute existing directory.' >&2
    exit 1
  }
  bind_path=$(realpath "$OMPCODE_CENTOS7_BIND")
  if is_guest_system_path "$bind_path"; then
    echo 'OMPCODE_CENTOS7_BIND cannot replace guest system directories.' >&2
    exit 1
  fi
  bind+=( -b "$bind_path:$bind_path" )
fi

# 修复依据：guest 中的 /opt/ompcode/zcode 在宿主不可执行，不能让 guest 的注册覆盖宿主深链入口。
if command -v xdg-mime >/dev/null 2>&1; then
  xdg-mime default ompcode-centos7.desktop x-scheme-handler/zcode || true
fi

exec "$package_root/proot" -R "$runtime" "${bind[@]}" -w "$workdir" \
  /usr/bin/env PATH=/usr/local/bin:/usr/bin:/bin LANG=C.UTF-8 \
    XDG_CONFIG_HOME="$HOME/.config/ompcode-centos7" \
    XDG_DATA_HOME="$HOME/.local/share/ompcode-centos7" \
  /opt/ompcode/zcode --no-sandbox "$@"

#!/bin/bash
set -euo pipefail

for arg in "$@"; do
  case "$arg" in
    --help|-h)
      cat <<'HELP'
用法：bin/ompcode-centos7 [选项] [桌面程序参数...]

  --profile <名称>   选择内嵌 omp 的配置（也支持 --profile=名称）
  -h, --help         显示此帮助并退出

环境变量：OMP_CONFIG_ROOT 指定 omp 数据根，应用使用该路径加 _ompcode 后缀；
OMP_OFFLINE=1 启用离线锁定。
环境变量原样传给内嵌 omp。未启用离线锁定时桌面为全功能，与 Windows
基准一致。其他参数会传递给桌面程序。
HELP
      exit 0
      ;;
  esac
done

package_root=$(dirname "$(dirname "$(readlink -f "$0")")")
app="$package_root/app"
# OMP 环境变量原样继承；启动器只派生桌面的离线门控状态。
[[ -x "$app/zcode" && -x "$app/resources/glm/omp/omp" && -f "$app/resources/app.asar" ]] || {
  echo 'OmpCode CentOS 7 package is incomplete.' >&2
  exit 1
}

# 修复依据：主机的旧版 libstdc++ 不提供 Electron 28 与本地编译插件所需的 C++ 符号。
# 仅优先使用随包发布的 C++ 库，不替换宿主的 glibc。
if [[ -d "$package_root/lib" ]]; then
  export LD_LIBRARY_PATH="$package_root/lib${LD_LIBRARY_PATH:+:$LD_LIBRARY_PATH}"
fi
desktop_args=()
profile_override=
profile_requested=0
while (($#)); do
  case "$1" in
    --profile)
      if (($# < 2)); then
        echo 'OmpCode: --profile requires a name.' >&2
        exit 2
      fi
      profile_override=$2
      profile_requested=1
      shift 2
      ;;
    --profile=*)
      profile_override=${1#--profile=}
      profile_requested=1
      shift
      ;;
    *)
      desktop_args+=("$1")
      shift
      ;;
  esac
done

if ((profile_requested)); then
  if [[ ! "$profile_override" =~ ^[a-z0-9][a-z0-9._-]{0,63}$ ||
        "$profile_override" == *. ||
        "$profile_override" =~ ^(con|prn|aux|nul|com[0-9]|lpt[0-9])(\..*)?$ ]]; then
    echo 'OmpCode: invalid --profile name.' >&2
    exit 2
  fi
  export OMPCODE_CENTOS7_PROFILE="$profile_override"
elif [[ ${OMPCODE_CENTOS7_PROFILE+x} ]]; then
  unset OMPCODE_CENTOS7_PROFILE
fi

# 修复依据：OMP 已移除 --offline；环境值直接继承，桌面门控按相同真值规则派生。
offline_value=${OMP_OFFLINE:-}
offline_value="${offline_value#"${offline_value%%[![:space:]]*}"}"
offline_value="${offline_value%"${offline_value##*[![:space:]]}"}"
case "${offline_value,,}" in
  1|true|yes|on)
    export OMPCODE_CENTOS7_LOCAL_ONLY=1
    unset ZCODE_ARMS_RUM_ENDPOINT ZCODE_TELEMETRY_REPORT_ENDPOINT
    ;;
  *)
    unset OMPCODE_CENTOS7_LOCAL_ONLY
    ;;
esac

configure_ibus_session() {
  [[ -n ${DISPLAY:-} ]] || return 0
  [[ ${GTK_IM_MODULE:-ibus} == ibus && ${XMODIFIERS:-@im=ibus} == @im=ibus ]] || return 0
  local tool pid entry daemon_display daemon_bus owner selected_bus= ambiguous=0 address
  for tool in pgrep gdbus timeout; do
    if ! command -v "$tool" >/dev/null 2>&1; then
      echo "OmpCode: cannot check IBus session (missing $tool); keeping input-method environment." >&2
      return 0
    fi
  done

  # 根因（CentOS 7 / IBus 1.5.17，SSH + 共享 X server 实测）：GTK 模块除连接
  # IBUS_ADDRESS 指向的私有总线外，还在 DBUS_SESSION_BUS_ADDRESS 所指会话总线上
  # 监听 org.freedesktop.IBus。若该名称不存在，_daemon_is_running 为 false，
  # ibus_im_context_filter_keypress 会退回普通字符输入，不发送 ProcessKeyEvent。
  # 因而即使 im-ibus.so 已加载、libpinyin/FocusIn/光标更新正常，仍可能只能输入英文。
  # 修复是继承当前用户、当前 DISPLAY 的 ibus-daemon 会话总线；不是将两个总线
  # 地址设成相同值，也不是修改 HOME/dconf。只改变本次应用环境，不重启守护进程。
  for pid in $(pgrep -u "$EUID" -x ibus-daemon 2>/dev/null || true); do
    [[ $pid =~ ^[0-9]+$ ]] || continue
    [[ -O /proc/$pid/environ && -r /proc/$pid/environ ]] || continue
    daemon_display= daemon_bus=
    # /proc 是 NUL 分隔数据，不能 source/eval；进程退出或权限变化时跳过。
    {
      while IFS= read -r -d '' entry; do
        case "$entry" in
          DISPLAY=*) daemon_display=${entry#DISPLAY=} ;;
          DBUS_SESSION_BUS_ADDRESS=*) daemon_bus=${entry#DBUS_SESSION_BUS_ADDRESS=} ;;
        esac
      done < "/proc/$pid/environ"
    } 2>/dev/null || continue
    [[ $daemon_display == "$DISPLAY" && $daemon_bus == unix:* && $daemon_bus != *';'* ]] || continue
    # gdbus --address 在宿主旧版本上可能未发送 Hello；必须用 --session 注册。
    # 核对服务所有者 PID，排除失效地址及同用户其他会话；超时只限制探测耗时。
    owner=$(timeout 2s env DBUS_SESSION_BUS_ADDRESS="$daemon_bus" gdbus call --session \
      --dest org.freedesktop.DBus --object-path /org/freedesktop/DBus \
      --method org.freedesktop.DBus.GetConnectionUnixProcessID org.freedesktop.IBus 2>/dev/null) || continue
    [[ $owner == "(uint32 $pid,)" ]] || continue
    if [[ $daemon_bus == "${DBUS_SESSION_BUS_ADDRESS:-}" ]]; then
      selected_bus=$daemon_bus
      ambiguous=0
      break
    fi
    if [[ -n $selected_bus && $selected_bus != "$daemon_bus" ]]; then
      ambiguous=1
    fi
    selected_bus=$daemon_bus
  done
  if ((ambiguous)); then
    echo 'OmpCode: multiple IBus sessions match this DISPLAY; keeping input-method environment.' >&2
    return 0
  fi
  if [[ -z $selected_bus ]]; then
    echo 'OmpCode: no verified IBus session for this user/DISPLAY; keeping input-method environment.' >&2
    return 0
  fi

  export DBUS_SESSION_BUS_ADDRESS="$selected_bus"
  export GTK_IM_MODULE="${GTK_IM_MODULE:-ibus}" XMODIFIERS="${XMODIFIERS:-@im=ibus}"
  # 在 XDG_CONFIG_HOME 隔离前读取原会话地址；尊重用户显式提供的 IBUS_ADDRESS。
  if [[ -z ${IBUS_ADDRESS:-} ]] && command -v ibus >/dev/null 2>&1; then
    address=$(timeout 2s ibus address 2>/dev/null) || address=
    if [[ $address == unix:* && $address != *$'\n'* && $address != *';'* ]]; then
      export IBUS_ADDRESS="$address"
    fi
  fi
}
configure_ibus_session

export XDG_CONFIG_HOME="$HOME/.config/ompcode-centos7"
export XDG_DATA_HOME="$HOME/.local/share/ompcode-centos7"
# 将真实输入法配置链接到隔离目录，保持 ibus/fcitx 地址文件等可见。
# 这只是路径兼容，不是只读隔离，也不能替代上面的 IBus 会话总线对齐；
# 目标位置已存在的同名条目不覆盖、不迁移。
if [[ -d "$HOME/.config" ]]; then
  mkdir -p -- "$XDG_CONFIG_HOME"
  for im_name in ibus fcitx fcitx5; do
    if [[ -d "$HOME/.config/$im_name" && ! -e "$XDG_CONFIG_HOME/$im_name" ]]; then
      ln -s -- "$HOME/.config/$im_name" "$XDG_CONFIG_HOME/$im_name"
    fi
  done
fi
# 修复说明：CentOS 7 的 bash 4.2 在 set -u 下展开空数组 "${arr[@]}" 会误报 unbound
# variable，导致无参数启动直接失败；${arr[@]+"${arr[@]}"} 是 4.2 兼容的惯用替代。
# CentOS 7 的目标环境没有 GPU；禁用 Chromium 硬件加速，仍允许软件渲染。
# 与 UI 的静态样式配合，让读取系统偏好的 JS 动画也停止持续刷新。
exec "$app/zcode" --no-sandbox --disable-gpu --force-prefers-reduced-motion ${desktop_args[@]+"${desktop_args[@]}"}

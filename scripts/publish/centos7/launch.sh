#!/bin/bash
set -euo pipefail

for arg in "$@"; do
  case "$arg" in
    --help|-h)
      cat <<'HELP'
用法：bin/ompcode-centos7 [选项] [桌面程序参数...]

  --home <绝对路径>   将 OmpCode 和内嵌 omp 的数据存放在该目录下
  --profile <名称>   选择内嵌 omp 的配置（也支持 --profile=名称）
  --offline          启用离线锁定：关闭手机远控、公网更新/配置/帮助/
                     社区/反馈、账号/分享、外部浏览器与遥测等桌面联网
                     后端，并把离线模式透传给内嵌 omp
  -h, --help         显示此帮助并退出

不传 --offline 时桌面为全功能，与 Windows 基准一致。其他参数会传递给
桌面程序。使用 --home 时不会覆盖已有的 ~/.ompcode 或 ~/.omp。
HELP
      exit 0
      ;;
  esac
done

package_root=$(dirname "$(dirname "$(readlink -f "$0")")")
app="$package_root/app"
# 离线锁定的唯一开关是 --offline：由下方参数解析决定 OMPCODE_CENTOS7_LOCAL_ONLY，
# 不传时桌面为全功能（与 Windows 基准一致），绝不继承调用者残留的锁定变量。
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
offline_requested=0
home_override=
home_requested=0
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
    --offline)
      offline_requested=1
      shift
      ;;
    --home)
      if (($# < 2)); then
        echo 'OmpCode: --home requires an absolute directory.' >&2
        exit 2
      fi
      home_override=$2
      home_requested=1
      shift 2
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

if ((offline_requested)); then
  # 离线锁定激活链（centos7-release.md）：--offline 同时设置桌面锁定变量并透传
  # 内嵌 omp（omp 侧由 OMPCODE_CENTOS7_OFFLINE 经适配器转成 omp --offline 参数）。
  export OMPCODE_CENTOS7_LOCAL_ONLY=1
  export OMPCODE_CENTOS7_OFFLINE=1
  # 桌面遥测出口一并关闭，dotenv 也不能重新启用（Main 侧另有同语义兜底）。
  unset ZCODE_ARMS_RUM_ENDPOINT ZCODE_TELEMETRY_REPORT_ENDPOINT
else
  # 该变量的唯一设置者是本启动器：不传 --offline 时必须清掉调用者环境里的
  # 残留锁定变量，保证未锁定桌面为全功能（与 Windows 基准一致）；遥测出口
  # 等环境按原样继承，与 Windows 语义相同。
  unset OMPCODE_CENTOS7_LOCAL_ONLY OMPCODE_CENTOS7_OFFLINE
fi

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

if ((home_requested)); then
  if [[ "$home_override" != /* ]]; then
    echo 'OmpCode: --home requires an absolute directory.' >&2
    exit 2
  fi
  data_base=$(readlink -m -- "$home_override")
  canonical_home=$(readlink -f -- "$HOME")
  case "$data_base" in
    "$canonical_home"|\
      "$canonical_home/.ompcode"|"$canonical_home/.ompcode/"*|\
      "$canonical_home/.omp"|"$canonical_home/.omp/"*)
      echo 'OmpCode: --home cannot be ~ or inside ~/.ompcode or ~/.omp.' >&2
      exit 2
      ;;
  esac

  # 修复依据：只迁移 ~/.ompcode 会让 Electron、Chromium 和 omp 继续把独立状态写入原 HOME。
  # 在创建任何目录前检查两个共享配置入口，避免冲突时留下半套新数据目录或覆盖用户数据。
  check_home_data_link() {
    local name=$1
    local link="$HOME/$name"
    local target="$data_base/$name"
    if [[ -L "$link" ]]; then
      if [[ "$(readlink -m -- "$link")" != "$(readlink -m -- "$target")" ]]; then
        echo "OmpCode: ~/$name already links to another location." >&2
        exit 2
      fi
    elif [[ -e "$link" ]]; then
      echo "OmpCode: ~/$name already exists; move its data before using --home." >&2
      exit 2
    fi
  }

  check_home_data_link .ompcode
  check_home_data_link .omp

  app_config_root="$data_base/.config/ompcode-centos7"
  managed_data_dirs=(
    "$data_base/.ompcode"
    "$data_base/.omp"
    "$app_config_root/OmpCode/session"
    "$data_base/.local/share/ompcode-centos7"
    "$data_base/.local/state/ompcode-centos7"
    "$data_base/.cache/ompcode-centos7"
    "$data_base/.tmp/ompcode-centos7"
  )
  data_prefix="${data_base%/}/"
  if [[ "$data_base" == / ]]; then
    data_prefix=/
  fi
  for directory in "${managed_data_dirs[@]}"; do
    resolved_directory=$(readlink -m -- "$directory")
    case "$resolved_directory" in
      "$data_prefix"*) ;;
      *)
        echo "OmpCode: managed data path escapes --home: $directory" >&2
        exit 2
        ;;
    esac
  done
  mkdir -p -- "${managed_data_dirs[@]}"

  [[ -L "$HOME/.ompcode" ]] || ln -s -- "$data_base/.ompcode" "$HOME/.ompcode"
  [[ -L "$HOME/.omp" ]] || ln -s -- "$data_base/.omp" "$HOME/.omp"

  export XDG_CONFIG_HOME="$app_config_root"
  export XDG_DATA_HOME="$data_base/.local/share/ompcode-centos7"
  export XDG_CACHE_HOME="$data_base/.cache/ompcode-centos7"
  export XDG_STATE_HOME="$data_base/.local/state/ompcode-centos7"
  export TMPDIR="$data_base/.tmp/ompcode-centos7"
  export PI_CONFIG_DIR="$data_base/.omp"
  export ZCODE_DATA_BASE_DIR="$data_base"
  export ZCODE_DESKTOP_HOME_DIR="$data_base"
  export ZCODE_DESKTOP_USER_DATA_DIR="$app_config_root/OmpCode"
  export ZCODE_DESKTOP_SESSION_DATA_DIR="$app_config_root/OmpCode/session"
  export OMPCODE_CENTOS7_HOME="$data_base"
else
  export XDG_CONFIG_HOME="$HOME/.config/ompcode-centos7"
  export XDG_DATA_HOME="$HOME/.local/share/ompcode-centos7"
  unset OMPCODE_CENTOS7_HOME
fi
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

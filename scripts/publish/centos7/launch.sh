#!/bin/bash
set -uo pipefail

# 帮助不能触发目录创建、包探测或输入法副作用；普通参数（含 profile）原样交给桌面。
for arg in "$@"; do
  case "$arg" in
    --help|-h)
      cat <<'HELP'
用法：bin/ompcode-centos7 [桌面程序参数...]
  -h, --help  显示帮助并退出

所有其他参数原样传给桌面；启动器不增加 profile 参数或配置 API。
所有 OMP_* 和 PI_CONFIG_DIR（包括空值）原样继承，由 OMP 解释。
未设置 ZCODE_AGENT_SERVER_COMMAND 时由桌面通过继承的 PATH 调用外部 omp；
显式非空命令优先，显式空值由桌面报错。发行包不内置或下载 OMP。
X11 下按当前 UID 和完整 DISPLAY 选择 IBus，失败告警后继续启动。
需要可用图形会话。Electron 28 已停止维护；应用禁用 sandbox 和 GPU，
保留软件渲染，请避免打开不可信工作区。
HELP
      exit 0
      ;;
  esac
done

# 普通启动保持控制台安静；原始输出仍落文件，避免隐藏真实启动错误。
exec 2>/dev/null
startup_log_dir="${XDG_CACHE_HOME:-${HOME:-}/.cache}/ompcode-centos7"
mkdir -p -- "$startup_log_dir" || exit 1
exec >"$startup_log_dir/startup-$$.log" 2>&1 || exit 1

warn() { printf 'OmpCode: %s\n' "$*" >&2; }
incomplete() { warn "CentOS 7 package is incomplete: $*"; exit 1; }
launcher=$(readlink -f -- "$0") || incomplete 'cannot resolve launcher path'
package_root=$(dirname -- "$(dirname -- "$launcher")")
app="$package_root/app"
# 文件名来自当前 electron-builder 产品身份，不能恢复历史 app/zcode。
executable=
for name in ompcode ompcode-preview; do
  if [[ -x "$app/$name" ]]; then
    [[ -z $executable ]] || incomplete 'multiple Electron product identities'
    executable="$app/$name"
  fi
done
[[ -n $executable && -s "$app/resources/app.asar" &&
   -d "$package_root/lib" && -s "$package_root/fonts/fonts.conf" ]] ||
   incomplete 'Electron, app.asar, lib or fonts/fonts.conf missing'

original_uid=$EUID
original_display=${DISPLAY-}
original_home=${HOME-}
original_config=${XDG_CONFIG_HOME:-$original_home/.config}
original_data=${XDG_DATA_HOME:-$original_home/.local/share}
original_cache=${XDG_CACHE_HOME:-$original_home/.cache}
caller_bus=${DBUS_SESSION_BUS_ADDRESS-}

local_bus() {
  # D-Bus 地址列表和非 Unix transport 都不能成为会话候选。
  [[ $1 == unix:* && $1 != *';'* && $1 != *$'\n'* && $1 != *$'\r'* &&
     ( $1 == unix:path=?* || $1 == unix:abstract=?* ) ]]
}

# 就绪轮询共享一个截止时间；候选较多时不能每个再花完整两秒而越过窗口。
bus_call() {
  local bus=$1 method=$2 limit=2 remaining
  if ((probe_deadline > 0)); then
    remaining=$((probe_deadline - SECONDS))
    ((remaining > 0)) || return 1
    ((remaining >= limit)) || limit=$remaining
  fi
  timeout "${limit}s" env DBUS_SESSION_BUS_ADDRESS="$bus" gdbus call --session \
    --dest org.freedesktop.DBus --object-path /org/freedesktop/DBus \
    --method "org.freedesktop.DBus.$method" org.freedesktop.IBus 2>/dev/null
}
probe_deadline=0

scan_ibus() {
  local pids status=0 pid entry daemon_display daemon_bus owner has_display
  selected_bus= scan_blocked=0 scan_ambiguous=0 scan_unreliable=0
  pids=$(pgrep -u "$original_uid" -x ibus-daemon 2>/dev/null) || status=$?
  if ((status != 0 && status != 1)); then
    scan_unreliable=1
    return
  fi
  for pid in $pids; do
    if [[ ! $pid =~ ^[1-9][0-9]*$ || ! -O /proc/$pid/environ || ! -r /proc/$pid/environ ]]; then
      scan_unreliable=1
      continue
    fi
    daemon_display= daemon_bus= has_display=0
    # /proc 环境以 NUL 分隔，只读数据；读取失败或进程消失均不能猜测 DISPLAY。
    if ! { exec 8<"/proc/$pid/environ"; } 2>/dev/null; then
      scan_unreliable=1
      continue
    fi
    while IFS= read -r -d '' entry <&8; do
      case "$entry" in
        DISPLAY=*) daemon_display=${entry#DISPLAY=}; has_display=1 ;;
        DBUS_SESSION_BUS_ADDRESS=*) daemon_bus=${entry#DBUS_SESSION_BUS_ADDRESS=} ;;
      esac
    done
    exec 8<&-
    if [[ ! -O /proc/$pid || ! -r /proc/$pid/comm ||
          $(<"/proc/$pid/comm") != ibus-daemon ]] || (( ! has_display )) || [[ -z $daemon_display ]]; then
      scan_unreliable=1
      continue
    fi
    # 同账号其他远程桌面不阻止当前 DISPLAY；完整字符串匹配，不折叠 :0 与 :0.0。
    [[ $daemon_display == "$original_display" ]] || continue
    scan_blocked=1
    local_bus "$daemon_bus" || continue
    owner=$(bus_call "$daemon_bus" GetConnectionUnixProcessID) || continue
    [[ $owner == "(uint32 $pid,)" && -O /proc/$pid && -r /proc/$pid/comm &&
       $(<"/proc/$pid/comm") == ibus-daemon ]] || continue
    if [[ $daemon_bus == "$caller_bus" ]]; then
      selected_bus=$daemon_bus
      # 已验证的调用者总线优先，不会误选同显示会话的另一条总线。
      return
    fi
    if [[ -n $selected_bus && $selected_bus != "$daemon_bus" ]]; then
      scan_ambiguous=1
    fi
    selected_bus=$daemon_bus
  done
  if ((scan_ambiguous || scan_unreliable)); then selected_bus=; fi
}

start_missing_ibus() (
  local tool lock_dir bus bus_owner= launch_output entry created_bus_pid= pid_count=0 address_count=0
  # 显式 IBUS_ADDRESS（包括空值）由调用者拥有，不启动第二个 daemon。
  if [[ ${IBUS_ADDRESS+x} ]]; then
    warn 'explicit IBUS_ADDRESS has no verified IBus session; preserving input-method environment'
    return 1
  fi
  for tool in flock dbus-launch ibus-daemon sleep; do
    if ! command -v "$tool" >/dev/null 2>&1; then
      warn "cannot start IBus: missing $tool; preserving input-method environment"
      return 1
    fi
  done
  [[ -n $original_home && $original_cache == /* ]] || {
    warn 'cannot locate original user cache for IBus lock'; return 1;
  }
  umask 077
  lock_dir="$original_cache/ompcode-centos7"
  if ! mkdir -p -- "$lock_dir" 2>/dev/null || [[ ! -O $lock_dir || -L $lock_dir ]]; then
    warn 'cannot create private IBus lock directory'; return 1
  fi
  if [[ -L "$lock_dir/ibus-start.lock" ]] ||
     ! { exec 9>>"$lock_dir/ibus-start.lock"; } 2>/dev/null; then
    warn 'cannot open IBus startup lock'; return 1
  fi
  if [[ ! -O /proc/self/fd/9 ]] || ! flock -w 5 9 2>/dev/null; then
    warn 'cannot acquire IBus startup lock within 5 seconds'; return 1
  fi
  # 锁内重新枚举，可复用另一个启动器刚完成的会话。
  scan_ibus
  if [[ -n $selected_bus ]]; then printf '%s\n' "$selected_bus"; return 0; fi
  if ((scan_blocked || scan_ambiguous || scan_unreliable)); then
    warn 'IBus exists for this DISPLAY, is ambiguous, or process ownership is unknown; not starting another daemon'
    return 1
  fi
  bus=$caller_bus
  if local_bus "$bus"; then bus_owner=$(bus_call "$bus" NameHasOwner) || bus_owner=; fi
  # 只回收本次新建的失败总线，绝不停止已有总线或 IBus；成功总线归用户会话。
  trap 'if [[ ${created_bus_pid:-} =~ ^[1-9][0-9]*$ && -O /proc/$created_bus_pid &&
              -r /proc/$created_bus_pid/comm && $(<"/proc/$created_bus_pid/comm") == dbus-daemon ]]; then
          kill "$created_bus_pid" 2>/dev/null || :
        fi' EXIT
  if [[ $bus_owner != '(false,)' ]]; then
    # 默认文本键值输出按整行解析，不 eval、不 shell 分词、不使用二进制语法。
    launch_output=$(timeout 3s dbus-launch --close-stderr 9>&- 2>/dev/null)
    status=$?
    bus=
    while IFS= read -r entry; do
      case "$entry" in
        DBUS_SESSION_BUS_ADDRESS=*) bus=${entry#DBUS_SESSION_BUS_ADDRESS=}; ((address_count+=1)) ;;
        DBUS_SESSION_BUS_PID=*) created_bus_pid=${entry#DBUS_SESSION_BUS_PID=}; ((pid_count+=1)) ;;
      esac
    done <<< "$launch_output"
    if ((status != 0 || address_count != 1 || pid_count != 1)) || ! local_bus "$bus" ||
       [[ ! $created_bus_pid =~ ^[1-9][0-9]*$ || ! -O /proc/$created_bus_pid ||
          ! -r /proc/$created_bus_pid/comm || $(<"/proc/$created_bus_pid/comm") != dbus-daemon ]]; then
      warn 'failed to create a validated user D-Bus session within 3 seconds'; return 1
    fi
  fi
  # 根因：旧 IBus GTK 模块还监视 session bus 的 org.freedesktop.IBus。
  # 私有地址/FocusIn 正常不代表按键可用；只补缺失会话，不 replace，不接管全局 XIM。
  if ! timeout 5s env DBUS_SESSION_BUS_ADDRESS="$bus" ibus-daemon --daemonize \
      9>&- </dev/null >/dev/null 2>&1; then
    warn 'failed to start IBus within 5 seconds'; return 1
  fi
  probe_deadline=$((SECONDS + 5))
  while ((SECONDS < probe_deadline)); do
    scan_ibus
    if [[ $selected_bus == "$bus" ]]; then
      created_bus_pid=
      printf '%s\n' "$selected_bus"
      return 0
    fi
    ((SECONDS < probe_deadline)) || break
    sleep 0.1
  done
  warn 'IBus did not register a verified UID/DISPLAY/owner PID within 5 seconds'
  return 1
)

configure_ibus() {
  local tool selected_bus= scan_blocked=0 scan_ambiguous=0 scan_unreliable=0 address
  if [[ -z $original_display ]]; then warn 'no DISPLAY; skipping X11 IBus discovery'; return; fi
  # 空值视为未设置；非空的替代输入法保持原样，Wayland 会话不启动 X11 daemon。
  [[ ${XDG_SESSION_TYPE-} != wayland ]] || return 0
  [[ ${GTK_IM_MODULE:-ibus} == ibus && ${XMODIFIERS:-@im=ibus} == @im=ibus ]] || return 0
  for tool in pgrep gdbus timeout; do
    if ! command -v "$tool" >/dev/null 2>&1; then
      warn "cannot inspect IBus: missing $tool; preserving input-method environment"; return 0
    fi
  done
  scan_ibus
  if [[ -z $selected_bus ]]; then
    if ((scan_ambiguous || scan_unreliable || scan_blocked)); then
      warn 'no unique verified IBus session; existing or unknown daemon protected'; return 0
    fi
    selected_bus=$(start_missing_ibus) || return 0
  fi
  export DBUS_SESSION_BUS_ADDRESS="$selected_bus"
  export GTK_IM_MODULE="${GTK_IM_MODULE:-ibus}" XMODIFIERS="${XMODIFIERS:-@im=ibus}"
  # 必须在原 HOME/XDG 下查地址；显式空 IBUS_ADDRESS 也不可覆盖。
  if [[ ! ${IBUS_ADDRESS+x} ]]; then
    if ! command -v ibus >/dev/null 2>&1; then
      warn 'cannot discover IBus address: missing ibus'; return 0
    fi
    address=$(timeout 2s ibus address 2>/dev/null) || address=
    if local_bus "$address"; then export IBUS_ADDRESS="$address"
    else warn 'ibus address did not return a local Unix address within 2 seconds'; fi
  fi
}
configure_ibus

# 仅在输入法选择完成后设置应用进程树的库和字体，不污染用户会话 daemon。
export LD_LIBRARY_PATH="$package_root/lib${LD_LIBRARY_PATH:+:$LD_LIBRARY_PATH}"
export FONTCONFIG_FILE="$package_root/fonts/fonts.conf"
export FONTCONFIG_PATH="$package_root/fonts"

# 输入法会话发现完成后才隔离 XDG；HOME 与 OMP_* / PI_CONFIG_DIR 均不改写。
if [[ -n $original_home ]]; then
  export XDG_CONFIG_HOME="$original_config/ompcode-centos7"
  export XDG_DATA_HOME="$original_data/ompcode-centos7"
  if ! mkdir -p -- "$XDG_CONFIG_HOME" "$XDG_DATA_HOME"; then
    warn 'cannot create private XDG directories; Electron will report storage failures'
  else
    # 原 XDG 可自定义；只链接实际存在的输入法目录，不覆盖文件或悬空链接。
    for im_name in ibus fcitx fcitx5; do
      for kind in config data; do
        if [[ $kind == config ]]; then source_root=$original_config; target_root=$XDG_CONFIG_HOME
        else source_root=$original_data; target_root=$XDG_DATA_HOME; fi
        if [[ -d "$source_root/$im_name" && ! -e "$target_root/$im_name" && ! -L "$target_root/$im_name" ]]; then
          ln -s -- "$source_root/$im_name" "$target_root/$im_name" || warn "cannot link $kind/$im_name"
        fi
      done
    done
  fi
else
  warn 'HOME is missing; preserving inherited XDG directories'
fi
# Bash 4.2 在 nounset 下展开空数组会误报；直接用 "$@" 同时保留空参数与完整 argv。
exec "$executable" --no-sandbox --disable-gpu "$@"

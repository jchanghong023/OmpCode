#!/bin/bash
set -euo pipefail

script_dir=$(dirname "$(readlink -f "$0")")
test_root=$(mktemp -d)
fixture_pids=()
cleanup() {
  for pid in ${fixture_pids[@]+"${fixture_pids[@]}"}; do
    kill "$pid" 2>/dev/null || true
    wait "$pid" 2>/dev/null || true
  done
  rm -rf -- "$test_root"
}
trap cleanup EXIT
unset DISPLAY GTK_IM_MODULE XMODIFIERS IBUS_ADDRESS DBUS_SESSION_BUS_ADDRESS

# 部分开发机 PATH 里的用户级 env shim 会吞掉子进程 stdout；优先用系统 /usr/bin/env，
# CentOS 7 上两者一致，不改变被测行为。
if [[ -x /usr/bin/env ]]; then
  env_bin=/usr/bin/env
else
  env_bin=env
fi

# Windows Git Bash 无符号链接权限时 ln -s 退化为目录复制，-L/readlink 断言无法成立；
# 只在平台真正支持符号链接时执行这些断言（CentOS 7 目标环境始终支持，验证强度不变）。
symlink_supported=0
probe_target="$test_root/probe-target"
probe_link="$test_root/probe-link"
mkdir -p "$probe_target"
if ln -s "$probe_target" "$probe_link" 2>/dev/null && [[ -L "$probe_link" ]]; then
  symlink_supported=1
fi
rm -rf -- "$probe_link"

expect_symlink_target() {
  ((symlink_supported)) || return 0
  [[ "$(readlink -- "$1")" == "$2" ]]
}

expect_is_symlink() {
  ((symlink_supported)) || return 0
  [[ -L $1 ]]
}

package_root="$test_root/package"
launcher="$package_root/bin/ompcode-centos7"
mkdir -p "$package_root/bin" "$package_root/app/resources/glm/omp"
cp "$script_dir/launch.sh" "$launcher"
chmod +x "$launcher"
help_home="$test_root/help-home"
help_data="$test_root/help-data"
help_output=$(HOME="$help_home" "$launcher" --home "$help_data" --help)
grep -Fq -- '--home <绝对路径>' <<<"$help_output"
grep -Fq -- '--profile <名称>' <<<"$help_output"
grep -Fq -- '--offline' <<<"$help_output"
grep -Fq -- '离线锁定' <<<"$help_output"
grep -Fq -- '全功能' <<<"$help_output"
[[ ! -e "$help_home" && ! -e "$help_data" ]]
HOME="$help_home" "$launcher" -h >/dev/null
[[ ! -e "$help_home" ]]

# Git Bash/MSYS 的 -x 判定要求文件具备可执行形态（shebang 魔数或 .exe 扩展名）；
# 给 omp 夹具最小 shebang，让同一测试在 CentOS 7 与 Windows Git Bash 都成立。
touch "$package_root/app/resources/app.asar"
printf '#!/bin/sh\nexit 0\n' > "$package_root/app/resources/glm/omp/omp"
chmod +x "$package_root/app/resources/glm/omp/omp"
cat > "$package_root/app/zcode" <<'STUB'
#!/bin/bash
set -euo pipefail
for name in \
  HOME XDG_CONFIG_HOME XDG_DATA_HOME XDG_CACHE_HOME XDG_STATE_HOME TMPDIR PI_CONFIG_DIR \
  ZCODE_DATA_BASE_DIR ZCODE_DESKTOP_HOME_DIR ZCODE_DESKTOP_USER_DATA_DIR \
  ZCODE_DESKTOP_SESSION_DATA_DIR OMPCODE_CENTOS7_HOME OMPCODE_CENTOS7_PROFILE \
  OMPCODE_CENTOS7_OFFLINE OMPCODE_CENTOS7_LOCAL_ONLY \
  ZCODE_ARMS_RUM_ENDPOINT ZCODE_TELEMETRY_REPORT_ENDPOINT \
  DBUS_SESSION_BUS_ADDRESS IBUS_ADDRESS GTK_IM_MODULE XMODIFIERS; do
  printf '%s=%s\n' "$name" "${!name-}"
done
for arg in "$@"; do
  printf 'ARG=%s\n' "$arg"
done
STUB
chmod +x "$package_root/app/zcode"

user_home="$test_root/user-home"
data_home="$test_root/external data"
mkdir -p "$user_home/.config/ibus/bus"
ibus_marker="$user_home/.config/ibus/bus/address-marker"
printf 'ibus-socket-address\n' >"$ibus_marker"
output=$("$env_bin" \
  -u XDG_CONFIG_HOME -u XDG_DATA_HOME -u XDG_CACHE_HOME -u XDG_STATE_HOME -u TMPDIR \
  -u PI_CONFIG_DIR -u ZCODE_DATA_BASE_DIR -u ZCODE_DESKTOP_HOME_DIR \
  -u ZCODE_DESKTOP_USER_DATA_DIR -u ZCODE_DESKTOP_SESSION_DATA_DIR \
  -u OMPCODE_CENTOS7_HOME -u OMPCODE_CENTOS7_LOCAL_ONLY -u ZCODE_ARMS_RUM_ENDPOINT \
  HOME="$user_home" "$launcher" --home "$data_home" --profile test-profile --offline --extra value)

expect_line() {
  local expected=$1
  if ! grep -Fxq -- "$expected" <<<"$output"; then
    printf 'Expected launcher output to contain: %s\n%s\n' "$expected" "$output" >&2
    exit 1
  fi
}

expect_line "HOME=$user_home"
expect_line "XDG_CONFIG_HOME=$data_home/.config/ompcode-centos7"
expect_line "XDG_DATA_HOME=$data_home/.local/share/ompcode-centos7"
expect_line "XDG_CACHE_HOME=$data_home/.cache/ompcode-centos7"
expect_line "XDG_STATE_HOME=$data_home/.local/state/ompcode-centos7"
expect_line "TMPDIR=$data_home/.tmp/ompcode-centos7"
expect_line "PI_CONFIG_DIR=$data_home/.omp"
expect_line "ZCODE_DATA_BASE_DIR=$data_home"
expect_line "ZCODE_DESKTOP_HOME_DIR=$data_home"
expect_line "ZCODE_DESKTOP_USER_DATA_DIR=$data_home/.config/ompcode-centos7/OmpCode"
expect_line "ZCODE_DESKTOP_SESSION_DATA_DIR=$data_home/.config/ompcode-centos7/OmpCode/session"
expect_line "OMPCODE_CENTOS7_HOME=$data_home"
expect_line 'OMPCODE_CENTOS7_PROFILE=test-profile'
expect_line 'OMPCODE_CENTOS7_OFFLINE=1'
expect_line 'OMPCODE_CENTOS7_LOCAL_ONLY=1'
expect_line 'ZCODE_ARMS_RUM_ENDPOINT='
expect_line 'ARG=--no-sandbox'
expect_line 'ARG=--disable-gpu'
expect_line 'ARG=--force-prefers-reduced-motion'
expect_line 'ARG=--extra'
expect_line 'ARG=value'
if grep -Fxq 'ARG=--profile' <<<"$output" || grep -Fxq 'ARG=--offline' <<<"$output"; then
  echo 'The launcher did not consume --profile or --offline.' >&2
  exit 1
fi
expect_symlink_target "$user_home/.ompcode" "$data_home/.ompcode"
expect_symlink_target "$user_home/.omp" "$data_home/.omp"
[[ -d "$data_home/.config/ompcode-centos7/OmpCode/session" ]]
[[ -d "$data_home/.local/share/ompcode-centos7" ]]
[[ -d "$data_home/.local/state/ompcode-centos7" ]]
[[ -d "$data_home/.cache/ompcode-centos7" ]]
[[ -d "$data_home/.tmp/ompcode-centos7" ]]
expect_is_symlink "$data_home/.config/ompcode-centos7/ibus"
expect_symlink_target "$data_home/.config/ompcode-centos7/ibus" "$user_home/.config/ibus"
[[ "$(cat -- "$data_home/.config/ompcode-centos7/ibus/bus/address-marker")" == 'ibus-socket-address' ]]

# The same destination is reusable on later launches.
# 复用语义依赖符号链接检测；无法创建符号链接的平台（Git Bash 退化复制）跳过，
# CentOS 7 上始终执行。
if ((symlink_supported)); then
  "$env_bin" -u OMPCODE_CENTOS7_HOME HOME="$user_home" "$launcher" --home "$data_home" >/dev/null
fi

# 参数矩阵补充：--profile（= 形式）不伴随 --offline——profile 生效但锁定变量必须为空。
profile_online_home="$test_root/profile-online-home"
profile_online_data="$test_root/profile-online-data"
mkdir -p "$profile_online_home"
profile_online_output=$("$env_bin" \
  -u XDG_CONFIG_HOME -u XDG_DATA_HOME -u XDG_CACHE_HOME -u XDG_STATE_HOME -u TMPDIR \
  -u PI_CONFIG_DIR -u ZCODE_DATA_BASE_DIR -u ZCODE_DESKTOP_HOME_DIR \
  -u ZCODE_DESKTOP_USER_DATA_DIR -u ZCODE_DESKTOP_SESSION_DATA_DIR \
  -u OMPCODE_CENTOS7_HOME \
  HOME="$profile_online_home" "$launcher" --home "$profile_online_data" --profile=online-prof)
grep -Fxq 'OMPCODE_CENTOS7_PROFILE=online-prof' <<<"$profile_online_output"
grep -Fxq 'OMPCODE_CENTOS7_LOCAL_ONLY=' <<<"$profile_online_output"
grep -Fxq 'OMPCODE_CENTOS7_OFFLINE=' <<<"$profile_online_output"
expect_symlink_target "$profile_online_home/.ompcode" "$profile_online_data/.ompcode"

conflict_home="$test_root/conflict-home"
conflict_target="$test_root/conflict-target"
mkdir -p "$conflict_home/.omp"
set +e
"$env_bin" HOME="$conflict_home" "$launcher" --home "$conflict_target" >/dev/null 2>&1
conflict_status=$?
set -e
[[ "$conflict_status" == 2 ]]
[[ -d "$conflict_home/.omp" && ! -e "$conflict_target" ]]

# 逃逸受管路径的场景需要真实符号链接表达；无法创建符号链接的平台跳过，
# CentOS 7 上始终执行（需求：解析到 --home 之外的受管路径被拒绝）。
if ((symlink_supported)); then
  escape_home="$test_root/escape-home"
  escape_target="$test_root/escape-target"
  outside_cache="$test_root/outside-cache"
  mkdir -p "$escape_home" "$outside_cache"
  mkdir -p "$escape_target"
  ln -s "$outside_cache" "$escape_target/.cache"
  set +e
  "$env_bin" HOME="$escape_home" "$launcher" --home "$escape_target" >/dev/null 2>&1
  escape_status=$?
  set -e
  [[ "$escape_status" == 2 ]]
  [[ ! -e "$escape_home/.ompcode" && ! -e "$escape_home/.omp" ]]
fi

default_home="$test_root/default-home"
mkdir -p "$default_home/.config/fcitx"
# 在线（不传 --offline）参数矩阵：调用者环境里残留的锁定变量、旧 profile 与遥测
# 出口必须按「唯一设置者是启动器」的规则处理——锁定变量清空、旧 profile 清空、
# 遥测出口原样继承（与 Windows 全功能基准一致）。
default_output=$("$env_bin" \
  -u PI_CONFIG_DIR -u ZCODE_DATA_BASE_DIR -u ZCODE_DESKTOP_HOME_DIR \
  -u ZCODE_DESKTOP_USER_DATA_DIR -u ZCODE_DESKTOP_SESSION_DATA_DIR \
  XDG_CACHE_HOME="$test_root/preserved-cache" XDG_STATE_HOME="$test_root/preserved-state" \
  TMPDIR="$test_root/preserved-tmp" \
  OMPCODE_CENTOS7_HOME=stale \
  OMPCODE_CENTOS7_LOCAL_ONLY=1 OMPCODE_CENTOS7_OFFLINE=1 \
  OMPCODE_CENTOS7_PROFILE=stale-profile \
  ZCODE_ARMS_RUM_ENDPOINT=https://arms.example.test ZCODE_TELEMETRY_REPORT_ENDPOINT=https://telemetry.example.test \
  HOME="$default_home" \
  "$launcher" --ordinary-arg)
grep -Fxq "HOME=$default_home" <<<"$default_output"
grep -Fxq "XDG_CONFIG_HOME=$default_home/.config/ompcode-centos7" <<<"$default_output"
grep -Fxq "XDG_DATA_HOME=$default_home/.local/share/ompcode-centos7" <<<"$default_output"
grep -Fxq "XDG_CACHE_HOME=$test_root/preserved-cache" <<<"$default_output"
grep -Fxq "XDG_STATE_HOME=$test_root/preserved-state" <<<"$default_output"
grep -Fxq "TMPDIR=$test_root/preserved-tmp" <<<"$default_output"
grep -Fxq 'OMPCODE_CENTOS7_HOME=' <<<"$default_output"
# 不传 --offline 时锁定变量必须为空：启动器是唯一设置者，清掉调用者残留。
grep -Fxq 'OMPCODE_CENTOS7_LOCAL_ONLY=' <<<"$default_output"
grep -Fxq 'OMPCODE_CENTOS7_OFFLINE=' <<<"$default_output"
grep -Fxq 'OMPCODE_CENTOS7_PROFILE=' <<<"$default_output"
# 未锁定时遥测出口不被启动器改写，桌面保持全功能。
grep -Fxq 'ZCODE_ARMS_RUM_ENDPOINT=https://arms.example.test' <<<"$default_output"
grep -Fxq 'ZCODE_TELEMETRY_REPORT_ENDPOINT=https://telemetry.example.test' <<<"$default_output"
[[ ! -e "$default_home/.ompcode" && ! -e "$default_home/.omp" ]]
expect_is_symlink "$default_home/.config/ompcode-centos7/fcitx"
expect_symlink_target "$default_home/.config/ompcode-centos7/fcitx" "$default_home/.config/fcitx"
# 目标位置已有同名条目时不得覆盖。
mkdir -p "$default_home/.config/ompcode-centos7/fcitx5"
"$env_bin" HOME="$default_home" "$launcher" >/dev/null
[[ -d "$default_home/.config/ompcode-centos7/fcitx5" && ! -L "$default_home/.config/ompcode-centos7/fcitx5" ]]

# 使用真实子进程的 NUL 分隔 environ；只替换发现进程和查询总线的外部命令。
# 不依赖测试机上的桌面/IBus，也不触碰正在运行的用户输入法。
#
# IBus 会话选择面向 Linux（/proc environ、gdbus、ibus-daemon）。MSYS/Git Bash 的
# 进程孵化时延会让启动器内 2 秒的 gdbus 探测偶发超时，在该平台无法稳定回归；
# 因此按平台能力执行：Linux（CentOS 7 目标环境）全量运行，其余平台显式跳过并
# 提示，不静默缺失。
if [[ $(uname -s) == Linux ]]; then
mock_bin="$test_root/ime-bin"
mkdir -p "$mock_bin"
# 启动器内部经 `timeout ... env VAR=... gdbus` 查询总线；部分开发机 PATH 里的
# 用户级 env shim 会吞掉子进程 stdout，这里提供一个确定可用的 env。
ln -s /usr/bin/env "$mock_bin/env" 2>/dev/null || cp /usr/bin/env "$mock_bin/env"
cat > "$mock_bin/pgrep" <<'STUB'
#!/bin/bash
[[ "$*" == "-u $EUID -x ibus-daemon" ]] || exit 2
printf '%s\n' "${OMPCODE_TEST_PIDS-}"
STUB
cat > "$mock_bin/gdbus" <<'STUB'
#!/bin/bash
[[ "$*" == 'call --session --dest org.freedesktop.DBus --object-path /org/freedesktop/DBus --method org.freedesktop.DBus.GetConnectionUnixProcessID org.freedesktop.IBus' ]] || exit 2
printf '%s\n' "$DBUS_SESSION_BUS_ADDRESS" >> "$OMPCODE_TEST_PROBES"
case "$DBUS_SESSION_BUS_ADDRESS" in
  unix:path=/test/bus-a) printf '(uint32 %s,)\n' "$OMPCODE_TEST_OWNER_A" ;;
  unix:path=/test/bus-b) printf '(uint32 %s,)\n' "$OMPCODE_TEST_OWNER_B" ;;
  unix:path=/test/slow) sleep 10; exit 1 ;;
  *) exit 1 ;;
esac
STUB
cat > "$mock_bin/ibus" <<'STUB'
#!/bin/bash
[[ "$*" == address && "$XDG_CONFIG_HOME" == "$OMPCODE_TEST_ORIGINAL_CONFIG" ]] || exit 2
[[ "$DBUS_SESSION_BUS_ADDRESS" == unix:path=/test/bus-a ]] || exit 3
printf '%s\n' 'unix:path=/test/ibus-private'
STUB
chmod +x "$mock_bin/pgrep" "$mock_bin/gdbus" "$mock_bin/ibus"
start_fixture() {
  local marker="$test_root/pid-$2"
  "$env_bin" DISPLAY="$1" DBUS_SESSION_BUS_ADDRESS="unix:path=/test/$2" bash -c '
    while read -r key value rest; do
      if [[ $key == Pid: ]]; then printf "%s\n" "$value" > "$1"; break; fi
    done < /proc/self/status
    exec sleep 120
  ' bash "$marker" &
  fixture_pids+=("$!")
  # /proc 可能来自外层 PID namespace；用进程自行读取的 Pid 定位 environ。
  for attempt in {1..100}; do
    if [[ -s "$marker" ]]; then break; fi
    sleep 0.01
  done
  fixture_pid=$(cat "$marker")
}
start_fixture :71 bus-a; pid_a=$fixture_pid
start_fixture :71 bus-b; pid_b=$fixture_pid
start_fixture :72 other-display; pid_other=$fixture_pid
start_fixture :71 dead; pid_dead_bus=$fixture_pid
start_fixture :71 slow; pid_slow=$fixture_pid
run_ime() {
  : > "$test_root/probes"
  output=$("$env_bin" PATH="$mock_bin:$PATH" HOME="$default_home" DISPLAY=:71 \
    GTK_IM_MODULE=ibus XMODIFIERS=@im=ibus DBUS_SESSION_BUS_ADDRESS=unix:path=/test/wrong \
    XDG_CONFIG_HOME="$test_root/original-config" \
    OMPCODE_TEST_ORIGINAL_CONFIG="$test_root/original-config" \
    OMPCODE_TEST_PROBES="$test_root/probes" \
    OMPCODE_TEST_PIDS="$pid_other $pid_a" \
    OMPCODE_TEST_OWNER_A="$pid_a" OMPCODE_TEST_OWNER_B="$pid_b" \
    "$@" "$launcher" --home "$test_root/ime-data" 2> "$test_root/ime-stderr")
  # 输出为空说明启动器没走到桌面 stub；先回放启动器 stderr 便于定位平台差异。
  if [[ -z $output ]]; then
    cat "$test_root/ime-stderr" >&2
  fi
}
run_ime
expect_line 'DBUS_SESSION_BUS_ADDRESS=unix:path=/test/bus-a'
expect_line 'IBUS_ADDRESS=unix:path=/test/ibus-private'
expect_line 'ARG=--disable-gpu'
[[ "$(cat "$test_root/probes")" == unix:path=/test/bus-a ]]
run_ime IBUS_ADDRESS=unix:path=/test/explicit GTK_IM_MODULE= XMODIFIERS=
expect_line 'IBUS_ADDRESS=unix:path=/test/explicit'
expect_line 'GTK_IM_MODULE=ibus'
expect_line 'XMODIFIERS=@im=ibus'
run_ime OMPCODE_TEST_PIDS="$pid_a $pid_b" DBUS_SESSION_BUS_ADDRESS=unix:path=/test/bus-b
expect_line 'DBUS_SESSION_BUS_ADDRESS=unix:path=/test/bus-b'
run_ime OMPCODE_TEST_PIDS="$pid_a $pid_b"
expect_line 'DBUS_SESSION_BUS_ADDRESS=unix:path=/test/wrong'
grep -q 'multiple' "$test_root/ime-stderr"
run_ime OMPCODE_TEST_PIDS="$pid_dead_bus"
expect_line 'DBUS_SESSION_BUS_ADDRESS=unix:path=/test/wrong'
started=$SECONDS
run_ime OMPCODE_TEST_PIDS="$pid_slow"
expect_line 'DBUS_SESSION_BUS_ADDRESS=unix:path=/test/wrong'
((SECONDS - started < 6))
run_ime OMPCODE_TEST_PIDS=9999999999
expect_line 'DBUS_SESSION_BUS_ADDRESS=unix:path=/test/wrong'
run_ime OMPCODE_TEST_OWNER_A=1
expect_line 'DBUS_SESSION_BUS_ADDRESS=unix:path=/test/wrong'
run_ime OMPCODE_TEST_PIDS=
expect_line 'DBUS_SESSION_BUS_ADDRESS=unix:path=/test/wrong'
run_ime OMPCODE_TEST_PIDS="$pid_other"
expect_line 'DBUS_SESSION_BUS_ADDRESS=unix:path=/test/wrong'
[[ ! -s "$test_root/probes" ]]
missing_tool_bin="$test_root/missing-tool-bin"
mkdir -p "$missing_tool_bin"
for tool in dirname readlink mkdir ln timeout; do
  ln -s "$(command -v "$tool")" "$missing_tool_bin/$tool"
done
ln -s "$mock_bin/pgrep" "$missing_tool_bin/pgrep"
run_ime PATH="$missing_tool_bin"
expect_line 'DBUS_SESSION_BUS_ADDRESS=unix:path=/test/wrong'
grep -q 'missing gdbus' "$test_root/ime-stderr"
run_ime GTK_IM_MODULE=fcitx
expect_line 'GTK_IM_MODULE=fcitx'
expect_line 'DBUS_SESSION_BUS_ADDRESS=unix:path=/test/wrong'
[[ ! -s "$test_root/probes" ]]
run_ime XMODIFIERS=@im=fcitx
expect_line 'XMODIFIERS=@im=fcitx'
[[ ! -s "$test_root/probes" ]]
run_ime DISPLAY=
expect_line 'DBUS_SESSION_BUS_ADDRESS=unix:path=/test/wrong'
[[ ! -s "$test_root/probes" ]]
else
  echo "IBus session-selection regression requires Linux (/proc, gdbus); skipped on $(uname -s)." >&2
fi

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
[[ ! -e "$help_home" && ! -e "$help_data" ]]
HOME="$help_home" "$launcher" -h >/dev/null
[[ ! -e "$help_home" ]]

touch "$package_root/app/resources/app.asar" "$package_root/app/resources/glm/omp/omp"
chmod +x "$package_root/app/resources/glm/omp/omp"
cat > "$package_root/app/zcode" <<'STUB'
#!/bin/bash
set -euo pipefail
for name in \
  HOME XDG_CONFIG_HOME XDG_DATA_HOME XDG_CACHE_HOME XDG_STATE_HOME TMPDIR PI_CONFIG_DIR \
  ZCODE_DATA_BASE_DIR ZCODE_DESKTOP_HOME_DIR ZCODE_DESKTOP_USER_DATA_DIR \
  ZCODE_DESKTOP_SESSION_DATA_DIR OMPCODE_CENTOS7_HOME OMPCODE_CENTOS7_PROFILE \
  OMPCODE_CENTOS7_OFFLINE DBUS_SESSION_BUS_ADDRESS IBUS_ADDRESS GTK_IM_MODULE XMODIFIERS; do
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
output=$(env \
  -u XDG_CONFIG_HOME -u XDG_DATA_HOME -u XDG_CACHE_HOME -u XDG_STATE_HOME -u TMPDIR \
  -u PI_CONFIG_DIR -u ZCODE_DATA_BASE_DIR -u ZCODE_DESKTOP_HOME_DIR \
  -u ZCODE_DESKTOP_USER_DATA_DIR -u ZCODE_DESKTOP_SESSION_DATA_DIR \
  -u OMPCODE_CENTOS7_HOME \
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
expect_line 'ARG=--no-sandbox'
expect_line 'ARG=--disable-gpu'
expect_line 'ARG=--force-prefers-reduced-motion'
expect_line 'ARG=--extra'
expect_line 'ARG=value'
if grep -Fxq 'ARG=--profile' <<<"$output" || grep -Fxq 'ARG=--offline' <<<"$output"; then
  echo 'The launcher did not consume --profile or --offline.' >&2
  exit 1
fi
[[ "$(readlink "$user_home/.ompcode")" == "$data_home/.ompcode" ]]
[[ "$(readlink "$user_home/.omp")" == "$data_home/.omp" ]]
[[ -d "$data_home/.config/ompcode-centos7/OmpCode/session" ]]
[[ -d "$data_home/.local/share/ompcode-centos7" ]]
[[ -d "$data_home/.local/state/ompcode-centos7" ]]
[[ -d "$data_home/.cache/ompcode-centos7" ]]
[[ -d "$data_home/.tmp/ompcode-centos7" ]]
[[ -L "$data_home/.config/ompcode-centos7/ibus" ]]
[[ "$(readlink -- "$data_home/.config/ompcode-centos7/ibus")" == "$user_home/.config/ibus" ]]
[[ "$(cat -- "$data_home/.config/ompcode-centos7/ibus/bus/address-marker")" == 'ibus-socket-address' ]]

# The same destination is reusable on later launches.
env -u OMPCODE_CENTOS7_HOME HOME="$user_home" "$launcher" --home "$data_home" >/dev/null

conflict_home="$test_root/conflict-home"
conflict_target="$test_root/conflict-target"
mkdir -p "$conflict_home/.omp"
set +e
env HOME="$conflict_home" "$launcher" --home "$conflict_target" >/dev/null 2>&1
conflict_status=$?
set -e
[[ "$conflict_status" == 2 ]]
[[ -d "$conflict_home/.omp" && ! -e "$conflict_target" ]]

escape_home="$test_root/escape-home"
escape_target="$test_root/escape-target"
outside_cache="$test_root/outside-cache"
mkdir -p "$escape_home" "$outside_cache"
mkdir -p "$escape_target"
ln -s "$outside_cache" "$escape_target/.cache"
set +e
env HOME="$escape_home" "$launcher" --home "$escape_target" >/dev/null 2>&1
escape_status=$?
set -e
[[ "$escape_status" == 2 ]]
[[ ! -e "$escape_home/.ompcode" && ! -e "$escape_home/.omp" ]]

default_home="$test_root/default-home"
mkdir -p "$default_home/.config/fcitx"
default_output=$(env \
  -u PI_CONFIG_DIR -u ZCODE_DATA_BASE_DIR -u ZCODE_DESKTOP_HOME_DIR \
  -u ZCODE_DESKTOP_USER_DATA_DIR -u ZCODE_DESKTOP_SESSION_DATA_DIR \
  XDG_CACHE_HOME="$test_root/preserved-cache" XDG_STATE_HOME="$test_root/preserved-state" \
  TMPDIR="$test_root/preserved-tmp" OMPCODE_CENTOS7_HOME=stale HOME="$default_home" \
  "$launcher" --ordinary-arg)
grep -Fxq "HOME=$default_home" <<<"$default_output"
grep -Fxq "XDG_CONFIG_HOME=$default_home/.config/ompcode-centos7" <<<"$default_output"
grep -Fxq "XDG_DATA_HOME=$default_home/.local/share/ompcode-centos7" <<<"$default_output"
grep -Fxq "XDG_CACHE_HOME=$test_root/preserved-cache" <<<"$default_output"
grep -Fxq "XDG_STATE_HOME=$test_root/preserved-state" <<<"$default_output"
grep -Fxq "TMPDIR=$test_root/preserved-tmp" <<<"$default_output"
grep -Fxq 'OMPCODE_CENTOS7_HOME=' <<<"$default_output"
[[ ! -e "$default_home/.ompcode" && ! -e "$default_home/.omp" ]]
[[ -L "$default_home/.config/ompcode-centos7/fcitx" ]]
[[ "$(readlink -- "$default_home/.config/ompcode-centos7/fcitx")" == "$default_home/.config/fcitx" ]]
# 目标位置已有同名条目时不得覆盖。
mkdir -p "$default_home/.config/ompcode-centos7/fcitx5"
env HOME="$default_home" "$launcher" >/dev/null
[[ -d "$default_home/.config/ompcode-centos7/fcitx5" && ! -L "$default_home/.config/ompcode-centos7/fcitx5" ]]

# 使用真实子进程的 NUL 分隔 environ；只替换发现进程和查询总线的外部命令。
# 不依赖测试机上的桌面/IBus，也不触碰正在运行的用户输入法。
mock_bin="$test_root/ime-bin"
mkdir -p "$mock_bin"
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
  env DISPLAY="$1" DBUS_SESSION_BUS_ADDRESS="unix:path=/test/$2" bash -c '
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
  output=$(env PATH="$mock_bin:$PATH" HOME="$default_home" DISPLAY=:71 \
    GTK_IM_MODULE=ibus XMODIFIERS=@im=ibus DBUS_SESSION_BUS_ADDRESS=unix:path=/test/wrong \
    XDG_CONFIG_HOME="$test_root/original-config" \
    OMPCODE_TEST_ORIGINAL_CONFIG="$test_root/original-config" \
    OMPCODE_TEST_PROBES="$test_root/probes" \
    OMPCODE_TEST_PIDS="$pid_other $pid_a" \
    OMPCODE_TEST_OWNER_A="$pid_a" OMPCODE_TEST_OWNER_B="$pid_b" \
    "$@" "$launcher" --home "$test_root/ime-data" 2> "$test_root/ime-stderr")
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

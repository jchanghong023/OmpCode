#!/bin/bash
set -euo pipefail

script_dir=$(dirname "$(readlink -f "$0")")
test_root=$(mktemp -d)
trap 'rm -rf -- "$test_root"' EXIT

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
  OMPCODE_CENTOS7_OFFLINE; do
  printf '%s=%s\n' "$name" "${!name-}"
done
for arg in "$@"; do
  printf 'ARG=%s\n' "$arg"
done
STUB
chmod +x "$package_root/app/zcode"

user_home="$test_root/user-home"
data_home="$test_root/external data"
mkdir -p "$user_home"
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
mkdir -p "$default_home"
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

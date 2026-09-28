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
  export OMPCODE_CENTOS7_OFFLINE=1
else
  unset OMPCODE_CENTOS7_OFFLINE
fi

if ((home_requested)); then
  if [[ "$home_override" != /* ]]; then
    echo 'OmpCode: --home requires an absolute directory.' >&2
    exit 2
  fi
  data_base=$(readlink -m -- "$home_override")
  canonical_home=$(readlink -f -- "$HOME")
  case "$data_base" in
    "$canonical_home"|"$canonical_home/.ompcode"|"$canonical_home/.ompcode/"*)
      echo 'OmpCode: --home cannot be ~ or inside ~/.ompcode.' >&2
      exit 2
      ;;
  esac
  data_target="$data_base/.ompcode"
  data_link="$HOME/.ompcode"
  if [[ -L "$data_link" ]]; then
    if [[ "$(readlink -m -- "$data_link")" != "$(readlink -m -- "$data_target")" ]]; then
      echo 'OmpCode: ~/.ompcode already links to another location.' >&2
      exit 2
    fi
  elif [[ -e "$data_link" ]]; then
    echo 'OmpCode: ~/.ompcode already exists; move its data before using --home.' >&2
    exit 2
  fi
  mkdir -p -- "$data_target"
  if [[ ! -L "$data_link" ]]; then
    ln -s -- "$data_target" "$data_link"
  fi
fi
exec "$app/zcode" --no-sandbox "${desktop_args[@]}"

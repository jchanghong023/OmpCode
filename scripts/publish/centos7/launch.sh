#!/bin/bash
set -euo pipefail

for arg in "$@"; do
  case "$arg" in
    --help|-h)
      cat <<'HELP'
用法：bin/ompcode-centos7 [选项] [桌面程序参数...]

  --home <绝对路径>   将 OmpCode 和内嵌 omp 的数据存放在该目录下
  --profile <名称>   选择内嵌 omp 的配置（也支持 --profile=名称）
  --offline          让内嵌 omp 离线运行
  -h, --help         显示此帮助并退出

其他参数会传递给桌面程序。桌面应用始终遵守本地网络边界；
--offline 仅控制内嵌 omp。使用 --home 时不会覆盖已有的 ~/.ompcode 或 ~/.omp。
HELP
      exit 0
      ;;
  esac
done

package_root=$(dirname "$(dirname "$(readlink -f "$0")")")
app="$package_root/app"
# CentOS 7 桌面端默认只访问本机和内网；omp 自身的联网模式由 --offline 单独决定。
export OMPCODE_CENTOS7_LOCAL_ONLY=1
unset ZCODE_ARMS_RUM_ENDPOINT ZCODE_TELEMETRY_REPORT_ENDPOINT
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
# 修复说明：CentOS 7 的 bash 4.2 在 set -u 下展开空数组 "${arr[@]}" 会误报 unbound
# variable，导致无参数启动直接失败；${arr[@]+"${arr[@]}"} 是 4.2 兼容的惯用替代。
# CentOS 7 的目标环境没有 GPU；禁用 Chromium 硬件加速，仍允许软件渲染。
exec "$app/zcode" --no-sandbox --disable-gpu ${desktop_args[@]+"${desktop_args[@]}"}

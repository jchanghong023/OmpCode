#!/bin/bash
set -euo pipefail

if [[ $# -ne 5 ]]; then
  echo "Usage: $0 <linux-unpacked> <ubuntu-rootfs> <static-proot> <version> <output-dir>" >&2
  exit 2
fi
app=$(realpath "$1")
runtime=$(realpath "$2")
proot=$(realpath "$3")
version=$4
output=$(realpath -m "$5")
repo=$(realpath "$(dirname "$0")/../../..")
[[ $version =~ ^[0-9]+\.[0-9]+\.[0-9]+$ ]] || { echo 'Invalid RPM version.' >&2; exit 2; }
[[ -x "$app/zcode" && -x "$app/resources/glm/omp/omp" && -f "$app/resources/app.asar" ]] || {
  echo 'Unpacked desktop is incomplete or embedded omp is not executable.' >&2
  exit 1
}
[[ -f "$runtime/lib64/ld-linux-x86-64.so.2" && -x "$proot" ]] || {
  echo 'Isolated runtime or static PRoot is missing.' >&2
  exit 1
}
command -v rpmbuild >/dev/null
mkdir -p "$output"
work=$(mktemp -d)
trap 'rm -rf "$work"' EXIT
mkdir -p "$work"/{BUILD,BUILDROOT,RPMS,SOURCES,SPECS,SRPMS}

cat > "$work/SPECS/ompcode-centos7.spec" <<EOF
Name: ompcode-centos7
Version: $version
Release: 1.el7
Summary: OmpCode desktop with isolated runtime for CentOS 7 x64
License: Apache-2.0 and GPLv2+ and other bundled licenses
BuildArch: x86_64
AutoReqProv: no
Requires: /bin/bash
%global _build_id_links none
# 修复依据：RPM 默认 brp-strip 会改写已经打包并校验过的 omp/Electron ELF；保留原始二进制。
%global __os_install_post %{nil}
%description
OmpCode desktop with a private Linux userspace. Chromium sandboxing is unavailable
under PRoot; use only with trusted workspaces.
%install
# 修复依据：rpmbuild 的 %install 使用 /bin/sh（Ubuntu 下为 dash），不支持 Bash 花括号展开。
mkdir -p %{buildroot}/opt/ompcode-centos7/app %{buildroot}/opt/ompcode-centos7/runtime %{buildroot}/opt/ompcode-centos7/bin
cp -a "$app/." %{buildroot}/opt/ompcode-centos7/app/
cp -a "$runtime/." %{buildroot}/opt/ompcode-centos7/runtime/
install -m 755 "$proot" %{buildroot}/opt/ompcode-centos7/proot
install -m 755 "$repo/scripts/publish/centos7/launch.sh" %{buildroot}/opt/ompcode-centos7/bin/ompcode-centos7
mkdir -p %{buildroot}/usr/share/applications %{buildroot}/usr/share/icons/hicolor/128x128/apps
install -m 644 "$repo/public/logo/icons/128x128.png" %{buildroot}/usr/share/icons/hicolor/128x128/apps/ompcode-centos7.png
cat > %{buildroot}/usr/share/applications/ompcode-centos7.desktop <<'DESKTOP'
[Desktop Entry]
Type=Application
Name=OmpCode (CentOS 7)
Exec=/opt/ompcode-centos7/bin/ompcode-centos7 %U
Icon=ompcode-centos7
Categories=Development;IDE;
MimeType=x-scheme-handler/zcode;
Terminal=false
DESKTOP
%files
/opt/ompcode-centos7
/usr/share/applications/ompcode-centos7.desktop
/usr/share/icons/hicolor/128x128/apps/ompcode-centos7.png
EOF
rpmbuild -bb --define "_topdir $work" --define '_binary_payload w7.xzdio' "$work/SPECS/ompcode-centos7.spec"
artifact="$work/RPMS/x86_64/ompcode-centos7-$version-1.el7.x86_64.rpm"
[[ -s "$artifact" ]] || { echo 'RPM build produced no artifact.' >&2; exit 1; }
cp "$artifact" "$output/OmpCode-$version-centos7-x64.rpm"

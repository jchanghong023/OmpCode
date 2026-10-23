FROM quay.io/pypa/manylinux2014_x86_64@sha256:3a591c1109773dbd79f16c038588fd1867d9f2f708b360dab5715852c7f96ef0

# Frozen CentOS 7.9.2009 vault snapshots, never the runner's modern distribution.
# Image override, if configured, must itself be an immutable sha256 reference.
RUN printf '%s\n' \
    '[centos7-base]' 'name=CentOS 7.9.2009 base' \
    'baseurl=https://vault.centos.org/7.9.2009/os/x86_64/' \
    'enabled=1' 'gpgcheck=1' 'gpgkey=file:///etc/pki/rpm-gpg/RPM-GPG-KEY-CentOS-7' \
    '[centos7-updates]' 'name=CentOS 7.9.2009 updates' \
    'baseurl=https://vault.centos.org/7.9.2009/updates/x86_64/' \
    'enabled=1' 'gpgcheck=1' 'gpgkey=file:///etc/pki/rpm-gpg/RPM-GPG-KEY-CentOS-7' \
    '[centos7-extras]' 'name=CentOS 7.9.2009 extras' \
    'baseurl=https://vault.centos.org/7.9.2009/extras/x86_64/' \
    'enabled=1' 'gpgcheck=1' 'gpgkey=file:///etc/pki/rpm-gpg/RPM-GPG-KEY-CentOS-7' \
    '[centos7-sclo-rh]' 'name=CentOS 7.9.2009 GCC 11' \
    'baseurl=https://vault.centos.org/7.9.2009/sclo/x86_64/rh/' \
    'enabled=1' 'gpgcheck=1' 'gpgkey=https://www.centos.org/keys/RPM-GPG-KEY-CentOS-SIG-SCLo' \
    > /etc/yum.repos.d/centos7-native-vault.repo \
 && yum --disablerepo='*' --enablerepo='centos7-*' install -y \
    devtoolset-11-gcc devtoolset-11-gcc-c++ make binutils file curl tar xz rpm cpio \
    pkgconfig autoconf automake libtool \
    gtk3 atk at-spi2-atk at-spi2-core pango cairo gdk-pixbuf2 \
    libX11 libXcomposite libXdamage libXext libXfixes libXi libXrandr libXrender libXtst \
    libxcb libxkbcommon libxkbcommon-x11 nss nspr alsa-lib mesa-libgbm libdrm \
    fontconfig freetype libstdc++ libgcc \
 && yum clean all

ENV PYTHON=/opt/python/cp311-cp311/bin/python3.11
ENV PATH=/toolchain/bin:/opt/python/cp311-cp311/bin:/usr/local/sbin:/usr/local/bin:/usr/sbin:/usr/bin:/sbin:/bin
WORKDIR /workspace

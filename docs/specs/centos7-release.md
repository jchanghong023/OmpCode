# CentOS 7 x64 release

## Product behavior

- A separate, manually dispatched `release-centos7.yml` builds a single self-contained CentOS 7 x64 ZIP from `main`. Its inputs mirror the Windows workflow: a unique tag and a prerelease flag. The CentOS 7 tag uses a distinct `v<package.json version>-omp.<positive integer>-centos7` suffix, so either pipeline can run first without claiming the other's tag or release. It does not run tests. Windows release packaging and the existing RHEL 8+ RPM stay unchanged.
- Publish the ZIP and its SHA256 file to a separate GitHub Release for that tag. An already existing tag/release fails rather than replacing assets; historical RPM releases remain historical, not an install path for the rootless build.
- The ZIP extracts entirely under a user-writable directory and runs without root, package-manager operations, network access or additional installed runtime packages. It contains Electron, embedded omp, an isolated Linux userspace, and PRoot. It must not replace the host's glibc, Node, omp, existing OmpCode RPM, or Windows artifacts.

## Ownership and boundaries

- GitHub Actions owns release tag validation, build inputs, asset checksums and publication. The CentOS 7 packaging script owns the portable ZIP layout and preserved symlinks/executable modes. The launcher resolves the extraction directory and owns only the process-local compatibility environment: a pinned Ubuntu 24.04 userspace and a pinned static PRoot binary. No business/session state belongs to these components; Electron and omp retain their existing state and protocol ownership in the user's home directory.
- Native Linux artifacts require newer glibc than CentOS 7 provides. The isolated runtime must contain Electron's runtime libraries and CJK fonts for readable Chinese UI; the host still supplies a Linux kernel, `ptrace`, a graphical session (X11/Wayland), and an archive extractor. No host glibc, Node, omp, font, or library installation is part of the run path.
- PRoot's seccomp acceleration crashes on a tested native CentOS 7 kernel `3.10.0-1160.el7.x86_64`; the launcher disables this acceleration for its child process with `PROOT_NO_SECCOMP=1` and uses the ptrace-only path. PRoot cannot provide Chromium's setuid sandbox, so the launcher starts Electron with `--no-sandbox`; this is an explicit security limitation of this compatibility package. Environments that disallow `ptrace` cannot use it.
- The isolated userspace contains no setuid/setgid files. The pinned static PRoot binary's corresponding source revision and its pinned uthash submodule are included in the ZIP under `runtime/usr/share/doc/proot`.
- HOME, temporary files, display sockets and a safe invocation working directory remain visible to the app; other workspace roots require an explicit bind via the launcher interface. Never bind a host system directory over the guest `/`, `/usr`, `/lib*`, `/etc`, `/opt`, `/var`, or virtual filesystems: a reserved invocation directory falls back to HOME, while an explicit unsafe bind fails. Fail on missing package/runtime resources rather than falling back to the host's incompatible glibc.
- The portable ZIP does not install a desktop entry or register `zcode://` on the host. Guest XDG config/data paths are private; the shared `~/.ompcode` and omp profile remain under HOME.

## Acceptance

- On a native CentOS 7 x64 system with a graphical session and `ptrace`, a non-root user extracts the ZIP under HOME and starts its launcher without installing any other package or changing host libraries. The desktop UI opens and the embedded omp runs in the isolated userspace on kernel 3.10.
- The archive preserves executable Electron, launcher, embedded omp, and runtime symlinks. Relocating the extracted directory does not break launch. The existing regular Linux OmpCode package and user's installed omp remain untouched.
- The release workflow rejects a wrong branch/tag/version or a tag collision, checks uploaded file integrity, and never calls a test command. The existing Windows workflow stays unchanged.

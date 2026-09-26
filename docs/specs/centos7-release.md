# CentOS 7 x64 release

## Product behavior

- A separate, manually dispatched `release-centos7.yml` builds a CentOS 7 x64 RPM from `main`. Its inputs mirror the Windows workflow: a unique tag and a prerelease flag. The CentOS 7 tag uses a distinct `v<package.json version>-omp.<positive integer>-centos7` suffix, so either pipeline can run first without claiming the other's tag or release. It does not run tests. Windows release packaging and the existing RHEL 8+ RPM stay unchanged.
- Publish the CentOS 7 RPM and its SHA256 file to a separate GitHub Release for that tag. An already existing tag/release fails rather than replacing assets.
- The RPM installs its own Electron application, embedded omp, and isolated Linux userspace. It must not replace the host's glibc, Node, omp, existing OmpCode RPM, or Windows artifacts. Package name, executable and desktop entry are distinct from the existing Linux package.

## Ownership and boundaries

- GitHub Actions owns release tag validation, build inputs, asset checksums and publication. The CentOS 7 packaging script owns RPM layout. The launcher owns only the process-local compatibility environment: a pinned Ubuntu 24.04 userspace and a pinned static PRoot binary. No business/session state belongs to these components; Electron and omp retain their existing state and protocol ownership in the user's home directory.
- Native Linux artifacts require newer glibc than CentOS 7 provides. RPM automatic ELF dependencies must not leak requirements from the isolated userspace into the host package manager. The isolated runtime must contain all Electron runtime libraries; the host still supplies a Linux kernel and a graphical session (X11/Wayland).
- PRoot uses `ptrace` and cannot provide Chromium's setuid sandbox. The CentOS 7 launcher therefore starts Electron with `--no-sandbox`; this is an explicit security limitation of this compatibility package, not a change to other builds. Environments that disallow `ptrace` cannot use this package.
- The isolated userspace contains no setuid/setgid files. The pinned static PRoot binary's corresponding source revision and its pinned uthash submodule are included in the RPM under `runtime/usr/share/doc/proot`.
- HOME, temporary files, display sockets and a safe invocation working directory remain visible to the app; other workspace roots require an explicit bind via the launcher interface. Never bind a host system directory over the guest `/`, `/usr`, `/lib*`, `/etc`, `/opt`, `/var`, or virtual filesystems: a reserved invocation directory falls back to HOME, while an explicit unsafe bind fails. Fail on missing package/runtime resources rather than falling back to the host's incompatible glibc.
- The package's desktop entry provides the existing `zcode://` handler through the host launcher. On launch, best-effort host `xdg-mime` selects this entry (the shared scheme still follows the last-launched-app rule); guest XDG config/data paths are private so its internal registration cannot write an invalid guest executable path into another Linux install's user desktop entry. The shared `~/.ompcode` and omp profile remain under HOME.

## Acceptance

- On a CentOS 7 x64 system with a graphical session and `ptrace`, the RPM installs without pulling glibc 2.28+ or replacing host libraries. Launching its separate command opens the desktop UI, and its embedded omp runs in the isolated userspace.
- The RPM has executable Electron, launcher, and embedded omp; its payload carries the isolated runtime and pinned PRoot. The desktop entry points to the separate command. Installation and uninstall leave the regular Linux OmpCode package and user's installed omp alone.
- The release workflow rejects a wrong branch/tag/version or a tag collision, checks uploaded file integrity, and never calls a test command. The existing Windows workflow stays unchanged.

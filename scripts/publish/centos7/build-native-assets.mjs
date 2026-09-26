import { execFileSync } from "node:child_process";
import {
  chmodSync,
  copyFileSync,
  existsSync,
  mkdirSync,
  readFileSync,
  realpathSync,
  rmSync,
  statSync,
} from "node:fs";
import { writeFile } from "node:fs/promises";
import { dirname, join, resolve } from "node:path";
import process from "node:process";
import { createRequire } from "node:module";
import { buildNativeSearchToolsUnix } from "../../native-search-tools-unix.mjs";

const [repoRootArg] = process.argv.slice(2);
if (!repoRootArg) throw new Error("Usage: build-native-assets.sh <repository-root>");
const repoRoot = resolve(repoRootArg);
const desktopRoot = join(repoRoot, "packages/desktop");
const stagingRoot = join(desktopRoot, "dist/centos7-native");
const appRoot = join(stagingRoot, "app");
const expectedElectron = "28.3.3";

function run(command, args, options = {}) {
  console.log(`==> ${command} ${args.join(" ")}`);
  execFileSync(command, args, { stdio: "inherit", ...options });
}

function readCapture(command, args) {
  return execFileSync(command, args, { encoding: "utf8" }).trim();
}

function assertBuilder() {
  if (process.platform !== "linux" || process.arch !== "x64") {
    throw new Error(
      `CentOS 7 assets require an x64 Linux builder; got ${process.platform}-${process.arch}`,
    );
  }
  if (process.versions.node !== "20.19.0") {
    throw new Error(
      `CentOS 7 asset preparation requires Node 20.19.0; got ${process.versions.node}`,
    );
  }
  const glibc = readCapture("getconf", ["GNU_LIBC_VERSION"]).replace(/^glibc\s+/u, "");
  const cc = readCapture(process.env.CC ?? "gcc", ["-dumpfullversion"]);
  const cxx = readCapture(process.env.CXX ?? "g++", ["-dumpfullversion"]);
  if (glibc !== "2.17" || !cc.startsWith("11.") || !cxx.startsWith("11.")) {
    throw new Error(
      `Builder must be glibc 2.17 with GCC/G++ 11; got glibc ${glibc}, GCC ${cc}, G++ ${cxx}`,
    );
  }
  for (const binary of ["make", "readelf", "file", "pnpm"]) {
    run("bash", ["-lc", `command -v ${binary} >/dev/null`]);
  }
  console.log(
    `==> CentOS native builder: Node ${process.versions.node}, glibc ${glibc}, GCC ${cc}, G++ ${cxx}`,
  );
}

function packageRootFromEntry(entry, packageName) {
  let current = dirname(realpathSync(entry));
  while (current !== dirname(current)) {
    const manifestPath = join(current, "package.json");
    if (existsSync(manifestPath)) {
      const manifest = JSON.parse(readFileSync(manifestPath, "utf8"));
      if (manifest.name === packageName) return current;
    }
    current = dirname(current);
  }
  throw new Error(`Unable to find package root for ${packageName} from ${entry}`);
}

function assertPackageVersion(packageRoot, name, expected) {
  const manifest = JSON.parse(readFileSync(join(packageRoot, "package.json"), "utf8"));
  if (manifest.version !== expected) {
    throw new Error(`Expected ${name}@${expected}; found ${manifest.version} at ${packageRoot}`);
  }
}

function verifyGlibcSymbols(binaryPath) {
  const versions = readCapture("readelf", ["--version-info", "--wide", binaryPath]);
  const required = [...versions.matchAll(/\bGLIBC_(\d+(?:\.\d+)+)\b/gu)]
    .map((match) => match[1])
    .sort((a, b) => {
      const left = a.split(".").map(Number);
      const right = b.split(".").map(Number);
      for (let index = 0; index < Math.max(left.length, right.length); index += 1) {
        const difference = (left[index] ?? 0) - (right[index] ?? 0);
        if (difference !== 0) return difference;
      }
      return 0;
    });
  if (required.length === 0) throw new Error(`${binaryPath} has no versioned GLIBC symbols`);
  const tooNew = required.find((version) => {
    const [major, minor] = version.split(".").map(Number);
    return major > 2 || (major === 2 && minor > 17);
  });
  if (tooNew)
    throw new Error(
      `${binaryPath} requires GLIBC_${tooNew}, above the CentOS 7 GLIBC_2.17 baseline`,
    );
  const dynamic = readCapture("readelf", ["--dynamic", "--wide", binaryPath]);
  if (/NEEDED.*\blib(?:stdc\+\+|gcc_s)\.so/iu.test(dynamic)) {
    throw new Error(
      `${binaryPath} dynamically requires the GCC 11 C++ runtime; CentOS 7 has an older runtime`,
    );
  }
}

function copyNativeAddon(sourcePath, relativeOutputPath) {
  if (!existsSync(sourcePath) || !statSync(sourcePath).isFile()) {
    throw new Error(`Required native addon was not built: ${sourcePath}`);
  }
  verifyGlibcSymbols(sourcePath);
  const destination = join(appRoot, relativeOutputPath);
  mkdirSync(dirname(destination), { recursive: true });
  copyFileSync(sourcePath, destination);
  chmodSync(destination, 0o755);
  console.log(`==> Staged ${destination}`);
}

assertBuilder();
const requireFromDesktop = createRequire(join(desktopRoot, "package.json"));
const ptyEntry = requireFromDesktop.resolve("node-pty");
const ptyRoot = packageRootFromEntry(ptyEntry, "node-pty");
const ssh2Entry = requireFromDesktop.resolve("ssh2");
const ssh2Root = packageRootFromEntry(ssh2Entry, "ssh2");
const requireFromSsh2 = createRequire(ssh2Entry);
const cpuFeaturesEntry = requireFromSsh2.resolve("cpu-features");
const cpuFeaturesRoot = packageRootFromEntry(cpuFeaturesEntry, "cpu-features");
const betterSqliteEntry = requireFromDesktop.resolve("better-sqlite3");
const betterSqliteRoot = packageRootFromEntry(betterSqliteEntry, "better-sqlite3");
const cryptoRoot = join(ssh2Root, "lib/protocol/crypto");
assertPackageVersion(ptyRoot, "node-pty", "1.1.0");
assertPackageVersion(cpuFeaturesRoot, "cpu-features", "0.0.10");
assertPackageVersion(betterSqliteRoot, "better-sqlite3", "9.6.0");
// cpu-features 的 install 生命周期生成 buildcheck.gypi；workspace 安装禁用脚本时必须补齐。
await writeFile(
  join(cpuFeaturesRoot, "buildcheck.gypi"),
  execFileSync(process.execPath, [join(cpuFeaturesRoot, "buildcheck.js")], {
    cwd: cpuFeaturesRoot,
    encoding: "utf8",
  }),
);

run(
  "pnpm",
  [
    "--dir",
    desktopRoot,
    "exec",
    "electron-rebuild",
    "--force",
    "--only",
    "node-pty",
    "--version",
    expectedElectron,
    "--arch",
    "x64",
    "--module-dir",
    ".",
  ],
  { cwd: repoRoot },
);

const rebuildEntry = requireFromDesktop.resolve("@electron/rebuild");
const requireFromRebuild = createRequire(rebuildEntry);
const nodeGypScript = requireFromRebuild.resolve("node-gyp/bin/node-gyp.js");
// electron-rebuild 会把 cpu-features 生成到 bin/，但其运行时读取 build/Release/cpufeatures.node。
// 用同一套 Electron header 直接执行 node-gyp，保持 upstream require() 的实际路径。
run(
  process.execPath,
  [
    nodeGypScript,
    "rebuild",
    `--target=${expectedElectron}`,
    "--dist-url=https://electronjs.org/headers",
    "--arch=x64",
  ],
  { cwd: cpuFeaturesRoot },
);
// npm 包自带的 better-sqlite3 预编译产物需要 GLIBC_2.28；用本机 GCC 11 从源码构建。
// configure/build 可复用中断后的 SQLite amalgamation 对象，重建整个树会重复漫长的单文件编译。
run(
  process.execPath,
  [
    nodeGypScript,
    "configure",
    `--target=${expectedElectron}`,
    "--dist-url=https://electronjs.org/headers",
    "--arch=x64",
  ],
  { cwd: betterSqliteRoot },
);
run(process.execPath, [nodeGypScript, "build"], { cwd: betterSqliteRoot });
// Electron 的 header archive 不含 OpenSSL 头；同为 OpenSSL 3 的 glibc17 Node 工具链提供头文件。
const runtimeHeaders = join(dirname(dirname(process.execPath)), "include/node");
if (
  process.versions.openssl?.split(".")[0] !== "3" ||
  !existsSync(join(runtimeHeaders, "openssl/configuration.h"))
) {
  throw new Error("SSH native crypto requires the Node 20 OpenSSL 3 development headers");
}
rmSync(join(cryptoRoot, "build"), { recursive: true, force: true });
run(
  process.execPath,
  [
    nodeGypScript,
    "rebuild",
    `--target=${expectedElectron}`,
    "--dist-url=https://electronjs.org/headers",
    "--arch=x64",
    "--real_openssl_major=3",
  ],
  {
    cwd: cryptoRoot,
    env: {
      ...process.env,
      CPPFLAGS: `${process.env.CPPFLAGS ?? ""} -I${runtimeHeaders}`.trim(),
    },
  },
);

const ptyAddon = join(ptyRoot, "build/Release/pty.node");
const cpuAddon = join(cpuFeaturesRoot, "build/Release/cpufeatures.node");
const sqliteAddon = join(betterSqliteRoot, "build/Release/better_sqlite3.node");
const sshCryptoAddon = join(cryptoRoot, "build/Release/sshcrypto.node");
copyNativeAddon(ptyAddon, "node_modules/node-pty/prebuilds/linux-x64/pty.node");
copyNativeAddon(cpuAddon, "node_modules/cpu-features/build/Release/cpufeatures.node");
copyNativeAddon(sqliteAddon, "node_modules/better-sqlite3/build/Release/better_sqlite3.node");
copyNativeAddon(
  sshCryptoAddon,
  "node_modules/ssh2/lib/protocol/crypto/build/Release/sshcrypto.node",
);

buildNativeSearchToolsUnix({
  platform: "linux",
  arch: "x64",
  outputDir: join(appRoot, "resources/tools"),
  centos7Baseline: true,
  quiet: true,
});

for (const executable of ["resources/tools/bfs/bfs", "resources/tools/ugrep/ugrep"]) {
  const binaryPath = join(appRoot, executable);
  if (!existsSync(binaryPath) || !statSync(binaryPath).isFile()) {
    throw new Error(`Required native search binary was not staged: ${binaryPath}`);
  }
  verifyGlibcSymbols(binaryPath);
}
console.log(`==> CentOS 7 native assets ready: ${stagingRoot}`);

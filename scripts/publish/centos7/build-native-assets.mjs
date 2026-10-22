import { execFile } from "node:child_process";
import { createHash } from "node:crypto";
import { createReadStream } from "node:fs";
import {
  chmod,
  copyFile,
  lstat,
  mkdir,
  mkdtemp,
  readFile,
  readdir,
  realpath,
  rm,
  writeFile,
} from "node:fs/promises";
import { createRequire } from "node:module";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { promisify } from "node:util";
import { buildNativeSearchToolsUnix } from "../../native-search-tools-unix.mjs";

const exec = promisify(execFile);
const expectedElectron = "28.3.3";
const headersUrl =
  "https://artifacts.electronjs.org/headers/dist/v28.3.3/node-v28.3.3-headers.tar.gz";
const headersSha256 = "fd12e36ec3278b99d80c422c2c1c593ccf6fabce2dea75c14d34a0e5cd3b80b4";
const repoRoot = resolve(process.argv[2] ?? fileURLToPath(new URL("../../../", import.meta.url)));
if (process.argv.length > 3) throw new Error("Usage: build-native-assets.sh [repository-root]");
const desktopRoot = join(repoRoot, "packages/desktop");
const stagingRoot = join(desktopRoot, "dist/centos7-native");
const appRoot = join(stagingRoot, "app");

async function capture(command, args, options = {}) {
  const result = await exec(command, args, { maxBuffer: 64 * 1024 * 1024, ...options });
  return result.stdout.trim();
}

async function run(command, args, options = {}) {
  console.log(`==> ${command} ${args.join(" ")}`);
  const result = await exec(command, args, { maxBuffer: 64 * 1024 * 1024, ...options });
  if (result.stdout) process.stdout.write(result.stdout);
  if (result.stderr) process.stderr.write(result.stderr);
}

async function digest(path) {
  const hash = createHash("sha256");
  for await (const chunk of createReadStream(path)) hash.update(chunk);
  return hash.digest("hex");
}

async function assertBuilder() {
  if (
    process.platform !== "linux" ||
    process.arch !== "x64" ||
    process.versions.node !== "20.19.0"
  ) {
    throw new Error(
      `Native builder requires linux-x64 Node 20.19.0; got ${process.platform}-${process.arch} Node ${process.versions.node}`,
    );
  }
  const glibc = (await capture("getconf", ["GNU_LIBC_VERSION"])).replace(/^glibc\s+/u, "");
  const gcc = await capture(process.env.CC || "gcc", ["-dumpfullversion"]);
  const gxx = await capture(process.env.CXX || "g++", ["-dumpfullversion"]);
  if (glibc !== "2.17" || !gcc.startsWith("11.") || !gxx.startsWith("11.")) {
    throw new Error(
      `Native builder requires glibc 2.17 and GCC/G++ 11; got ${glibc}, ${gcc}, ${gxx}`,
    );
  }
  return { node: process.versions.node, glibc, gcc, gxx };
}

async function packageRoot(entry, expectedName, expectedVersion) {
  let current = dirname(await realpath(entry));
  while (current !== dirname(current)) {
    let manifest;
    try {
      manifest = JSON.parse(await readFile(join(current, "package.json"), "utf8"));
    } catch (error) {
      if (error.code !== "ENOENT") throw error;
    }
    if (manifest?.name === expectedName) {
      if (expectedVersion && manifest.version !== expectedVersion) {
        throw new Error(`Expected ${expectedName}@${expectedVersion}; got ${manifest.version}`);
      }
      return current;
    }
    current = dirname(current);
  }
  throw new Error(`Cannot resolve package root for ${expectedName}`);
}

async function stageFile(source, relativeOutput) {
  if (!(await lstat(source)).isFile())
    throw new Error(`Required freshly built asset is missing: ${source}`);
  const target = join(appRoot, relativeOutput);
  await mkdir(dirname(target), { recursive: true });
  await copyFile(source, target);
  await chmod(target, 0o755);
  return { path: `app/${relativeOutput}`, sha256: await digest(target) };
}

async function copyLicenses(source, target) {
  for (const entry of await readdir(source, { withFileTypes: true })) {
    if (
      !entry.isFile() ||
      !/^(?:licen[cs]e|copying|copyright|notice)(?:[._-]|$)/iu.test(entry.name)
    )
      continue;
    await mkdir(target, { recursive: true });
    await copyFile(join(source, entry.name), join(target, entry.name));
  }
}

const builder = await assertBuilder();
const requireDesktop = createRequire(join(desktopRoot, "package.json"));
const ssh2Entry = requireDesktop.resolve("ssh2");
const requireSsh2 = createRequire(ssh2Entry);
const modules = [
  {
    name: "node-pty",
    version: "1.1.0",
    entry: requireDesktop.resolve("node-pty"),
    file: "pty.node",
    output: "node_modules/node-pty/prebuilds/linux-x64/pty.node",
  },
  {
    name: "cpu-features",
    version: "0.0.10",
    entry: requireSsh2.resolve("cpu-features"),
    file: "cpufeatures.node",
    output: "node_modules/cpu-features/build/Release/cpufeatures.node",
  },
  {
    name: "better-sqlite3",
    version: "9.6.0",
    entry: requireDesktop.resolve("better-sqlite3"),
    file: "better_sqlite3.node",
    output: "node_modules/better-sqlite3/build/Release/better_sqlite3.node",
  },
];
const rebuildRoot = await packageRoot(
  requireDesktop.resolve("@electron/rebuild"),
  "@electron/rebuild",
);
// 当前 electron-rebuild 4 需要 Node 22；只复用其支持 Node 20 的 node-gyp，不执行高版本 CLI。
const nodeGyp = createRequire(join(rebuildRoot, "package.json")).resolve(
  "node-gyp/bin/node-gyp.js",
);
const nodeGypRoot = await packageRoot(nodeGyp, "node-gyp", "11.5.0");
await rm(stagingRoot, { recursive: true, force: true });
await mkdir(appRoot, { recursive: true });
const work = await mkdtemp(join(tmpdir(), "ompcode-centos7-native-"));
try {
  const archive = join(work, "electron-headers.tar.gz");
  await run("curl", ["--fail", "--location", "--output", archive, headersUrl]);
  if ((await digest(archive)) !== headersSha256)
    throw new Error("Electron 28.3.3 headers SHA256 mismatch");
  const headers = join(work, "headers");
  await mkdir(headers, { recursive: true });
  await run("tar", ["-xzf", archive, "-C", headers, "--strip-components=1"]);
  const versionHeader = await readFile(join(headers, "include/node/node_version.h"), "utf8");
  if (!/^#define\s+NODE_MODULE_VERSION\s+119\b/mu.test(versionHeader)) {
    throw new Error("Electron 28 headers must declare NODE_MODULE_VERSION 119");
  }
  const files = [];
  for (const module of modules) {
    const root = await packageRoot(module.entry, module.name, module.version);
    // 清除宿主 prebuild 和旧对象后重建，不能让 Node 20 ABI 或现代 glibc 产物伪装成成功结果。
    await rm(join(root, "build"), { recursive: true, force: true });
    if (module.name === "cpu-features") {
      const generated = await capture(process.execPath, [join(root, "buildcheck.js")], {
        cwd: root,
      });
      await writeFile(join(root, "buildcheck.gypi"), `${generated}\n`);
    }
    await run(
      process.execPath,
      [nodeGyp, "rebuild", `--target=${expectedElectron}`, `--nodedir=${headers}`, "--arch=x64"],
      { cwd: root },
    );
    files.push(await stageFile(join(root, "build/Release", module.file), module.output));
    if (module.name === "node-pty") {
      // 上游仅在需要的平台生成 helper；有产物时必须与 .node 使用同一目标目录，不能回灌预编译包。
      for (const entry of await readdir(join(root, "build/Release"), { withFileTypes: true })) {
        if (entry.isFile() && /^(?:spawn-helper|pty-helper)$/u.test(entry.name)) {
          files.push(
            await stageFile(
              join(root, "build/Release", entry.name),
              `node_modules/node-pty/prebuilds/linux-x64/${entry.name}`,
            ),
          );
        }
      }
    }
    await copyLicenses(root, join(stagingRoot, "licenses/native", module.name));
  }
  // Electron 28 使用 OpenSSL 1.1.1，native 宿主是 OpenSSL 3；ssh2 只能保留内建 crypto 的 JS 路径。
  // 新 stage 从空目录建立，不构建/复制 sshcrypto.node；asar 中移除由 ZIP 装配所有者负责。
  const sshRoot = await packageRoot(ssh2Entry, "ssh2");
  await copyLicenses(sshRoot, join(stagingRoot, "licenses/native/ssh2"));
  await buildNativeSearchToolsUnix({
    platform: "linux",
    arch: "x64",
    outputDir: join(appRoot, "resources/tools"),
    centos7Baseline: true,
    quiet: true,
    runUpstreamTests: false,
    licenseDir: join(stagingRoot, "licenses/search"),
  });
  await writeFile(
    join(stagingRoot, "native-build-manifest.json"),
    `${JSON.stringify(
      {
        schemaVersion: 1,
        builder,
        electron: expectedElectron,
        electronModuleAbi: 119,
        headers: { url: headersUrl, sha256: headersSha256 },
        lockfileSha256: await digest(join(repoRoot, "pnpm-lock.yaml")),
        nodeGyp: JSON.parse(await readFile(join(nodeGypRoot, "package.json"), "utf8")).version,
        modules: modules.map(({ name, version }) => ({ name, version })),
        files,
      },
      null,
      2,
    )}\n`,
  );
  await run(process.execPath, [
    join(repoRoot, "scripts/publish/centos7/build-plugin-native-assets.mjs"),
    repoRoot,
    stagingRoot,
    headers,
    nodeGyp,
  ]);
  await run(process.execPath, [
    join(repoRoot, "scripts/publish/centos7/collect-runtime-assets.mjs"),
    stagingRoot,
    desktopRoot,
  ]);
  await run("python3", [join(repoRoot, "scripts/publish/centos7/verify-elf.py"), stagingRoot]);
  console.log(`==> CentOS 7 native assets ready: ${stagingRoot}`);
} finally {
  await rm(work, { recursive: true, force: true });
}

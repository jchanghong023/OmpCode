import { execFileSync } from "node:child_process";
import { createRequire } from "node:module";
import { dirname, isAbsolute, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { access, copyFile, lstat, mkdir, mkdtemp, open, rm } from "node:fs/promises";
import { tmpdir } from "node:os";

import { replaceAppAsarFromStaging } from "../../../packages/desktop/scripts/app-asar-repack.mjs";

const expectedNativeAddons = [
  "node-pty/prebuilds/linux-x64/pty.node",
  "cpu-features/build/Release/cpufeatures.node",
  "ssh2/lib/protocol/crypto/build/Release/sshcrypto.node",
  "better-sqlite3/build/Release/better_sqlite3.node",
];

function usage() {
  throw new Error("Usage: node merge-app-asar.mjs <native-app-node_modules> <app-asar-path>");
}

async function assertDirectory(path, label) {
  const stat = await lstat(path);
  if (!stat.isDirectory() || stat.isSymbolicLink()) {
    throw new Error(`${label} must be a real directory: ${path}`);
  }
}

async function assertRegularFile(path) {
  const stat = await lstat(path);
  if (!stat.isFile() || stat.isSymbolicLink()) {
    throw new Error(`Required native addon is not a regular file: ${path}`);
  }
}
async function assertElfAddon(path) {
  const handle = await open(path, "r");
  try {
    const header = Buffer.alloc(4);
    const { bytesRead } = await handle.read(header, 0, header.length, 0);
    if (bytesRead !== header.length || !header.equals(Buffer.from([0x7f, 0x45, 0x4c, 0x46]))) {
      throw new Error(`Native addon is not an ELF binary: ${path}`);
    }
  } finally {
    await handle.close();
  }
}

function runAsarCommand(args) {
  execFileSync(process.execPath, [asarCliPath, ...args], { stdio: "inherit" });
}

const [nativeNodeModulesArg, appAsarArg, ...extraArgs] = process.argv.slice(2);
if (!nativeNodeModulesArg || !appAsarArg || extraArgs.length > 0) usage();
if (process.versions.node.split(".")[0] !== "24") {
  throw new Error(`This build-time CLI requires Node 24; received ${process.versions.node}`);
}
if (!isAbsolute(appAsarArg)) {
  throw new Error(`app-asar-path must be absolute: ${appAsarArg}`);
}

const nativeNodeModules = resolve(nativeNodeModulesArg);
const appAsarPath = resolve(appAsarArg);
if (appAsarPath === dirname(appAsarPath) || !appAsarPath.endsWith("/app.asar")) {
  throw new Error(`app-asar-path must name an app.asar file: ${appAsarPath}`);
}
await assertDirectory(nativeNodeModules, "Native node_modules source");
const asarStat = await lstat(appAsarPath);
if (!asarStat.isFile() || asarStat.isSymbolicLink()) {
  throw new Error(`app-asar-path must be an existing regular file: ${appAsarPath}`);
}
await assertDirectory(dirname(appAsarPath), "app.asar parent");

const desktopRoot = resolve(dirname(fileURLToPath(import.meta.url)), "../../../packages/desktop");
const requireFromDesktop = createRequire(join(desktopRoot, "package.json"));
const asarEntry = requireFromDesktop.resolve("@electron/asar");
const asarCliPath = resolve(dirname(asarEntry), "../bin/asar.mjs");
await access(asarCliPath);

const stagingDir = await mkdtemp(join(tmpdir(), "centos7-app-asar-"));
try {
  const extractedAppDir = join(stagingDir, "app");
  const stagedNodeModules = join(extractedAppDir, "node_modules");
  await mkdir(extractedAppDir, { recursive: true });
  runAsarCommand(["extract", appAsarPath, extractedAppDir]);
  await assertDirectory(stagedNodeModules, "Extracted app node_modules");

  for (const relativePath of expectedNativeAddons) {
    const source = join(nativeNodeModules, relativePath);
    const destination = join(stagedNodeModules, relativePath);
    await assertRegularFile(source);
    await assertRegularFile(destination).catch((error) => {
      if (error?.code !== "ENOENT") throw error;
    });
    await assertElfAddon(source);
    await mkdir(dirname(destination), { recursive: true });
    await copyFile(source, destination);
  }

  await replaceAppAsarFromStaging({
    sourceDir: extractedAppDir,
    appAsarPath,
    targetPlatformKey: "linux-x64",
    runAsarCommand,
  });

  for (const relativePath of expectedNativeAddons) {
    const unpackedNativePath = join(`${appAsarPath}.unpacked`, "node_modules", relativePath);
    await assertRegularFile(unpackedNativePath);
    await assertElfAddon(unpackedNativePath);
  }
  console.log(
    `CentOS 7 app.asar merged; verified ${expectedNativeAddons.length} ELF addons under ${appAsarPath}.unpacked/node_modules`,
  );
} finally {
  await rm(stagingDir, { recursive: true, force: true });
}

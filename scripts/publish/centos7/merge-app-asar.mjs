import { execFileSync } from "node:child_process";
import { createRequire } from "node:module";
import { dirname, join, resolve, basename } from "node:path";
import { fileURLToPath } from "node:url";
import { cp, lstat, mkdir, mkdtemp, open, readFile, readdir, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { replaceAppAsarFromStaging } from "../../../packages/desktop/scripts/app-asar-repack.mjs";
import { collectRuntimeModuleClosureEntries } from "../../../packages/desktop/scripts/runtime-dependency-closure.mjs";
import {
  findDesktopNativePackageViolations,
  parseAsarListWithPackState,
} from "../../../packages/desktop/scripts/desktop-native-package-policy.mjs";

const expected = [
  "node-pty/prebuilds/linux-x64/pty.node",
  "cpu-features/build/Release/cpufeatures.node",
  "better-sqlite3/build/Release/better_sqlite3.node",
];
const desktop = resolve(dirname(fileURLToPath(import.meta.url)), "../../../packages/desktop");
const require = createRequire(join(desktop, "package.json"));
const asarPackage = require.resolve("@electron/asar/package.json");
const asarManifest = JSON.parse(await readFile(asarPackage, "utf8"));
const asarCli = resolve(
  dirname(asarPackage),
  typeof asarManifest.bin === "string" ? asarManifest.bin : asarManifest.bin.asar,
);
function runAsarCommand(args) {
  return execFileSync(process.execPath, [asarCli, ...args], {
    encoding: "utf8",
    maxBuffer: 64 * 1024 * 1024,
  });
}
async function elf(path) {
  const stat = await lstat(path);
  if (!stat.isFile() || stat.size === 0) throw new Error(`Missing regular ELF addon: ${path}`);
  const handle = await open(path, "r");
  try {
    const header = Buffer.alloc(4);
    await handle.read(header, 0, 4, 0);
    if (!header.equals(Buffer.from([127, 69, 76, 70]))) throw new Error(`Not ELF: ${path}`);
  } finally {
    await handle.close();
  }
}
async function walk(root, visit) {
  for (const entry of await readdir(root, { withFileTypes: true })) {
    const path = join(root, entry.name);
    if (entry.isDirectory()) await walk(path, visit);
    else await visit(path, entry);
  }
}
const [nativeArg, asarArg, ...extra] = process.argv.slice(2);
if (!nativeArg || !asarArg || extra.length)
  throw new Error("Usage: node merge-app-asar.mjs <native-app-node_modules> <app-asar-path>");
if (process.versions.node.split(".")[0] !== "24")
  throw new Error("ASAR packaging requires build-time Node 24");
const native = resolve(nativeArg);
const archive = resolve(asarArg);
if (basename(archive) !== "app.asar" || !(await lstat(archive)).isFile())
  throw new Error("Expected existing app.asar");
for (const name of expected) await elf(join(native, name));
const temporary = await mkdtemp(join(tmpdir(), "centos7-asar-"));
try {
  const app = join(temporary, "app");
  await mkdir(app);
  runAsarCommand(["extract", archive, app]);
  const modules = join(app, "node_modules");
  // Explicitly promote the dev-only Windows fallback and its real JS dependency closure.
  const closure = collectRuntimeModuleClosureEntries(["better-sqlite3"], [desktop]);
  for (const entry of closure) {
    if (!entry.sourceModulePath)
      throw new Error(`Missing SQLite runtime dependency: ${entry.moduleName}`);
    const manifest = JSON.parse(await readFile(entry.packageJsonPath, "utf8"));
    if (entry.moduleName === "better-sqlite3" && manifest.version !== "9.6.0")
      throw new Error("CentOS SQLite must be exactly 9.6.0");
    const destination = join(modules, entry.moduleName);
    await rm(destination, { recursive: true, force: true });
    await cp(entry.sourceModulePath, destination, {
      recursive: true,
      dereference: true,
      filter: (path) =>
        path === entry.sourceModulePath ||
        !path
          .slice(entry.sourceModulePath.length + 1)
          .split(/[\\/]/)
          .includes("node_modules"),
    });
  }
  // Never permit restored @lydell host prebuilds, alternate ABI variants, or OpenSSL-3 sshcrypto.
  for (const module of ["better-sqlite3", "cpu-features", "node-pty"]) {
    const root = join(modules, module);
    await walk(root, async (path) => {
      if (path.endsWith(".node")) await rm(path);
    });
  }
  for (const name of [
    "better-sqlite3/build",
    "better-sqlite3/prebuilds",
    "cpu-features/build",
    "node-pty/build",
    "node-pty/bin",
    "node-pty/prebuilds",
  ]) {
    await rm(join(modules, name), { recursive: true, force: true });
  }
  try {
    for (const entry of await readdir(join(modules, "@lydell"))) {
      if (entry.startsWith("node-pty-"))
        await rm(join(modules, "@lydell", entry), { recursive: true, force: true });
    }
  } catch (error) {
    if (error.code !== "ENOENT") throw error;
  }
  await walk(modules, async (path) => {
    if (basename(path) === "sshcrypto.node") await rm(path);
  });
  // Overlay the complete native stage (including actual node-pty helpers), last.
  await cp(native, modules, { recursive: true, dereference: false });
  await walk(modules, async (path) => {
    if (basename(path) === "sshcrypto.node")
      throw new Error(`Forbidden SSH native crypto: ${path}`);
  });
  await replaceAppAsarFromStaging({
    sourceDir: app,
    appAsarPath: archive,
    targetPlatformKey: "linux-x64",
    runAsarCommand,
  });
  const violations = findDesktopNativePackageViolations(
    parseAsarListWithPackState(runAsarCommand(["list", archive, "--is-pack"])),
    "linux-x64",
  );
  if (violations.length) throw new Error(violations.join("\n"));
  for (const name of expected) await elf(join(`${archive}.unpacked`, "node_modules", name));
} finally {
  await rm(temporary, { recursive: true, force: true });
}

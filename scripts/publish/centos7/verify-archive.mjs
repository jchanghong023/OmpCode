import { spawn } from "node:child_process";
import { createReadStream } from "node:fs";
import { createHash } from "node:crypto";
import { lstat, mkdtemp, readFile, readdir, readlink, realpath, rm } from "node:fs/promises";
import { createRequire } from "node:module";
import { tmpdir } from "node:os";
import { basename, dirname, join, relative, resolve, isAbsolute } from "node:path";
import { fileURLToPath } from "node:url";
import { findDesktopNativePackageViolations } from "../../../packages/desktop/scripts/desktop-native-package-policy.mjs";
import { isSharpRequiredByComputerUse } from "../../../packages/desktop/scripts/sharp-package-assets.mjs";

const here = dirname(fileURLToPath(import.meta.url));
const require = createRequire(resolve(here, "../../../packages/desktop/package.json"));
const asar = require("@electron/asar");
const asarManifestPath = require.resolve("@electron/asar/package.json");
const asarManifest = JSON.parse(await readFile(asarManifestPath, "utf8"));
const asarCli = resolve(
  dirname(asarManifestPath),
  typeof asarManifest.bin === "string" ? asarManifest.bin : asarManifest.bin.asar,
);
function run(command, args) {
  return new Promise((resolve, reject) => {
    const child = spawn(command, args, { stdio: "inherit" });
    child.once("error", reject);
    child.once("exit", (code, signal) =>
      code === 0 ? resolve() : reject(new Error(`${command} failed: ${code ?? signal}`)),
    );
  });
}
// Python's ZIP reader verifies CRC while streaming every member. Extract only after validating
// the complete namespace; symlinks cannot become parents of subsequent extracted files.
const extract = String.raw`
import os,sys,stat,zipfile,posixpath,shutil
archive,destination,root=sys.argv[1:]
with zipfile.ZipFile(archive) as z:
    entries=z.infolist(); names={}; links={}
    if not entries: raise ValueError('Empty ZIP')
    for e in entries:
        name=e.filename
        parts=name.rstrip('/').split('/')
        if not name or '\\' in name or '\x00' in name or name.startswith('/') or any(p in ('','.', '..') or ':' in p for p in parts) or parts[0]!=root:
            raise ValueError('Unsafe ZIP entry: '+name)
        key=name.rstrip('/')
        if key in names: raise ValueError('Duplicate ZIP entry: '+name)
        names[key]=e
        mode=e.external_attr>>16
        kind=stat.S_IFMT(mode)
        if e.create_system!=3 or kind not in (stat.S_IFREG,stat.S_IFDIR,stat.S_IFLNK): raise ValueError('Missing Unix type: '+name)
        if mode & 0o6000: raise ValueError('Privileged mode: '+name)
        if e.flag_bits & 1: raise ValueError('Encrypted ZIP entry: '+name)
        if kind==stat.S_IFLNK:
            target=z.read(e).decode('utf-8')
            normalized=posixpath.normpath(posixpath.join(posixpath.dirname(key),target))
            if not target or target.startswith('/') or '\\' in target or not normalized.startswith(root+'/'): raise ValueError('Escaping symlink: '+name)
            links[key]=target
    for key,e in names.items():
        parent=posixpath.dirname(key)
        while parent:
            if parent in links or (parent in names and not names[parent].is_dir()): raise ValueError('Non-directory ZIP ancestor: '+key)
            parent=posixpath.dirname(parent)
    for key,e in names.items():
        path=os.path.join(destination,*key.split('/')); mode=e.external_attr>>16
        if e.is_dir(): os.makedirs(path,exist_ok=True)
        elif key not in links:
            os.makedirs(os.path.dirname(path),exist_ok=True)
            with z.open(e) as source,open(path,'xb') as output: shutil.copyfileobj(source,output,1024*1024)
        else:
            os.makedirs(os.path.dirname(path),exist_ok=True); os.symlink(links[key],path)
        if key not in links: os.chmod(path,stat.S_IMODE(mode))
    for key in links:
        path=os.path.join(destination,*key.split('/'))
        actual=os.path.realpath(path)
        if not actual.startswith(os.path.join(destination,root)+os.sep) or not os.path.exists(path): raise ValueError('Dangling/escaping link: '+key)
    bad=z.testzip()
    if bad: raise ValueError('ZIP CRC mismatch: '+bad)
`;
async function regular(path, executable = false) {
  const info = await lstat(path);
  if (!info.isFile() || !info.size || (executable && !(info.mode & 0o111)))
    throw new Error(`Missing/invalid required asset: ${path}`);
}
async function walk(root, action) {
  for (const entry of await readdir(root, { withFileTypes: true })) {
    const path = join(root, entry.name);
    await action(path, entry);
    if (entry.isDirectory()) await walk(path, action);
  }
}
const [archiveArg, rootName, ...extra] = process.argv.slice(2);
if (
  !archiveArg ||
  !/^OmpCode-\d+\.\d+\.\d+(?:-[0-9A-Za-z.-]+)?-centos7-x64$/.test(rootName ?? "") ||
  extra.length
)
  throw new Error("Usage: node verify-archive.mjs <zip> <OmpCode-version-centos7-x64>");
const temporary = await mkdtemp(join(tmpdir(), "centos7-archive-"));
try {
  await run("python3", ["-c", extract, resolve(archiveArg), temporary, rootName]);
  const root = join(temporary, rootName);
  const resources = join(root, "app/resources");
  for (const name of [
    "LICENSE",
    "NOTICE.md",
    "THIRD-PARTY-NOTICES.md",
    "fonts/fonts.conf",
    "fonts/wqy-zenhei.ttc",
    "licenses/runtime-assets-manifest.json",
    "app/LICENSE",
    "app/LICENSES.chromium.html",
    "app/resources/app.asar",
  ])
    await regular(join(root, name));
  for (const name of [
    "bin/ompcode-centos7",
    "app/ompcode",
    "app/resources/tools/bfs/bfs",
    "app/resources/tools/ugrep/ugrep",
  ])
    await regular(join(root, name), true);
  const runtimeManifest = JSON.parse(
    await readFile(join(root, "licenses/runtime-assets-manifest.json"), "utf8"),
  );
  if (!runtimeManifest.outputs || !Object.keys(runtimeManifest.outputs).length)
    throw new Error("Runtime asset provenance has no output digests");
  for (const [name, digest] of Object.entries(runtimeManifest.outputs)) {
    if (
      !/^(?:lib|fonts|licenses)\//.test(name) ||
      name.includes("\\") ||
      name.split("/").some((part) => !part || part === "." || part === "..") ||
      !/^[a-f0-9]{64}$/.test(digest)
    )
      throw new Error(`Unsafe runtime asset digest: ${name}`);
    const path = join(root, name);
    await regular(path);
    const hash = createHash("sha256");
    for await (const chunk of createReadStream(path)) hash.update(chunk);
    if (hash.digest("hex") !== digest) throw new Error(`Runtime asset SHA-256 mismatch: ${name}`);
  }
  const pluginManifest = JSON.parse(
    await readFile(join(root, "licenses/plugin-native-build-manifest.json"), "utf8"),
  );
  if (
    pluginManifest.schemaVersion !== 1 ||
    pluginManifest.electron !== "28.3.3" ||
    pluginManifest.runtimeNode !== "18.18.2" ||
    pluginManifest.glibc !== "2.17" ||
    !Array.isArray(pluginManifest.modules) ||
    !Array.isArray(pluginManifest.files) ||
    !pluginManifest.files.length
  )
    throw new Error("Invalid plugin native build provenance");
  if (
    !pluginManifest.modules.some(
      (module) => module.name === "koffi" && module.version === "2.15.6" && module.napi === 8,
    )
  )
    throw new Error("Missing compatible Koffi declaration");
  const sharpDeclared = pluginManifest.modules.some((module) => module.name === "sharp");
  if (
    isSharpRequiredByComputerUse({
      desktopPackageRoot: resolve(here, "../../../packages/desktop"),
    }) &&
    !sharpDeclared
  )
    throw new Error("Real Computer Use requires compatible Sharp assets");
  if (
    sharpDeclared &&
    !pluginManifest.modules.some(
      (module) =>
        module.name === "sharp" &&
        module.version === "0.32.6" &&
        module.napi === 7 &&
        module.libvips === "8.14.5",
    )
  )
    throw new Error("Wrong compatible Sharp declaration");
  const pluginFiles = new Set();
  for (const { path: name, sha256 } of pluginManifest.files) {
    if (
      typeof name !== "string" ||
      !name.startsWith("app/resources/glm/") ||
      name.includes("\\") ||
      name.split("/").some((part) => !part || part === "." || part === "..") ||
      !/^[a-f0-9]{64}$/.test(sha256) ||
      pluginFiles.has(name)
    )
      throw new Error(`Unsafe plugin native record: ${name}`);
    pluginFiles.add(name);
    const path = join(root, name);
    await regular(path);
    const hash = createHash("sha256");
    for await (const chunk of createReadStream(path)) hash.update(chunk);
    if (hash.digest("hex") !== sha256) throw new Error(`Plugin native SHA-256 mismatch: ${name}`);
  }
  if (
    !pluginFiles.has(
      "app/resources/glm/packages/zcode-cua-plugin/node_modules/koffi/build/koffi/linux_x64/koffi.node",
    )
  )
    throw new Error("Koffi target addon missing from provenance");
  if (sharpDeclared) {
    for (const plugin of ["node-repl-host", "browser-use-plugin", "zcode-cua-plugin"]) {
      const prefix = `app/resources/glm/packages/${plugin}/node_modules/sharp/`;
      if (
        !pluginFiles.has(`${prefix}build/Release/sharp-linux-x64.node`) ||
        ![...pluginFiles].some(
          (name) => name.startsWith(`${prefix}vendor/`) && /\/libvips[^/]*\.so/.test(name),
        )
      )
        throw new Error(`Missing Sharp addon/vendor provenance: ${plugin}`);
    }
  }
  let ripgrep = 0;
  await walk(join(resources, "tools/ripgrep"), async (path, entry) => {
    if (entry.isFile() && /^(?:rg|ripgrep)$/.test(entry.name)) {
      await regular(path, true);
      ripgrep++;
    }
  });
  if (!ripgrep) throw new Error("Missing current-plan ripgrep executable");
  const archive = join(resources, "app.asar");
  const entries = asar.listPackage(archive).map((path) => {
    const normalized = path.replaceAll("\\", "/");
    if (
      normalized.split("/").some((part) => part === ".." || part === ".") ||
      normalized.includes("\0")
    )
      throw new Error(`Unsafe ASAR entry: ${normalized}`);
    const info = asar.statFile(archive, normalized.replace(/^\//, ""));
    if (normalized.endsWith("/sshcrypto.node"))
      throw new Error("Forbidden SSH native crypto in ASAR");
    return { path: normalized, packState: info.unpacked ? "unpack" : "pack" };
  });
  const nativePaths = new Set([
    "/node_modules/better-sqlite3/build/Release/better_sqlite3.node",
    "/node_modules/node-pty/prebuilds/linux-x64/pty.node",
    "/node_modules/cpu-features/build/Release/cpufeatures.node",
  ]);
  for (const entry of entries) {
    if (
      /\/node_modules\/(?:better-sqlite3|node-pty|cpu-features)\/.*\.node$/.test(entry.path) &&
      !nativePaths.has(entry.path)
    )
      throw new Error(`Unexpected native ABI variant: ${entry.path}`);
  }
  const checkedDependencies = new Set();
  function verifyDependencyClosure(modulePath) {
    if (checkedDependencies.has(modulePath)) return;
    checkedDependencies.add(modulePath);
    const manifest = JSON.parse(asar.extractFile(archive, `${modulePath}/package.json`).toString());
    for (const dependency of Object.keys(manifest.dependencies ?? {})) {
      let cursor = modulePath;
      let found;
      while (cursor) {
        const candidate = `${cursor}/node_modules/${dependency}`;
        try {
          asar.statFile(archive, `${candidate}/package.json`);
          found = candidate;
          break;
        } catch {}
        cursor = cursor.includes("/") ? cursor.slice(0, cursor.lastIndexOf("/")) : "";
      }
      if (!found) {
        const candidate = `node_modules/${dependency}`;
        try {
          asar.statFile(archive, `${candidate}/package.json`);
          found = candidate;
        } catch {}
      }
      if (!found) throw new Error(`Missing JS dependency ${dependency} from ${modulePath}`);
      verifyDependencyClosure(found);
    }
  }
  verifyDependencyClosure("node_modules/better-sqlite3");
  const violations = findDesktopNativePackageViolations(entries, "linux-x64");
  if (violations.length) throw new Error(violations.join("\n"));
  for (const module of ["better-sqlite3", "node-pty", "cpu-features"]) {
    const manifest = JSON.parse(
      asar.extractFile(archive, `node_modules/${module}/package.json`).toString(),
    );
    if (module === "better-sqlite3" && manifest.version !== "9.6.0")
      throw new Error("Wrong SQLite runtime version");
    const entry = typeof manifest.main === "string" ? manifest.main : "index.js";
    const candidates = [entry, `${entry}.js`, `${entry}/index.js`];
    if (
      !candidates.some((name) => {
        try {
          return !!asar.statFile(archive, `node_modules/${module}/${name.replace(/^\.\//, "")}`);
        } catch {
          return false;
        }
      })
    )
      throw new Error(`Missing native module JS entry: ${module}`);
  }
  for (const name of [
    "better-sqlite3/build/Release/better_sqlite3.node",
    "node-pty/prebuilds/linux-x64/pty.node",
    "cpu-features/build/Release/cpufeatures.node",
  ]) {
    if (!asar.statFile(archive, `node_modules/${name}`).unpacked)
      throw new Error(`Packed native addon: ${name}`);
    await regular(join(`${archive}.unpacked`, "node_modules", name));
  }
  let libraries = 0,
    fontLicenses = 0;
  await walk(root, async (path, entry) => {
    const name = relative(root, path).split("\\").join("/");
    if (
      /(^|\/)(?:proot|rootfs|ubuntu-rootfs|node-v(?:20|24)[^/]*|gcc|g\+\+)(\/|$)/i.test(name) ||
      entry.name === "sshcrypto.node" ||
      /^(?:ld-linux.*|libc\.so(?:\..*)?|libpthread\.so(?:\..*)?)$/.test(entry.name)
    )
      throw new Error(`Forbidden runtime/build asset: ${name}`);
    if (name.startsWith("lib/") && entry.isFile()) libraries++;
    if (name.startsWith("licenses/") && entry.isFile() && /(?:font|wqy|ofl)/i.test(name)) {
      await regular(path);
      fontLicenses++;
    }
    if (entry.isSymbolicLink()) {
      const target = await readlink(path);
      const actual = await realpath(path);
      if (isAbsolute(target) || relative(root, actual).startsWith(".."))
        throw new Error(`Escaping symlink: ${name}`);
    }
  });
  if (!libraries || !fontLicenses) throw new Error("Missing runtime libraries or font licenses");
  // This audits final uncompressed bytes, including every unpacked native and external resource.
  // Include packed payloads in the magic-based ELF audit, not merely .node sidecars.
  await run(process.execPath, [asarCli, "extract", archive, join(root, ".asar-audit")]);
  await run("python3", [join(here, "verify-elf.py"), root]);
  console.log(`Verified archive integrity: ${basename(archiveArg)}`);
} finally {
  await rm(temporary, { recursive: true, force: true });
}

import { execFile } from "node:child_process";
import { createHash } from "node:crypto";
import { createReadStream } from "node:fs";
import {
  chmod,
  copyFile,
  cp,
  lstat,
  mkdir,
  readFile,
  readdir,
  realpath,
  rm,
  writeFile,
} from "node:fs/promises";
import { createRequire } from "node:module";
import { dirname, join, relative, resolve } from "node:path";
import { promisify } from "node:util";
import { fileURLToPath } from "node:url";

const exec = promisify(execFile);
async function run(command, args, cwd, env = process.env) {
  const result = await exec(command, args, { cwd, env, maxBuffer: 64 * 1024 * 1024 });
  if (result.stdout) process.stdout.write(result.stdout);
  if (result.stderr) process.stderr.write(result.stderr);
}
async function digest(path) {
  const hash = createHash("sha256");
  for await (const chunk of createReadStream(path)) hash.update(chunk);
  return hash.digest("hex");
}
async function rootOf(entry, name) {
  let root = dirname(await realpath(entry));
  while (root !== dirname(root)) {
    try {
      const manifest = JSON.parse(await readFile(join(root, "package.json"), "utf8"));
      if (manifest.name === name) return { root, manifest };
    } catch (error) {
      if (error.code !== "ENOENT") throw error;
    }
    root = dirname(root);
  }
  throw new Error(`Cannot locate native dependency ${name}`);
}
async function recordFiles(root, base = root) {
  const files = [];
  for (const entry of await readdir(root, { withFileTypes: true })) {
    const path = join(root, entry.name);
    if (entry.isDirectory()) files.push(...(await recordFiles(path, base)));
    else if (entry.isFile())
      files.push({ path: relative(base, path).replaceAll("\\", "/"), sha256: await digest(path) });
  }
  return files;
}

async function copyLicenseTree(source, target) {
  for (const entry of await readdir(source, { withFileTypes: true })) {
    if (entry.isDirectory()) {
      await copyLicenseTree(join(source, entry.name), join(target, entry.name));
    } else if (
      entry.isFile() &&
      /^(?:licen[cs]e|copying|notice|copyright)(?:[._-]|$)/iu.test(entry.name)
    ) {
      await mkdir(target, { recursive: true });
      await copyFile(join(source, entry.name), join(target, entry.name));
    }
  }
}

// Called only inside the checked glibc-2.17/GCC-11 native job. No addon is
// loaded: N-API versions come from upstream metadata, and ELF verification is
// performed over this stage and again over the final assembled package.
export async function buildPluginNativeAssets({ repoRoot, stagingRoot, headers, nodeGyp }) {
  if (
    process.platform !== "linux" ||
    process.arch !== "x64" ||
    process.versions.node !== "20.19.0"
  ) {
    throw new Error("Plugin native assets require the CentOS 7 linux-x64 Node 20.19.0 builder");
  }
  const libc = await exec("getconf", ["GNU_LIBC_VERSION"]);
  if (libc.stdout.trim() !== "glibc 2.17")
    throw new Error("Plugin native build requires glibc 2.17");
  const desktopRoot = join(repoRoot, "packages/desktop");
  const desktop = JSON.parse(await readFile(join(desktopRoot, "package.json"), "utf8"));
  if (desktop.devDependencies?.electron !== "28.3.3")
    throw new Error("Expected temporary Electron 28.3.3 manifest");
  const fromAdapters = createRequire(
    join(repoRoot, "apps/zcode-cli/packages/adapters/package.json"),
  );
  const { root: koffiRoot, manifest: koffi } = await rootOf(fromAdapters.resolve("koffi"), "koffi");
  if (
    koffi.version !== "2.15.6" ||
    koffi.cnoke?.napi !== 8 ||
    koffi.cnoke?.api !== "../../vendor/node-api-headers"
  ) {
    throw new Error("Expected koffi 2.15.6 with vendored N-API 8 headers");
  }
  await rm(join(koffiRoot, "build"), { recursive: true, force: true });
  // Deliberately omit --prebuild: cnoke must compile, not load/probe/reuse an addon.
  await run(
    process.execPath,
    [
      join(koffiRoot, "src/cnoke/cnoke.js"),
      "build",
      "-P",
      koffiRoot,
      "-D",
      join(koffiRoot, "src/koffi"),
      "--runtime",
      "18.18.2",
      "--release",
    ],
    koffiRoot,
  );
  const koffiTarget = join(
    stagingRoot,
    "app/resources/glm/packages/zcode-cua-plugin/node_modules/koffi",
  );
  await rm(koffiTarget, { recursive: true, force: true });
  await mkdir(join(koffiTarget, "build/koffi/linux_x64"), { recursive: true });
  const addon = join(koffiRoot, "build/koffi/linux_x64/koffi.node");
  if (!(await lstat(addon)).isFile()) throw new Error("Koffi source build produced no addon");
  await copyFile(addon, join(koffiTarget, "build/koffi/linux_x64/koffi.node"));
  await chmod(join(koffiTarget, "build/koffi/linux_x64/koffi.node"), 0o755);
  for (const name of await readdir(koffiRoot)) {
    if (
      ["index.js", "index.d.ts", "package.json"].includes(name) ||
      /^(?:licen[cs]e|copying|notice|copyright)(?:[._-]|$)/iu.test(name)
    ) {
      if ((await lstat(join(koffiRoot, name))).isFile())
        await copyFile(join(koffiRoot, name), join(koffiTarget, name));
    }
  }
  const modules = [
    {
      name: "koffi",
      version: koffi.version,
      napi: 8,
      headers: "koffi/vendor/node-api-headers",
      headerFiles: await recordFiles(join(koffiRoot, "vendor/node-api-headers")),
      packageManifestSha256: await digest(join(koffiRoot, "package.json")),
    },
  ];
  const { isSharpRequiredByComputerUse, stageCentos7SharpIntoBundledAgents } =
    await import("../../../packages/desktop/scripts/sharp-package-assets.mjs");
  if (isSharpRequiredByComputerUse({ desktopPackageRoot: desktopRoot })) {
    const desktopRequire = createRequire(join(desktopRoot, "package.json"));
    const { root: sharpRoot, manifest: sharp } = await rootOf(
      desktopRequire.resolve("sharp"),
      "sharp",
    );
    if (
      sharp.version !== "0.32.6" ||
      sharp.config?.libvips !== "8.14.5" ||
      sharp.config?.target !== 7
    ) {
      throw new Error("CentOS 7 requires sharp 0.32.6 / libvips 8.14.5 / N-API 7");
    }
    const libvipsIntegrity =
      "sha512-SlFWrITSW5XVUkaFPQOySAaSGXnhkGJCj8X2wGYYta9hk5piZldQyMp4zwy0z6UeRu1qKTKtZvmq28W3Gnh9xA==";
    if (sharp.config.integrity?.["linux-x64"] !== libvipsIntegrity) {
      throw new Error("Unexpected Sharp 0.32.6 linux-x64 libvips source integrity");
    }
    if (!headers || !nodeGyp)
      throw new Error("Sharp source build requires verified Electron headers and node-gyp paths");
    await rm(join(sharpRoot, "build"), { recursive: true, force: true });
    await rm(join(sharpRoot, "vendor"), { recursive: true, force: true });
    const sharpEnv = {
      ...process.env,
      SHARP_IGNORE_GLOBAL_LIBVIPS: "1",
      npm_config_build_from_source: "true",
      npm_config_platform: "linux",
      npm_config_arch: "x64",
    };
    delete sharpEnv.SHARP_INSTALL_FORCE;
    delete sharpEnv.npm_config_sharp_install_force;
    // Upstream libvips installer validates the pinned linux-x64 SHA-512 in
    // sharp.config.integrity; ELF checks remain authoritative for its bytes.
    await run(process.execPath, [join(sharpRoot, "install/libvips.js")], sharpRoot, sharpEnv);
    await run(
      process.execPath,
      [nodeGyp, "rebuild", "--target=28.3.3", `--nodedir=${headers}`, "--arch=x64"],
      sharpRoot,
      sharpEnv,
    );
    const sharpAddon = join(sharpRoot, "build/Release/sharp-linux-x64.node");
    if (!(await lstat(sharpAddon)).isFile())
      throw new Error("Sharp source build produced no target addon");
    for (const plugin of ["node-repl-host", "browser-use-plugin", "zcode-cua-plugin"]) {
      await stageCentos7SharpIntoBundledAgents({
        desktopPackageRoot: desktopRoot,
        glmDir: join(stagingRoot, "app/resources/glm/packages", plugin),
      });
    }
    modules.push({
      name: "sharp",
      version: sharp.version,
      napi: 7,
      libvips: "8.14.5",
      libvipsIntegrity: sharp.config.integrity["linux-x64"],
      headers: "Electron 28.3.3 (verified by native build owner)",
      packageManifestSha256: await digest(join(sharpRoot, "package.json")),
    });
  }
  for (const module of modules) {
    const source =
      module.name === "koffi"
        ? koffiTarget
        : join(stagingRoot, "app/resources/glm/packages/zcode-cua-plugin/node_modules/sharp");
    const licenseRoot = join(stagingRoot, "licenses/native", module.name);
    await mkdir(licenseRoot, { recursive: true });
    for (const entry of await readdir(source, { withFileTypes: true })) {
      if (
        entry.isFile() &&
        /^(?:licen[cs]e|copying|notice|copyright)(?:[._-]|$)/iu.test(entry.name)
      )
        await cp(join(source, entry.name), join(licenseRoot, entry.name));
    }
  }
  await copyLicenseTree(
    join(koffiRoot, "vendor"),
    join(stagingRoot, "licenses/native/koffi/vendor"),
  );
  await writeFile(
    join(stagingRoot, "plugin-native-build-manifest.json"),
    `${JSON.stringify({ schemaVersion: 1, electron: "28.3.3", runtimeNode: "18.18.2", glibc: "2.17", modules, files: await recordFiles(join(stagingRoot, "app/resources/glm"), stagingRoot) }, null, 2)}\n`,
  );
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  if (process.argv.length !== 6)
    throw new Error(
      "Usage: build-plugin-native-assets.mjs <repoRoot> <stagingRoot> <electronHeadersDir> <nodeGypPath>",
    );
  await buildPluginNativeAssets({
    repoRoot: resolve(process.argv[2]),
    stagingRoot: resolve(process.argv[3]),
    headers: resolve(process.argv[4]),
    nodeGyp: resolve(process.argv[5]),
  });
}

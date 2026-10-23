#!/usr/bin/env node
// Build-time collection only. Never consult the modern packaging host's libraries.
import { execFile, spawn } from "node:child_process";
import { promisify } from "node:util";
import { constants as fsConstants, createReadStream, createWriteStream } from "node:fs";
import { promises as fs } from "node:fs";
import { createHash } from "node:crypto";
import { pipeline } from "node:stream/promises";
import { Readable } from "node:stream";
import { dirname, basename, resolve, relative, join, isAbsolute } from "node:path";
import { fileURLToPath } from "node:url";
import { tmpdir } from "node:os";
import { once } from "node:events";

const here = dirname(fileURLToPath(import.meta.url));
const policy = JSON.parse(await fs.readFile(join(here, "runtime-assets.json"), "utf8"));
const execute = promisify(execFile);
async function run(binary, args) {
  const { stdout } = await execute(binary, args, {
    env: { ...process.env, LC_ALL: "C" },
    maxBuffer: 32 * 1024 * 1024,
  });
  return stdout.trim();
}
async function fileDigest(path, algorithm) {
  const hash = createHash(algorithm);
  for await (const block of createReadStream(path)) hash.update(block);
  return hash.digest("hex");
}
async function sha256(path) {
  return fileDigest(path, "sha256");
}
function contained(path, root) {
  const rel = relative(root, path);
  return !isAbsolute(rel) && rel !== ".." && !rel.startsWith("../");
}
async function* files(root) {
  for (const item of await fs.readdir(root, { withFileTypes: true })) {
    const path = join(root, item.name);
    if (item.isSymbolicLink()) {
      const target = await fs.realpath(path);
      if (isAbsolute(await fs.readlink(path)) || !contained(target, rootBoundary.get(root) ?? root))
        throw new Error(`escaping link: ${path}`);
    } else if (item.isDirectory()) {
      rootBoundary.set(path, rootBoundary.get(root) ?? root);
      yield* files(path);
    } else if (item.isFile()) yield path;
  }
}
const rootBoundary = new Map();
async function isElf(path) {
  const handle = await fs.open(path, "r");
  try {
    const buffer = Buffer.alloc(4);
    const { bytesRead } = await handle.read(buffer, 0, 4, 0);
    return bytesRead === 4 && buffer.equals(Buffer.from([0x7f, 0x45, 0x4c, 0x46]));
  } finally {
    await handle.close();
  }
}
async function elf(path) {
  const text = await run("readelf", ["-dW", path]);
  return {
    needed: [...text.matchAll(/\(NEEDED\).*?\[(.*?)\]/g)].map((match) => match[1]),
    soname: text.match(/\(SONAME\).*?\[(.*?)\]/)?.[1],
    rpaths: [...text.matchAll(/\((?:RPATH|RUNPATH)\).*?\[(.*?)\]/g)].map((match) => match[1]),
  };
}
async function extractRpmMembers(rpm, destination, members) {
  const options = { env: { ...process.env, LC_ALL: "C" }, cwd: destination };
  const archive = join(destination, ".payload.cpio");
  const output = await fs.open(archive, "wx");
  try {
    // cpio 读到归档结束标记便可关闭 stdin；先流式落盘，避免把合法尾部字节误判为管道截断。
    const payload = spawn("rpm2cpio", [rpm], {
      ...options,
      stdio: ["ignore", output.fd, "inherit"],
    });
    const [code, signal] = await once(payload, "close");
    if (code !== 0) throw new Error(`rpm2cpio failed: ${signal || code}`);
    await output.close();
    await execute(
      "cpio",
      [
        "-id",
        "--quiet",
        "--no-absolute-filenames",
        "--no-preserve-owner",
        "--file",
        archive,
        "--",
        ...members,
      ],
      options,
    );
  } finally {
    await output.close();
    await fs.rm(archive, { force: true });
  }
}


async function main() {
  if (process.argv.length < 3 || process.argv.length > 4)
    throw new Error("usage: collect-runtime-assets.mjs <nativeRoot> <desktopRoot?>");
  if (
    process.platform !== "linux" ||
    process.arch !== "x64" ||
    (await run("getconf", ["GNU_LIBC_VERSION"])) !== "glibc 2.17"
  ) {
    throw new Error(
      "runtime collection requires the glibc 2.17 x86-64 builder, never a modern runner",
    );
  }
  const release = await fs.readFile("/etc/centos-release", "utf8");
  if (!/^CentOS.*release 7\./m.test(release)) throw new Error("requires CentOS 7 RPM provenance");
  const nativeRoot = await fs.realpath(resolve(process.argv[2]));
  const desktopInput = process.argv[3] || process.env.CENTOS7_ELECTRON_ROOT;
  if (!desktopInput)
    throw new Error("desktopRoot or CENTOS7_ELECTRON_ROOT is required for Electron GUI closure");
  const desktopRoot = await fs.realpath(resolve(desktopInput));
  // 修复原因：缺少 version 的源码目录曾被当作 Electron 输入，导致 GUI 依赖闭包漏收。
  const version = await fs.readFile(join(desktopRoot, "version"), "utf8");
  if (version.trim() !== "28.3.3" || !(await isElf(join(desktopRoot, "electron"))))
    throw new Error(`wrong Electron distribution: ${desktopRoot} (${version.trim()})`);
  const lib = join(nativeRoot, "lib");
  const fonts = join(nativeRoot, "fonts");
  const licenses = join(nativeRoot, "licenses");
  // 根因：旧的规范化库若参与输入扫描，会绕过 RPM 来源校验；仅 lib 由 collector 独占。
  // 保留字体、app 和其他构建器拥有的搜索许可等资产。
  await fs.rm(lib, { recursive: true, force: true });
  for (const path of [lib, fonts, licenses]) {
    await fs.mkdir(path, { recursive: true });
  }
  const manifest = {
    schemaVersion: 1,
    target: policy.target,
    builder: {
      release: release.trim(),
      glibc: await run("getconf", ["GNU_LIBC_VERSION"]),
      image: process.env.CENTOS7_NATIVE_IMAGE || null,
      node: process.version,
      readelf: await run("readelf", ["--version"]),
      policySha256: await sha256(join(here, "runtime-assets.json")),
    },
    packages: {},
    inputs: [],
    libraries: [],
    baseline: [],
    font: policy.font,
    limitations: policy.evidenceLimitations,
  };
  async function provenance(path) {
    const info = await run("rpm", [
      "-qf",
      "--qf",
      "%{NAME}\t%{VERSION}-%{RELEASE}\t%{ARCH}\t%{SOURCERPM}",
      path,
    ]);
    const [name, version, arch, sourceRpm] = info.split("\t");
    const key = `${name}-${version}.${arch}`;
    manifest.packages[key] ??= { name, version, arch, sourceRpm };
    return key;
  }
  const cache = new Map();
  for (const line of (await run("/sbin/ldconfig", ["-p"])).split("\n")) {
    const match = line.match(/^\s*(\S+)\s+\([^)]*x86-64[^)]*\)\s+=>\s+(\S+)/);
    if (match && !cache.has(match[1])) cache.set(match[1], match[2]);
  }
  const baseline = new Set(policy.baselineSonames);
  const queue = [];
  const bundled = new Map();
  for (const root of [nativeRoot, desktopRoot]) {
    rootBoundary.set(root, root);
    for await (const path of files(root)) {
      if (!(await isElf(path))) continue;
      const metadata = await elf(path);
      queue.push({ path, metadata });
      manifest.inputs.push({ path, sha256: await sha256(path), ...metadata });
      if (metadata.soname) {
        const previous = bundled.get(metadata.soname);
        if (previous && (await sha256(previous)) !== (await sha256(path)))
          throw new Error(`conflicting bundled SONAME ${metadata.soname}`);
        bundled.set(metadata.soname, path);
      }
    }
  }
  if (!manifest.inputs.some((input) => contained(input.path, desktopRoot)))
    throw new Error("Electron closure input has no ELF");
  const visited = new Set();
  const copiedLibraries = new Map();
  async function collect(soname) {
    if (soname.includes("/")) throw new Error(`path-valued DT_NEEDED ${soname}`);
    if (baseline.has(soname)) {
      if (!manifest.baseline.includes(soname)) manifest.baseline.push(soname);
      return;
    }
    if (visited.has(soname)) return;
    visited.add(soname);
    if (bundled.has(soname)) return;
    const source = cache.get(soname);
    if (!source)
      throw new Error(
        `unresolved required SONAME ${soname}; install its CentOS7 vault RPM in the builder`,
      );
    const real = await fs.realpath(source);
    const rpm = await provenance(real);
    const metadata = await elf(real);
    if (metadata.soname !== soname) throw new Error(`SONAME mismatch ${soname}: ${real}`);
    const destination = join(lib, basename(real));
    const previous = copiedLibraries.get(destination);
    if (previous && previous !== real)
      throw new Error(`library filename collision: ${destination}`);
    if (!previous) {
      await fs.copyFile(real, destination, fsConstants.COPYFILE_EXCL);
      copiedLibraries.set(destination, real);
    }
    // Flatten only the installed SONAME chain: every target stays package-relative.
    let link = source;
    const seen = new Set();
    while ((await fs.lstat(link)).isSymbolicLink()) {
      if (seen.has(link)) throw new Error(`cyclic library symlink: ${source}`);
      seen.add(link);
      const next = resolve(dirname(link), await fs.readlink(link));
      const output = join(lib, basename(link));
      const target = basename(next);
      if (basename(link) !== target) {
        const existing = await fs.lstat(output).catch(() => null);
        if (!existing) await fs.symlink(target, output);
        else if (!existing.isSymbolicLink() || (await fs.readlink(output)) !== target)
          throw new Error(`SONAME link collision ${output}`);
      }
      link = next;
    }
    if (soname !== basename(real) && !(await fs.lstat(join(lib, soname)).catch(() => null)))
      await fs.symlink(basename(real), join(lib, soname));
    manifest.libraries.push({
      source,
      real,
      path: relative(nativeRoot, destination),
      rpm,
      ...metadata,
    });
    queue.push({ path: destination, metadata });
  }
  for (const soname of policy.requiredSonames) await collect(soname);
  for (let index = 0; index < queue.length; index++) {
    for (const soname of queue[index].metadata.needed) await collect(soname);
  }
  // Resolve the pinned build input, never download anything at application runtime.
  const temporary = await fs.mkdtemp(join(tmpdir(), "ompcode-font-"));
  try {
    const rpm = process.env.CENTOS7_FONT_RPM || join(temporary, `${policy.font.nevra}.rpm`);
    if (!process.env.CENTOS7_FONT_RPM) {
      const response = await fetch(policy.font.url);
      if (!response.ok || !response.body)
        throw new Error(`font RPM download failed: ${response.status}`);
      await pipeline(Readable.fromWeb(response.body), createWriteStream(rpm, { flags: "wx" }));
    }
    const identity = await run("rpm", [
      "-qp",
      "--qf",
      "%{NAME}-%{VERSION}-%{RELEASE}.%{ARCH}",
      rpm,
    ]);
    // 从实际 RPM 提取真实 TTC，不依赖宿主已安装字体。
    const listing = await run("rpm", [
      "-qp",
      "--qf",
      "[%{FILENAMES}\t%{FILEMODES:octal}\t%{FILELINKTOS}\n]",
      rpm,
    ]);
    const fontMember = listing.split("\n").find((line) => line.split("\t")[0] === policy.font.file);
    if (!fontMember) throw new Error("pinned font RPM is missing its TTC");
    const [source, mode, link] = fontMember.split("\t");
    if (
      !/^100[0-7]{3}$/.test(mode) ||
      (link && link !== "(none)") ||
      !/^\/[A-Za-z0-9_./+-]+$/.test(source) ||
      source.split("/").some((part) => part === "." || part === "..")
    )
      throw new Error(`unsafe font RPM member: ${fontMember}`);
    const extracted = join(temporary, "payload");
    await fs.mkdir(extracted);
    await extractRpmMembers(resolve(rpm), extracted, [`.${source}`]);
    const input = join(extracted, source.slice(1));
    const stat = await fs.lstat(input);
    if (!stat.isFile() || stat.size === 0 || !contained(await fs.realpath(input), extracted))
      throw new Error(`invalid extracted font RPM member: ${source}`);
    const destination = join(fonts, "wqy-zenhei.ttc");
    await fs.copyFile(input, destination);
    manifest.font = {
      ...policy.font,
      payloadSha256: await sha256(destination),
      rpm: identity,
    };
  } finally {
    await fs.rm(temporary, { recursive: true, force: true });
  }
  await fs.writeFile(
    join(fonts, "fonts.conf"),
    `<?xml version="1.0"?>
<!DOCTYPE fontconfig SYSTEM "fonts.dtd">
<fontconfig>
  <dir prefix="relative">.</dir>
  <cachedir prefix="xdg">fontconfig</cachedir>
  <alias><family>sans-serif</family><prefer><family>WenQuanYi Zen Hei</family></prefer></alias>
  <alias><family>serif</family><prefer><family>WenQuanYi Zen Hei</family></prefer></alias>
  <alias><family>monospace</family><prefer><family>WenQuanYi Zen Hei Mono</family></prefer></alias>
</fontconfig>
`,
  );
  const dtd = (await run("rpm", ["-ql", "fontconfig"]))
    .split("\n")
    .find((path) => path.endsWith("/fonts.dtd"));
  if (!dtd) throw new Error("fontconfig RPM is missing fonts.dtd");
  await fs.copyFile(dtd, join(fonts, "fonts.dtd"));
  manifest.fontConfigSha256 = await sha256(join(fonts, "fonts.conf"));
  manifest.outputs = {};
  for (const root of [lib, fonts]) {
    rootBoundary.set(root, nativeRoot);
    for await (const path of files(root)) {
      const stat = await fs.stat(path);
      if (stat.size === 0) throw new Error(`empty runtime asset: ${path}`);
      manifest.outputs[relative(nativeRoot, path).split("\\").join("/")] = await sha256(path);
    }
  }
  await fs.writeFile(
    join(licenses, "runtime-assets-manifest.json"),
    `${JSON.stringify(manifest, null, 2)}\n`,
  );
  console.log(join(licenses, "runtime-assets-manifest.json"));
}
main().catch((error) => {
  console.error(error.stack || error);
  process.exitCode = 1;
});

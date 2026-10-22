#!/usr/bin/env node
// Build-time collection only. Never consult the modern packaging host's libraries.
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { createReadStream, createWriteStream } from "node:fs";
import { promises as fs } from "node:fs";
import { createHash } from "node:crypto";
import { pipeline } from "node:stream/promises";
import { Readable } from "node:stream";
import { dirname, basename, resolve, relative, join, isAbsolute } from "node:path";
import { fileURLToPath } from "node:url";
import { tmpdir } from "node:os";

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
async function sha256(path) {
  const hash = createHash("sha256");
  for await (const block of createReadStream(path)) hash.update(block);
  return hash.digest("hex");
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
  const version = await fs.readFile(join(desktopRoot, "version"), "utf8").catch(() => "");
  if (version.trim() && version.trim() !== "28.3.3")
    throw new Error(`wrong Electron distribution: ${version.trim()}`);
  const lib = join(nativeRoot, "lib");
  const fonts = join(nativeRoot, "fonts");
  const licenses = join(nativeRoot, "licenses");
  // Refuse stale runtime stages; native/search licenses remain owned by their builders.
  for (const path of [lib, fonts, join(licenses, "rpm")]) {
    await fs.rm(path, { recursive: true, force: true });
    await fs.mkdir(path, { recursive: true });
  }
  const manifest = {
    schemaVersion: 1,
    target: policy.target,
    builder: {
      release: release.trim(),
      glibc: await run("getconf", ["GNU_LIBC_VERSION"]),
      rpmInventory: await run("rpm", ["-qa", "--qf", "%{NAME}-%{VERSION}-%{RELEASE}.%{ARCH}\n"]),
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
  const packages = new Map();
  async function provenance(path) {
    const info = await run("rpm", [
      "-qf",
      "--qf",
      "%{NAME}\t%{VERSION}-%{RELEASE}\t%{ARCH}\t%{LICENSE}\t%{SOURCERPM}\t%{VENDOR}",
      path,
    ]);
    const [name, version, arch, license, sourceRpm, vendor] = info.split("\t");
    if (
      !name ||
      !version ||
      !license ||
      !sourceRpm ||
      !version.includes(".el7") ||
      !["x86_64", "noarch"].includes(arch)
    )
      throw new Error(`not a CentOS7 RPM asset: ${path}: ${info}`);
    const key = `${name}-${version}.${arch}`;
    if (!packages.has(key)) {
      // A changed installed payload is not acceptable provenance. rpm verifies the
      // installed files against the signed package header rather than trusting paths.
      await run("rpm", ["-V", key]);
      const listing = (await run("rpm", ["-ql", key])).split("\n");
      const docs = listing.filter((value) => /^\/usr\/share\/(?:doc|licenses)\//.test(value));
      const copied = [];
      for (const source of docs) {
        const stat = await fs.lstat(source).catch(() => null);
        if (!stat?.isFile() || stat.size === 0) continue;
        const destination = join(licenses, "rpm", key, source.replace(/^\//, ""));
        await fs.mkdir(dirname(destination), { recursive: true });
        await fs.copyFile(source, destination);
        copied.push({ path: relative(nativeRoot, destination), sha256: await sha256(destination) });
      }
      if (
        !copied.some((item) => /(?:copying|licen[sc]e|copyright|gpl|lgpl|notice)/i.test(item.path))
      )
        throw new Error(`missing redistributable license text for ${key}`);
      const record = {
        name,
        version,
        arch,
        license,
        sourceRpm,
        vendor,
        snapshot: policy.rpmSnapshot,
        licenses: copied,
      };
      packages.set(key, record);
      manifest.packages[key] = record;
    }
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
    if (!["/usr/lib64/", "/lib64/", "/opt/rh/"].some((prefix) => real.startsWith(prefix)))
      throw new Error(`untrusted library origin ${real}`);
    const rpm = await provenance(real);
    const metadata = await elf(real);
    if (metadata.soname !== soname) throw new Error(`SONAME mismatch ${soname}: ${real}`);
    const destination = join(lib, basename(real));
    try {
      if ((await sha256(destination)) !== (await sha256(real)))
        throw new Error(`library filename collision: ${destination}`);
    } catch (error) {
      if (error.code !== "ENOENT") throw error;
      await fs.copyFile(real, destination);
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
      sha256: await sha256(real),
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
    if ((await sha256(rpm)) !== policy.font.sha256) throw new Error("font RPM SHA256 mismatch");
    const identity = await run("rpm", [
      "-qp",
      "--qf",
      "%{NAME}-%{VERSION}-%{RELEASE}.%{ARCH}",
      rpm,
    ]);
    if (identity !== policy.font.nevra) throw new Error(`font RPM identity mismatch: ${identity}`);
    const fontRpm = await provenance(policy.font.file);
    if (fontRpm !== policy.font.nevra) throw new Error(`installed font pin mismatch: ${fontRpm}`);
    // Compare installed header digests to the SHA-pinned source RPM as well.
    if (
      (await run("rpm", ["-q", "--dump", fontRpm])) !== (await run("rpm", ["-qp", "--dump", rpm]))
    )
      throw new Error("installed font does not match pinned RPM payload");
    await fs.copyFile(policy.font.file, join(fonts, "wqy-zenhei.ttc"));
    manifest.font = {
      ...policy.font,
      payloadSha256: await sha256(join(fonts, "wqy-zenhei.ttc")),
      rpm: fontRpm,
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
  for (const root of [lib, fonts, licenses]) {
    rootBoundary.set(root, nativeRoot);
    for await (const path of files(root)) {
      if (path === join(licenses, "runtime-assets-manifest.json")) continue;
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

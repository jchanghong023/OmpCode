/* eslint-disable max-lines -- 原生搜索构建步骤按依赖顺序共享同一套编译环境，集中维护更容易审计。 */
import { chmod, copyFile, mkdir, mkdtemp, readdir, rm, writeFile, lstat } from "node:fs/promises";
import { createReadStream } from "node:fs";
import { createHash } from "node:crypto";
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { cpus, tmpdir } from "node:os";
import { basename, dirname, join, relative } from "node:path";
import process from "node:process";
import {
  LINUX_NATIVE_SEARCH_GLIBC_BASELINE,
  CENTOS7_NATIVE_SEARCH_GLIBC_BASELINE,
  CENTOS7_RIPGREP_LICENSE_SOURCE,
  MACOS_NATIVE_SEARCH_DEPLOYMENT_TARGET,
  NATIVE_SEARCH_BFS_CONFIGURE_ARGS,
  NATIVE_SEARCH_TOOL_VERSIONS,
  getNativeSearchSourceArchivesForTarget,
  isMacosRosettaTarget,
  normalizeNativeSearchArch,
  normalizeNativeSearchPlatform,
  resolveNativeSearchBuildPlan,
  resolveNativeSearchPrebuiltPlan,
} from "./native-search-tools-config.mjs";
import { run, runCapture } from "./native-search-tools-process.mjs";
import { verifyBuiltNativeSearchProducerOutputs } from "./native-search-tools-verify.mjs";

const execFileAsync = promisify(execFile);

async function digestFile(path) {
  const hash = createHash("sha256");
  for await (const chunk of createReadStream(path)) hash.update(chunk);
  return hash.digest("hex");
}

async function downloadAndExtractSources({ sources, workDir, env }) {
  const paths = {};
  for (const source of sources) {
    const archive = join(workDir, `${source.id}.tar.gz`);
    await execFileAsync("curl", ["--fail", "--location", "--output", archive, source.url], { env });
    if ((await digestFile(archive)) !== source.sha256) {
      throw new Error(`Source checksum mismatch for ${source.id} ${source.version}`);
    }
    const destination = join(workDir, "sources", source.id);
    await mkdir(destination, { recursive: true });
    await execFileAsync("tar", ["-xzf", archive, "-C", destination, "--strip-components=1"], {
      env,
    });
    paths[source.id] = destination;
  }
  return paths;
}

async function copySourceLicenses(sourceRoot, destination) {
  let copied = 0;
  async function copyDirectoryLicenses(directory, targetDirectory) {
    for (const entry of await readdir(directory, { withFileTypes: true })) {
      const source = join(directory, entry.name);
      const target = join(targetDirectory, entry.name);
      if (entry.isDirectory()) {
        await copyDirectoryLicenses(source, target);
      } else if (
        entry.isFile() &&
        /^(?:licen[cs]e|copying|copyright|notice)(?:[._-]|$)/iu.test(entry.name)
      ) {
        // 固定 zstd 源归档含零字节许可占位；源码头明确适用根目录 BSD LICENSE / GPL COPYING。
        // 空文件不承载条款，不能作为发行资产；非空许可仍按原文和相对路径完整复制。
        if ((await lstat(source)).size === 0) continue;
        await mkdir(targetDirectory, { recursive: true });
        await copyFile(source, target);
        copied += 1;
      }
    }
  }
  await copyDirectoryLicenses(sourceRoot, destination);
  // 按整个依赖来源计数，而非要求每个子目录都有许可；全为空或缺失时必须拒绝。
  if (copied === 0) throw new Error(`No non-empty source licenses found in ${sourceRoot}`);
}

async function stageCentos7Ripgrep(plan, workDir, env) {
  // 当前计划已经固定含 PCRE2 的静态 musl 资产；不能换成现代 GNU prebuild 或删掉 -P 能力。
  const artifact = resolveNativeSearchPrebuiltPlan({
    platform: plan.platform,
    arch: plan.arch,
    outputDir: plan.outputDir,
    env,
  }).artifacts.find(({ toolId }) => toolId === "ripgrep");
  const archive = join(workDir, artifact.releaseFileName);
  if (artifact.downloadUrl) {
    await execFileAsync(
      "curl",
      ["--fail", "--location", "--output", archive, artifact.downloadUrl],
      { env },
    );
  } else {
    await copyFile(artifact.archivePath, archive);
  }
  const extracted = join(workDir, "ripgrep");
  await mkdir(extracted, { recursive: true });
  const { stdout: listing } = await execFileAsync("tar", ["-tzf", archive], { env });
  for (const entry of listing.trim().split("\n")) {
    if (entry.startsWith("/") || entry.split("/").includes("..")) {
      throw new Error(`Unsafe ripgrep archive entry ${entry}`);
    }
  }
  await execFileAsync("tar", ["-xzf", archive, "-C", extracted], { env });
  const binaryEntries = listing
    .trim()
    .split("\n")
    .filter((entry) => basename(entry) === artifact.binaryName);
  if (binaryEntries.length !== 1)
    throw new Error("Pinned ripgrep archive must contain exactly one rg");
  const binary = join(extracted, binaryEntries[0]);
  if (!(await lstat(binary)).isFile()) throw new Error("Pinned ripgrep executable missing");
  await mkdir(dirname(plan.rgPath), { recursive: true });
  await copyFile(binary, plan.rgPath);
  await chmod(plan.rgPath, 0o755);
  return {
    version: artifact.version,
    release: artifact.release,
    archiveSha256: artifact.archiveSha256,
  };
}

const MACOS_BFS_CPP_FLAGS = Object.freeze([
  // macOS 26 SDK 会让 bfs 优先选择 26.0 才存在的标准函数；屏蔽后沿用 10.15 起可用的 _np 版本。
  "-Dposix_spawn_file_actions_addfchdir=__bfs_poison_addfchdir_macos_26_0",
  "-Dfdclosedir=__bfs_poison_fdclosedir_macos_26_4",
]);

function appendFlags(currentValue, flags) {
  return [currentValue, ...flags].filter(Boolean).join(" ");
}

function readVersionMajor(version) {
  return Number.parseInt(String(version).trim().split(".", 1)[0] ?? "", 10);
}

export function assertLinuxNativeSearchBuildEnvironment({
  nodeVersion,
  glibcVersion,
  gccVersion,
  cxxVersion,
  centos7Baseline = false,
}) {
  const expectedNode = centos7Baseline ? "20.19.0" : null;
  const expectedGcc = centos7Baseline ? 11 : 12;
  const expectedGlibc = centos7Baseline
    ? CENTOS7_NATIVE_SEARCH_GLIBC_BASELINE
    : LINUX_NATIVE_SEARCH_GLIBC_BASELINE;
  if (expectedNode ? nodeVersion !== expectedNode : readVersionMajor(nodeVersion) !== 24) {
    throw new Error(
      `Linux native search requires Node ${expectedNode ?? "24"}; got ${nodeVersion}`,
    );
  }
  if (String(glibcVersion).trim() !== expectedGlibc) {
    throw new Error(`Linux native search requires glibc ${expectedGlibc}; got ${glibcVersion}`);
  }
  if (readVersionMajor(gccVersion) !== expectedGcc) {
    throw new Error(`Linux native search requires GCC ${expectedGcc}; got ${gccVersion}`);
  }
  if (readVersionMajor(cxxVersion) !== expectedGcc) {
    throw new Error(`Linux native search requires G++ ${expectedGcc}; got ${cxxVersion}`);
  }
}

function verifyLinuxNativeSearchBuildEnvironment(config) {
  const glibcVersion = runCapture("getconf", ["GNU_LIBC_VERSION"])
    .trim()
    .replace(/^glibc\s+/u, "");
  const gccVersion = runCapture(config.cc, ["-dumpfullversion"]).trim();
  // ugrep 由 CXX 编译；只检查 CC 会让 CXX=g++-13 等混合 toolchain
  // 绕过 producer 门禁，并把非 GCC Toolset 12 的 C++ 产物写入固定 release。
  const cxxVersion = runCapture(config.cxx, ["-dumpfullversion"]).trim();
  assertLinuxNativeSearchBuildEnvironment({
    nodeVersion: process.versions.node,
    glibcVersion,
    gccVersion,
    cxxVersion,
    centos7Baseline: config.centos7Baseline,
  });
  console.log(
    `==> Linux producer environment Node ${process.versions.node}, glibc ${glibcVersion}, GCC ${gccVersion}, G++ ${cxxVersion}`,
  );
}

export function resolveNativeUnixBuildConfig({
  platform = process.platform,
  arch = process.arch,
  hostPlatform = process.platform,
  hostArch = process.arch,
  env = process.env,
  centos7Baseline = false,
} = {}) {
  const normalizedPlatform = normalizeNativeSearchPlatform(platform);
  const normalizedArch = normalizeNativeSearchArch(arch);
  const normalizedHostPlatform = normalizeNativeSearchPlatform(hostPlatform);
  const normalizedHostArch = normalizeNativeSearchArch(hostArch);

  if (normalizedPlatform !== "darwin" && normalizedPlatform !== "linux") {
    throw new Error(`native Unix search build does not support platform ${normalizedPlatform}`);
  }
  const usesRosettaCrossBuild = isMacosRosettaTarget({
    platform: normalizedPlatform,
    arch: normalizedArch,
    hostPlatform: normalizedHostPlatform,
    hostArch: normalizedHostArch,
  });
  if (
    normalizedHostPlatform !== normalizedPlatform ||
    (normalizedHostArch !== normalizedArch && !usesRosettaCrossBuild)
  ) {
    throw new Error(
      `native Unix search build must run natively for ${normalizedPlatform}-${normalizedArch}; host is ${normalizedHostPlatform}-${normalizedHostArch}`,
    );
  }
  if (centos7Baseline && (normalizedPlatform !== "linux" || normalizedArch !== "x64")) {
    throw new Error("CentOS 7 native search requires linux-x64");
  }

  const targetCompilerArgs =
    normalizedPlatform === "darwin" ? ["-arch", normalizedArch === "x64" ? "x86_64" : "arm64"] : [];
  const ugrepConfigureArgs = [
    // Rosetta 构建时 config.guess 仍看到 arm64 runner，必须显式声明 x64 host 才能写入正确的平台身份。
    ...(usesRosettaCrossBuild ? ["--host=x86_64-apple-darwin"] : []),
    ...(normalizedArch === "x64" ? ["--disable-avx2"] : []),
  ];

  return {
    platform: normalizedPlatform,
    arch: normalizedArch,
    centos7Baseline,
    cc: env.CC?.trim() || (normalizedPlatform === "darwin" ? "clang" : "gcc"),
    cxx: env.CXX?.trim() || (normalizedPlatform === "darwin" ? "clang++" : "g++"),
    ar: env.AR?.trim() || "ar",
    ranlib: env.RANLIB?.trim() || "ranlib",
    targetCompilerArgs,
    usesRosettaCrossBuild,
    macosDeploymentTarget:
      normalizedPlatform === "darwin" ? MACOS_NATIVE_SEARCH_DEPLOYMENT_TARGET : undefined,
    brotliOsDefine: normalizedPlatform === "darwin" ? "OS_MACOSX" : "OS_LINUX",
    bfsCppFlags: normalizedPlatform === "darwin" ? MACOS_BFS_CPP_FLAGS : [],
    // Linux 可执行文件以 PIE 链接静态 PCRE2；非 PIC archive 会在最终链接阶段失败。
    pcre2ConfigureArgs:
      normalizedPlatform === "linux" ? ["--enable-jit", "--with-pic"] : ["--disable-jit"],
    ugrepConfigureArgs,
    ugrepLdFlags: [
      "-Wl,-x",
      ...(normalizedPlatform === "linux" ? ["-static-libgcc", "-static-libstdc++"] : []),
    ],
  };
}

function buildOniguruma(sourcePath, prefix, jobs, env, quiet) {
  console.log("==> Build Oniguruma (static)");
  run("./configure", [`--prefix=${prefix}`, "--disable-shared", "--enable-static"], {
    cwd: sourcePath,
    env,
    quiet,
  });
  run("make", [`-j${jobs}`], { cwd: sourcePath, env, quiet });
  run("make", ["install"], { cwd: sourcePath, env, quiet });
}

function buildPcre2(sourcePath, prefix, jobs, env, quiet, config) {
  console.log(`==> Build PCRE2 ${config.platform === "linux" ? "with" : "without"} JIT (static)`);
  run(
    "./configure",
    [
      `--prefix=${prefix}`,
      "--disable-shared",
      "--enable-static",
      ...config.pcre2ConfigureArgs,
      "--disable-pcre2-16",
      "--disable-pcre2-32",
      "--disable-pcre2test-libreadline",
    ],
    { cwd: sourcePath, env, quiet },
  );
  run("make", [`-j${jobs}`], { cwd: sourcePath, env, quiet });
  run("make", ["install"], { cwd: sourcePath, env, quiet });
}

function buildZlib(sourcePath, prefix, jobs, env, quiet) {
  console.log("==> Build zlib (static)");
  run("./configure", ["--static", `--prefix=${prefix}`], {
    cwd: sourcePath,
    env,
    quiet,
  });
  run("make", [`-j${jobs}`], { cwd: sourcePath, env, quiet });
  run("make", ["install"], { cwd: sourcePath, env, quiet });
}

async function buildBzip2(sourcePath, prefix, jobs, env, quiet, config) {
  console.log("==> Build bzip2 (static)");
  // release sidecar 不携带调试信息，避免 DWARF 记录随机构建目录。
  run(
    "make",
    [
      `-j${jobs}`,
      `CC=${config.cc}`,
      `AR=${config.ar}`,
      `RANLIB=${config.ranlib}`,
      `CFLAGS=${appendFlags("-Wall -Winline -O3 -D_FILE_OFFSET_BITS=64", config.targetCompilerArgs)}`,
    ],
    { cwd: sourcePath, env, quiet },
  );
  await copyFile(join(sourcePath, "libbz2.a"), join(prefix, "lib", "libbz2.a"));
  await copyFile(join(sourcePath, "bzlib.h"), join(prefix, "include", "bzlib.h"));
}

function buildZstd(sourcePath, prefix, jobs, env, quiet) {
  console.log("==> Build zstd (static)");
  run("make", ["-C", "lib", `-j${jobs}`, "libzstd.a-release"], {
    cwd: sourcePath,
    env,
    quiet,
  });
  run(
    "make",
    ["-C", "lib", `PREFIX=${prefix}`, "install-static", "install-includes", "install-pc"],
    { cwd: sourcePath, env, quiet },
  );
}

async function compileBrotliLibrary({
  sourcePath,
  buildPath,
  sourceGroup,
  libraryPath,
  env,
  quiet,
  config,
}) {
  const sourceDir = join(sourcePath, "c", sourceGroup);
  const objectDir = join(buildPath, sourceGroup);
  await mkdir(objectDir, { recursive: true });

  const objectPaths = (await readdir(sourceDir))
    .filter((name) => name.endsWith(".c"))
    .sort()
    .map((name) => {
      const objectPath = join(objectDir, `${basename(name, ".c")}.o`);
      run(
        config.cc,
        [
          "-O3",
          "-DNDEBUG",
          "-fPIC",
          `-D${config.brotliOsDefine}`,
          "-DBROTLI_HAVE_LOG2=1",
          ...config.targetCompilerArgs,
          `-I${join(sourcePath, "c", "include")}`,
          "-c",
          join(sourceDir, name),
          "-o",
          objectPath,
        ],
        { env, quiet },
      );
      return objectPath;
    });

  run(config.ar, ["crs", libraryPath, ...objectPaths], { env, quiet });
}

async function buildBrotli(sourcePath, prefix, workDir, env, quiet, config) {
  console.log("==> Build Brotli (static)");
  const buildPath = join(workDir, "brotli-build");
  const libraries = [
    ["common", "libbrotlicommon.a"],
    ["dec", "libbrotlidec.a"],
    ["enc", "libbrotlienc.a"],
  ];

  for (const [sourceGroup, libraryName] of libraries) {
    await compileBrotliLibrary({
      sourcePath,
      buildPath,
      sourceGroup,
      libraryPath: join(prefix, "lib", libraryName),
      env,
      quiet,
      config,
    });
  }

  const includeSource = join(sourcePath, "c", "include", "brotli");
  const includeDestination = join(prefix, "include", "brotli");
  await mkdir(includeDestination, { recursive: true });
  for (const name of (await readdir(includeSource)).filter((entry) => entry.endsWith(".h"))) {
    await copyFile(join(includeSource, name), join(includeDestination, name));
  }
}

export function createBfsBuildEnvironment({ sourcePath, prefix, env, config }) {
  const relativePrefix = relative(sourcePath, prefix) || ".";
  return {
    ...env,
    EXTRA_CPPFLAGS: [
      env.EXTRA_CPPFLAGS,
      ...config.bfsCppFlags,
      `-I${join(relativePrefix, "include")}`,
    ]
      .filter(Boolean)
      .join(" "),
    EXTRA_LDFLAGS: appendFlags(env.EXTRA_LDFLAGS, [`-L${join(relativePrefix, "lib")}`]),
    EXTRA_LDLIBS: appendFlags(env.EXTRA_LDLIBS, ["-lonig"]),
    // bfs 会把最终 flags 写入版本信息；使用显式相对路径，避免随机工作目录进入产物。
    PKG_CONFIG: "true",
    // CC 通过构建环境固定 release patch version，避免 --version 出现在 CONFFLAGS 中。
    VERSION: NATIVE_SEARCH_TOOL_VERSIONS.bfs,
  };
}

function buildBfs(sourcePath, prefix, jobs, env, quiet, runUpstreamTests, config) {
  console.log(`==> Build bfs ${NATIVE_SEARCH_TOOL_VERSIONS.bfs}`);
  const buildEnv = createBfsBuildEnvironment({ sourcePath, prefix, env, config });
  run("./configure", NATIVE_SEARCH_BFS_CONFIGURE_ARGS, { cwd: sourcePath, env: buildEnv, quiet });
  run("make", [`-j${jobs}`], { cwd: sourcePath, env: buildEnv, quiet });
  if (runUpstreamTests) {
    run("make", ["unit-tests"], { cwd: sourcePath, env: buildEnv, quiet });
  }
  return join(sourcePath, "bin", "bfs");
}

function buildUgrep(sourcePath, prefix, jobs, env, quiet, runUpstreamTests, config) {
  console.log(`==> Build ugrep ${NATIVE_SEARCH_TOOL_VERSIONS.ugrep}`);
  const buildEnv = {
    ...env,
    CFLAGS: appendFlags("-O3 -DNDEBUG", config.targetCompilerArgs),
    CXXFLAGS: appendFlags("-O3 -DNDEBUG", config.targetCompilerArgs),
    CPPFLAGS: `-I${join(prefix, "include")}`,
    LDFLAGS: [
      ...config.targetCompilerArgs,
      `-L${join(prefix, "lib")}`,
      ...config.ugrepLdFlags,
    ].join(" "),
    LIBS: "-lbrotlicommon",
  };
  run(
    "./configure",
    [
      "--disable-dependency-tracking",
      ...config.ugrepConfigureArgs,
      `--with-pcre2=${prefix}`,
      `--with-zlib=${prefix}`,
      `--with-bzlib=${prefix}`,
      "--without-lzma",
      "--without-lz4",
      `--with-zstd=${prefix}`,
      `--with-brotli=${prefix}`,
      "--without-bzip3",
    ],
    { cwd: sourcePath, env: buildEnv, quiet },
  );
  run("make", [`-j${jobs}`], { cwd: sourcePath, env: buildEnv, quiet });
  if (runUpstreamTests) {
    run("make", ["test"], { cwd: sourcePath, env: buildEnv, quiet });
  }
  return join(sourcePath, "src", "ugrep");
}

export async function buildNativeSearchToolsUnix({
  platform = process.platform,
  arch = process.arch,
  hostPlatform = process.platform,
  hostArch = process.arch,
  outputDir,
  jobs = Math.max(1, Math.min(cpus().length, 8)),
  keepWorkdir = false,
  quiet = false,
  runUpstreamTests = false,
  processEnv = process.env,
  centos7Baseline = false,
  licenseDir,
} = {}) {
  const config = resolveNativeUnixBuildConfig({
    platform,
    arch,
    hostPlatform,
    hostArch,
    env: processEnv,
    centos7Baseline,
  });
  const plan = resolveNativeSearchBuildPlan({
    platform: config.platform,
    arch: config.arch,
    outputDir,
  });
  const sourceArchives = [
    ...getNativeSearchSourceArchivesForTarget({ platform: plan.platform, arch: plan.arch }),
    ...(centos7Baseline && licenseDir ? [CENTOS7_RIPGREP_LICENSE_SOURCE] : []),
  ];
  if (centos7Baseline && runUpstreamTests) {
    throw new Error("CentOS 7 packaging does not run upstream tests");
  }
  if (config.platform === "linux") {
    // 下载源码前锁定 producer 环境。
    verifyLinuxNativeSearchBuildEnvironment(config);
  }
  const workDir = await mkdtemp(join(tmpdir(), "zcode-native-search-build-"));
  const prefix = join(workDir, "prefix");
  const env = {
    ...processEnv,
    AR: config.ar,
    CFLAGS: appendFlags(processEnv.CFLAGS, config.targetCompilerArgs),
    CC: config.cc,
    CXXFLAGS: appendFlags(processEnv.CXXFLAGS, config.targetCompilerArgs),
    CXX: config.cxx,
    LANG: "C",
    LDFLAGS: appendFlags(processEnv.LDFLAGS, config.targetCompilerArgs),
    LC_ALL: "C",
    ...(config.macosDeploymentTarget
      ? { MACOSX_DEPLOYMENT_TARGET: config.macosDeploymentTarget }
      : {}),
    RANLIB: config.ranlib,
  };
  await mkdir(join(prefix, "include"), { recursive: true });
  await mkdir(join(prefix, "lib", "pkgconfig"), { recursive: true });

  console.log("==> ZCode native search build");
  console.log(`    target:  ${plan.platformKey}`);
  console.log(`    output:  ${plan.outputDir}`);
  console.log(`    workdir: ${workDir}`);

  try {
    const sources = await downloadAndExtractSources({
      sources: sourceArchives,
      workDir,
      env,
      quiet,
    });
    if (licenseDir) {
      for (const [id, source] of Object.entries(sources)) {
        await copySourceLicenses(source, join(licenseDir, id));
      }
    }
    buildOniguruma(sources.oniguruma, prefix, jobs, env, quiet);
    buildPcre2(sources.pcre2, prefix, jobs, env, quiet, config);
    buildZlib(sources.zlib, prefix, jobs, env, quiet);
    await buildBzip2(sources.bzip2, prefix, jobs, env, quiet, config);
    buildZstd(sources.zstd, prefix, jobs, env, quiet);
    await buildBrotli(sources.brotli, prefix, workDir, env, quiet, config);

    const builtBfsPath = buildBfs(sources.bfs, prefix, jobs, env, quiet, runUpstreamTests, config);
    const builtUgrepPath = buildUgrep(
      sources.ugrep,
      prefix,
      jobs,
      env,
      quiet,
      runUpstreamTests,
      config,
    );
    // CentOS 发行只允许静态产物完整性检查，不执行工具的版本或搜索 smoke。
    if (!centos7Baseline)
      verifyBuiltNativeSearchProducerOutputs({
        bfsPath: builtBfsPath,
        ugrepPath: builtUgrepPath,
        platform: plan.platform,
        arch: plan.arch,
        producerOutputIds: plan.producerOutputIds,
      });

    await mkdir(dirname(plan.bfsPath), { recursive: true });
    await mkdir(dirname(plan.ugrepPath), { recursive: true });
    await copyFile(builtBfsPath, plan.bfsPath);
    await copyFile(builtUgrepPath, plan.ugrepPath);
    await chmod(plan.bfsPath, 0o755);
    await chmod(plan.ugrepPath, 0o755);
    if (centos7Baseline) {
      const ripgrep = await stageCentos7Ripgrep(plan, workDir, env);
      if (licenseDir) {
        await mkdir(licenseDir, { recursive: true });
        await writeFile(
          join(licenseDir, "search-build-manifest.json"),
          `${JSON.stringify(
            {
              glibcBaseline: CENTOS7_NATIVE_SEARCH_GLIBC_BASELINE,
              sources: sourceArchives,
              ripgrep,
              bfsConfigureArgs: NATIVE_SEARCH_BFS_CONFIGURE_ARGS,
            },
            null,
            2,
          )}\n`,
        );
      }
    } else
      verifyBuiltNativeSearchProducerOutputs({
        bfsPath: plan.bfsPath,
        ugrepPath: plan.ugrepPath,
        platform: plan.platform,
        arch: plan.arch,
        producerOutputIds: plan.producerOutputIds,
      });
    console.log(`==> Built ${plan.bfsPath}`);
    console.log(`==> Built ${plan.ugrepPath}`);
    return plan;
  } finally {
    if (keepWorkdir) {
      console.log(`==> Preserved workdir ${workDir}`);
    } else {
      await rm(workDir, { recursive: true, force: true });
    }
  }
}

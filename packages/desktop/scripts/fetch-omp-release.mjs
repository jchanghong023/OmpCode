#!/usr/bin/env node

// 内嵌 omp 二进制下载：取 jchanghong023/oh-my-pi releases 最新（或 OMP_RELEASE_TAG 指定）
// 版本的平台二进制，校验 SHA256 后暂存到 bundled-agents/<platformKey>/glm/omp/。
// 需求（FORK.md）：用户无需安装 omp；内嵌拷贝绝不触碰用户已安装的 omp。
//
// 环境变量：
//   OMP_RELEASE_TAG           指定 release tag（缺省 latest）
//   OMP_RELEASE_BINARY_PATH   离线/镜像：直接使用本地二进制文件（跳过下载）
//   OMP_RELEASE_SKIP=1        跳过下载（产物缺失时由运行时报错）
// 下载缓存：packages/desktop/.omp-release-cache/<tag>/<asset>，重复构建不重复下载。

import { createHash } from "node:crypto";
import { copyFileSync, createReadStream, existsSync, mkdirSync, readFileSync, rmSync, statSync, writeFileSync } from "node:fs";
import { createWriteStream } from "node:fs";
import { dirname, resolve } from "node:path";
import process from "node:process";
import { fileURLToPath } from "node:url";
import { pipeline } from "node:stream/promises";

const scriptDir = dirname(fileURLToPath(import.meta.url));
const desktopRoot = resolve(scriptDir, "..");
const repoRoot = resolve(desktopRoot, "..", "..");
const GITHUB_API = process.env.OMP_RELEASE_API_BASE || "https://api.github.com/repos/jchanghong023/oh-my-pi/releases";
const DOWNLOAD_BASE = process.env.OMP_RELEASE_DOWNLOAD_BASE || "https://github.com/jchanghong023/oh-my-pi/releases/download";

function normalizePlatform(raw) {
  if (raw === "mac" || raw === "macos" || raw === "darwin" || raw === "osx") return "darwin";
  if (raw === "win" || raw === "windows" || raw === "win32") return "win32";
  return raw || process.platform;
}

function normalizeArch(raw) {
  if (raw === "x86_64" || raw === "amd64") return "x64";
  if (raw === "aarch64") return "arm64";
  return raw || process.arch;
}

const platform = normalizePlatform(process.env.ZCODE_TARGET_OS);
const arch = normalizeArch(process.env.ZCODE_TARGET_ARCH);
const platformKey = `${platform}-${arch}`;

const assetName = resolveAssetName(platform, arch);
const cacheDir = resolve(desktopRoot, ".omp-release-cache");
const glmOmpDir = resolve(desktopRoot, "bundled-agents", platformKey, "glm", "omp");
const targetBinaryName = platform === "win32" ? "omp.exe" : "omp";
const targetPath = resolve(glmOmpDir, targetBinaryName);
const manifestPath = resolve(glmOmpDir, "omp-release.json");

function resolveAssetName(targetPlatform, targetArch) {
  if (targetPlatform === "win32") {
    if (targetArch !== "x64") throw new Error(`[fetch-omp] 无 win32-${targetArch} 的 omp release 资产`);
    return "omp-windows-x64.exe";
  }
  if (targetPlatform === "darwin") {
    return null;
  }
  // linux：musl 检测保守起见默认 glibc；CI 可用 OMP_LINUX_LIBC=musl 覆盖。
  const libc = process.env.OMP_LINUX_LIBC === "musl" ? "musl-" : "";
  return `omp-linux-${libc}${targetArch}`;
}

async function fetchJson(url) {
  const response = await fetch(url, {
    headers: {
      Accept: "application/vnd.github+json",
      ...(process.env.GITHUB_TOKEN ? { Authorization: `Bearer ${process.env.GITHUB_TOKEN}` } : {}),
      "User-Agent": "omp-agent-fetch",
    },
  });
  if (!response.ok) {
    throw new Error(`[fetch-omp] GitHub API ${response.status}: ${url}`);
  }
  return response.json();
}

async function sha256OfFile(path) {
  const hash = createHash("sha256");
  await pipeline(createReadStream(path), hash);
  return hash.digest("hex");
}

async function downloadToFile(url, destination) {
  const response = await fetch(url, {
    headers: { "User-Agent": "omp-agent-fetch" },
    ...(process.env.GITHUB_TOKEN ? { Authorization: `Bearer ${process.env.GITHUB_TOKEN}` } : {}),
  });
  if (!response.ok || !response.body) {
    throw new Error(`[fetch-omp] 下载失败 ${response.status}: ${url}`);
  }
  mkdirSync(dirname(destination), { recursive: true });
  const temporary = `${destination}.part`;
  await pipeline(response.body, createWriteStream(temporary));
  rmSync(destination, { force: true });
  await pipeline(createReadStream(temporary), createWriteStream(destination));
  rmSync(temporary, { force: true });
}

async function resolveLatestTag() {
  const release = await fetchJson(`${GITHUB_API}/latest`);
  return release.tag_name;
}

async function fetchChecksums(tag) {
  const url = `${DOWNLOAD_BASE}/${encodeURIComponent(tag)}/SHA256SUMS.txt`;
  const response = await fetch(url, { headers: { "User-Agent": "omp-agent-fetch" } });
  if (!response.ok) return null;
  const text = await response.text();
  const map = new Map();
  for (const line of text.split("\n")) {
    const match = /^\s*([0-9a-f]{64})\s+\*?(.+?)\s*$/.exec(line);
    if (match) {
      map.set(match[2], match[1]);
    }
  }
  return map;
}

async function main() {
  if (process.env.OMP_RELEASE_SKIP === "1") {
    console.log("[fetch-omp] OMP_RELEASE_SKIP=1，跳过内嵌 omp 下载");
    return;
  }
  if (assetName === null) {
    // omp releases 当前不提供 darwin 资产（FORK.md 已知限制）：不阻塞多平台构建链，
    // 仅警告跳过；运行时 omp-agent 会显式报「内嵌 omp 二进制未找到」。
    console.warn(`[fetch-omp] omp releases 无 ${platform}-${arch} 资产，跳过内嵌（FORK.md 已知限制）`);
    return;
  }
  mkdirSync(glmOmpDir, { recursive: true });

  if (process.env.OMP_RELEASE_BINARY_PATH) {
    const localPath = resolve(repoRoot, process.env.OMP_RELEASE_BINARY_PATH);
    if (!existsSync(localPath)) {
      throw new Error(`[fetch-omp] OMP_RELEASE_BINARY_PATH 不存在：${localPath}`);
    }
    copyFileSync(localPath, targetPath);
    writeFileSync(manifestPath, `${JSON.stringify({ source: "local", path: process.env.OMP_RELEASE_BINARY_PATH }, null, 2)}\n`);
    console.log(`[fetch-omp] 使用本地 omp 二进制 ${localPath} -> ${targetPath}`);
    return;
  }

  const tag = process.env.OMP_RELEASE_TAG || (await resolveLatestTag());
  const tagCacheDir = resolve(cacheDir, tag);
  const cachedAsset = resolve(tagCacheDir, assetName);
  const cachedManifest = resolve(tagCacheDir, "manifest.json");

  if (!existsSync(cachedAsset) || !existsSync(cachedManifest)) {
    const checksums = await fetchChecksums(tag);
    const expected = checksums?.get(assetName);
    const url = `${DOWNLOAD_BASE}/${encodeURIComponent(tag)}/${assetName}`;
    console.log(`[fetch-omp] 下载 ${url}`);
    await downloadToFile(url, cachedAsset);
    if (expected) {
      const actual = await sha256OfFile(cachedAsset);
      if (actual !== expected) {
        rmSync(cachedAsset, { force: true });
        throw new Error(`[fetch-omp] SHA256 校验失败：${assetName}（期望 ${expected}，实际 ${actual}）`);
      }
      console.log(`[fetch-omp] SHA256 校验通过 ${expected.slice(0, 12)}…`);
    } else {
      console.warn("[fetch-omp] release 未提供 SHA256SUMS，跳过校验");
    }
    writeFileSync(cachedManifest, `${JSON.stringify({ tag, asset: assetName }, null, 2)}\n`);
  } else {
    console.log(`[fetch-omp] 命中缓存 ${cachedAsset}`);
  }

  const stagedManifest = JSON.parse(readFileSync(cachedManifest, "utf8"));
  const stagedTag = stagedManifest.tag;
  try {
    copyFileSync(cachedAsset, targetPath);
  } catch (error) {
    // dev 回环时正在运行的 omp.exe 会锁住目标文件；内容一致则视为已就位。
    if (existsSync(targetPath) && statSync(targetPath).size === statSync(cachedAsset).size) {
      console.log("[fetch-omp] 目标被占用但已存在同尺寸二进制，跳过覆盖");
    } else {
      throw error;
    }
  }
  const size = statSync(targetPath).size;
  writeFileSync(
    manifestPath,
    `${JSON.stringify({ tag: stagedTag, asset: assetName, bytes: size, platform: platformKey }, null, 2)}\n`,
  );
  console.log(`[fetch-omp] 暂存 omp ${stagedTag} (${(size / 1024 / 1024).toFixed(1)} MiB) -> ${targetPath}`);
}

await main();

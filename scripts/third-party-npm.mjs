import { execFile } from "node:child_process";
import { createHash } from "node:crypto";
import { readFile, readdir, realpath } from "node:fs/promises";
import { join, relative } from "node:path";
import { promisify } from "node:util";
import { parse as parseYaml } from "yaml";
import { resolveSpawnRuntimeOptions } from "./spawn-command.mjs";

const exec = promisify(execFile);
export const hashBytes = (bytes) => createHash("sha256").update(bytes).digest("hex");
const unsupportedCanvas = new Set([
  "@napi-rs/canvas-android-arm64",
  "@napi-rs/canvas-linux-arm-gnueabihf",
  "@napi-rs/canvas-linux-riscv64-gnu",
]);
const noticeName =
  /(?:^|[._-])(?:licen[sc]es?|copying|notice|copyright|unlicense|third.party|ofl)(?:[._-]|$)/iu;

async function readPackageNotices(directory) {
  const files = [];
  async function visit(path) {
    for (const entry of await readdir(path, { withFileTypes: true })) {
      if (["node_modules", ".git", "test", "tests", "fixtures"].includes(entry.name)) continue;
      // Chromium 聚合许可由打包流程经 resources/licenses/electron 单独分发，不进 npm 通知。
      if (entry.isFile() && entry.name === "LICENSES.chromium.html") continue;
      const full = join(path, entry.name);
      if (entry.isDirectory()) await visit(full);
      else if (entry.isFile() && noticeName.test(entry.name)) {
        const bytes = await readFile(full);
        if (bytes.includes(0) || bytes.length === 0) continue;
        files.push({ member: relative(directory, full).replaceAll("\\", "/"), bytes });
      } else if (entry.isFile() && /^readme(?:\.[^/]*)?$/iu.test(entry.name)) {
        const text = await readFile(full, "utf8");
        const match = /^(?:#{1,6}\s+licen[sc]e[^\n]*\n|licen[sc]e\s*\n[=-]+\n)/imu.exec(text);
        if (match) {
          const section = text.slice(match.index).split(/\n(?=#{1,6}\s)/u)[0];
          files.push({
            member: `${relative(directory, full).replaceAll("\\", "/")} (license section)`,
            bytes: Buffer.from(section),
          });
        }
      }
    }
  }
  await visit(directory);
  return files.sort((a, b) => a.member.localeCompare(b.member, "en"));
}

function productionPackages(projects) {
  const own = new Set(projects.map((project) => project.name));
  const required = new Map();
  function dependencies(deps) {
    for (const [alias, info] of Object.entries(deps ?? {})) {
      const name = info.name ?? alias;
      if (!own.has(name) && !name.startsWith("@zcode/") && !info.version.startsWith("link:")) {
        required.set(`${name}@${info.version}`, { name, version: info.version });
      }
      dependencies(info.dependencies);
      dependencies(info.optionalDependencies);
    }
  }
  for (const project of projects) {
    dependencies(project.dependencies);
    dependencies(project.optionalDependencies);
  }
  return required;
}

async function nonApplicableOptionalPackages(root) {
  const [lockfile, modules, workspace] = await Promise.all(
    ["pnpm-lock.yaml", "node_modules/.modules.yaml", "pnpm-workspace.yaml"].map(async (file) =>
      parseYaml(await readFile(join(root, file), "utf8")),
    ),
  );
  const skipped = new Set(modules.skipped ?? []);
  const architectures = workspace.supportedArchitectures ?? {};
  function matches(wanted, supported) {
    if (!wanted) return true;
    const values = (Array.isArray(wanted) ? wanted : [wanted]).filter(
      (value) => typeof value === "string",
    );
    if (values.length === 1 && values[0] === "any") return true;
    if (supported.some((value) => values.includes(`!${value}`))) return false;
    return (
      values.every((value) => value.startsWith("!")) ||
      supported.some((value) => values.includes(value))
    );
  }
  const supported = Object.fromEntries(
    [
      ["os", process.platform],
      ["cpu", process.arch],
    ].map(([field, current]) => [
      field,
      (architectures[field] ?? ["current"]).map((value) => (value === "current" ? current : value)),
    ]),
  );
  return new Set(
    Object.entries(lockfile.snapshots).flatMap(([id, snapshot]) => {
      const key = id.split("(")[0];
      const metadata = lockfile.packages[key];
      // pnpm JSON 丢弃 isSkipped/optional。只接受安装器已跳过、锁文件确认 optional，
      // 且 OS/CPU 与全部支持目标不相交的包；普通 optional 缺失或构建失败仍须报错。
      if (
        !snapshot.optional ||
        !skipped.has(id) ||
        !metadata ||
        (matches(metadata.os, supported.os) && matches(metadata.cpu, supported.cpu))
      )
        return [];
      return [key];
    }),
  );
}

function assertProductionGraphs(lockedProjects, installedProjects, skippedPackages) {
  const locked = productionPackages(lockedProjects);
  const installed = productionPackages(installedProjects);
  const missing = [...locked].filter(
    ([key, item]) =>
      !installed.has(key) && !unsupportedCanvas.has(item.name) && !skippedPackages.has(key),
  );
  const stale = [...installed.keys()].filter((key) => !locked.has(key));
  if (missing.length || stale.length) {
    throw new Error(
      `Installed production graph differs from pnpm-lock.yaml. Run pnpm install --frozen-lockfile.\nMissing: ${missing.map(([key]) => key).join(", ")}\nStale: ${stale.join(", ")}`,
    );
  }
  return locked;
}

export async function readWorkspaceProductionGraph(root) {
  root = await realpath(root);
  async function list(cwd, args) {
    const { stdout } = await exec("pnpm", ["ls", ...args, "--json"], {
      cwd,
      maxBuffer: 256 * 1024 * 1024,
      ...resolveSpawnRuntimeOptions("pnpm"),
    });
    return JSON.parse(stdout);
  }
  // -1 只枚举 workspace manifest，不展开依赖，也不扫描提升安装中的 unsaved 包。
  const projects = await list(root, ["-r", "--depth", "-1"]);
  projects.sort((a, b) => a.path.localeCompare(b.path, "en"));
  const locked = [];
  const actual = [];
  // pnpm 10 的递归 ls 对所有项目 Promise.all，并发读取同一提升目录的 unsaved 包；
  // workspace-concurrency 不约束这条路径。每次仅展开一个项目，锁文件与安装图也串行。
  for (const project of projects) {
    const args = ["--prod", "--depth", "Infinity"];
    // 项目路径仅作 cwd，不进入 Windows shell 命令参数。
    locked.push(...(await list(project.path, [...args, "--lockfile-only"])));
    actual.push(...(await list(project.path, args)));
  }
  const skippedPackages = await nonApplicableOptionalPackages(root);
  const required = assertProductionGraphs(locked, actual, skippedPackages);
  return { required, projects: actual, skippedPackages };
}

export async function scanInstalledPackages(root, projects) {
  // pnpm hoisted 布局的 ls.path 仍可能指向不存在的 .pnpm 路径；按真实安装目录和精确版本匹配。
  const installed = new Map();
  const visited = new Set();
  async function scanNodeModules(directory) {
    let actual;
    try {
      actual = await realpath(directory);
    } catch (error) {
      if (error.code === "ENOENT") return;
      throw error;
    }
    if (visited.has(actual)) return;
    visited.add(actual);
    const entries = await readdir(directory, { withFileTypes: true });
    for (const entry of entries) {
      if (entry.name.startsWith(".")) continue;
      const path = join(directory, entry.name);
      if (entry.name.startsWith("@")) {
        for (const scoped of await readdir(path)) await scanPackage(join(path, scoped));
      } else await scanPackage(path);
    }
  }
  async function scanPackage(directory) {
    let pkg;
    try {
      pkg = JSON.parse(await readFile(join(directory, "package.json"), "utf8"));
    } catch (error) {
      if (["ENOENT", "ENOTDIR"].includes(error.code)) return;
      throw error;
    }
    if (pkg.name && pkg.version) installed.set(`${pkg.name}@${pkg.version}`, { pkg, directory });
    await scanNodeModules(join(directory, "node_modules"));
  }
  for (const project of projects) await scanNodeModules(join(project.path, "node_modules"));
  await scanNodeModules(join(root, "node_modules"));
  return installed;
}

export function missingProductionPackages(required, installed, skippedPackages = new Set()) {
  const missing = [...required].filter(([key]) => !installed.has(key)).map(([, item]) => item);
  for (const item of missing) {
    if (!unsupportedCanvas.has(item.name) && !skippedPackages.has(`${item.name}@${item.version}`))
      throw new Error(`Missing installed dependency: ${item.name}@${item.version}`);
  }
  return missing;
}

export async function collectNpmNotices(root, overrides) {
  root = await realpath(root);
  const { required, projects, skippedPackages } = await readWorkspaceProductionGraph(root);
  // 修复：标识门禁和声明生成必须扫描同一安装集合，避免嵌套版本只进声明、不进门禁。
  const installed = await scanInstalledPackages(root, projects);
  const packages = [];
  const missing = [];
  const notInstalled = missingProductionPackages(required, installed, skippedPackages);
  for (const [key, item] of [...required].sort(([a], [b]) => a.localeCompare(b, "en"))) {
    const installedPackage = installed.get(key);
    if (!installedPackage) {
      continue;
    }
    const { pkg, directory } = installedPackage;
    const notices = await readPackageNotices(directory);
    const override = overrides.find((record) => record.package === key);
    if (override?.file) {
      const bytes = await readFile(join(root, override.file));
      if (hashBytes(bytes) !== override.sha256) throw new Error(`Changed upstream notice: ${key}`);
      notices.push({ member: override.source, bytes });
    }
    // README 中仅有 MIT 等标签不能冒充完整许可文件；这种包仍需要版本固定的补充材料。
    if (
      !notices.some(({ member }) => !member.endsWith(" (license section)")) &&
      !override?.acceptedMissingNotice
    )
      missing.push(key);
    packages.push({
      ...item,
      license:
        pkg.license ??
        pkg.licenses?.map((item) => (typeof item === "string" ? item : item.type)).join(" OR ") ??
        override?.license ??
        "(not declared)",
      repository: typeof pkg.repository === "string" ? pkg.repository : pkg.repository?.url,
      ...(override?.acceptedMissingNotice
        ? { acceptedMissingNotice: override.acceptedMissingNotice }
        : {}),
      notices,
    });
  }
  if (missing.length) throw new Error(`Missing complete upstream notices:\n${missing.join("\n")}`);
  return {
    packages,
    notInstalled,
    workspaceManifests: projects.map((project) =>
      relative(root, join(project.path, "package.json")).replaceAll("\\", "/"),
    ),
  };
}

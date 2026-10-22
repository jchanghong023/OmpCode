import { spawn } from "node:child_process";
import { cp, glob, lstat, mkdir, readFile, realpath, writeFile } from "node:fs/promises";
import { dirname, isAbsolute, join, relative, resolve, sep } from "node:path";
import { fileURLToPath } from "node:url";
import { quoteArgsForWindowsShell, resolveSpawnRuntimeOptions } from "./spawn-command.mjs";

const sourceWorkspaceRoot = resolve(dirname(fileURLToPath(import.meta.url)), "..");
export const CENTOS7_DEPENDENCY_PINS = Object.freeze({
  electron: "28.3.3",
  "better-sqlite3": "9.6.0",
  undici: "6.23.0",
  // Sharp 0.33+ Linux prebuilds require a newer glibc. An override does not add an absent package.
  sharp: "0.32.6",
});
const dependencySections = ["dependencies", "devDependencies", "optionalDependencies"];
const excludedDirectories = new Set([
  ".git",
  "node_modules",
  "out",
  "dist",
  ".cache",
  ".turbo",
  ".vite",
  ".pnpm-store",
  ".e2e-cache",
  ".e2e-artifacts",
  "coverage",
  "test-results",
  "playwright-report",
  "bundled-agents",
  "bundled-cua-helper",
  "dist-cua-helper",
  ".omp",
  ".ompcode",
  ".zcode",
]);

function isWithin(parent, child) {
  const path = relative(parent, child);
  return path === "" || (!isAbsolute(path) && path !== ".." && !path.startsWith(`..${sep}`));
}

async function canonicalDestination(path) {
  try {
    return await realpath(path);
  } catch (error) {
    if (error.code !== "ENOENT") throw error;
    const parent = dirname(path);
    if (parent === path) throw error;
    return join(await canonicalDestination(parent), relative(parent, path));
  }
}

async function readJson(path) {
  return JSON.parse(await readFile(path, "utf8"));
}

async function writeJson(path, value) {
  await writeFile(path, `${JSON.stringify(value, null, 2)}\n`, "utf8");
}

async function findManifests(root) {
  // Match the repository workspace layout, not package.json fixtures or vendored examples.
  // This is a Node 24 build tool; application runtime compatibility does not constrain glob here.
  const patterns = [
    "package.json",
    "apps/dev-docs/package.json",
    "packages/*/package.json",
    "apps/zcode-cli/package.json",
    "apps/zcode-cli/packages/*/package.json",
    "apps/zcode-cli/tools/*/package.json",
  ];
  const manifests = [];
  for await (const path of glob(patterns, { cwd: root })) {
    manifests.push(join(root, path));
  }
  return manifests;
}

async function applyDependencyProfile(workspace) {
  const rootPath = join(workspace, "package.json");
  const root = await readJson(rootPath);
  root.pnpm ??= {};
  // Keep the current checkout's overrides (including React), never a historical main profile.
  root.pnpm.overrides = { ...root.pnpm.overrides, ...CENTOS7_DEPENDENCY_PINS };
  await writeJson(rootPath, root);

  for (const path of await findManifests(workspace)) {
    const manifest = await readJson(path);
    let changed = false;
    for (const section of dependencySections) {
      for (const [name, version] of Object.entries(CENTOS7_DEPENDENCY_PINS)) {
        if (manifest[section]?.[name] !== undefined && manifest[section][name] !== version) {
          manifest[section][name] = version;
          changed = true;
        }
      }
    }
    if (path === join(workspace, "packages", "desktop", "package.json")) {
      manifest.devDependencies ??= {};
      manifest.devDependencies.electron = CENTOS7_DEPENDENCY_PINS.electron;
      // The repository keeps this dev-only for the modern native SQLite branch.
      // In the isolated Linux workspace it is an explicit production closure root.
      delete manifest.devDependencies["better-sqlite3"];
      manifest.dependencies ??= {};
      manifest.dependencies["better-sqlite3"] = CENTOS7_DEPENDENCY_PINS["better-sqlite3"];
      changed = true;
    }
    if (changed) await writeJson(path, manifest);
  }
}

async function resolveWorkspaceLockfile(workspace) {
  const command = "pnpm";
  const args = ["install", "--lockfile-only", "--no-frozen-lockfile", "--ignore-scripts"];
  const runtimeOptions = resolveSpawnRuntimeOptions(command);
  await new Promise((resolvePromise, reject) => {
    const child = spawn(command, runtimeOptions.shell ? quoteArgsForWindowsShell(args) : args, {
      cwd: workspace,
      // stdout is reserved for the resulting workspace path, including in shell substitution.
      stdio: ["ignore", process.stderr, process.stderr],
      ...runtimeOptions,
    });
    child.once("error", reject);
    child.once("exit", (code, signal) => {
      if (code === 0) resolvePromise();
      else reject(new Error(`Temporary workspace lockfile resolution failed (${signal ?? code})`));
    });
  });
}

/** Copy current source bytes, then resolve only the isolated workspace's dependency profile. */
export async function createBuildWorkspace(destination, { sourceRoot = sourceWorkspaceRoot } = {}) {
  if (typeof destination !== "string" || destination.trim() === "") {
    throw new Error("create requires a non-empty destination path");
  }
  const source = await realpath(resolve(sourceRoot));
  const target = await canonicalDestination(resolve(destination));
  if (isWithin(source, target) || isWithin(target, source)) {
    throw new Error("Destination must be outside the source workspace and cannot contain it");
  }
  // Reject even empty directories, dangling links and aliases; never overwrite an original tree.
  try {
    await lstat(resolve(destination));
    throw new Error(`Destination already exists: ${destination}`);
  } catch (error) {
    if (error.code !== "ENOENT") throw error;
  }
  await readJson(join(source, "package.json"));
  await readFile(join(source, "pnpm-lock.yaml"), "utf8");
  await mkdir(dirname(target), { recursive: true });
  // Dereference source-local links into independent bytes, never preserve links back to originals.
  // cp 在 errorOnExist 模式下自行创建根目录；提前 mkdir 会让全新工作区也报 EEXIST。
  await cp(source, target, {
    recursive: true,
    dereference: true,
    force: false,
    errorOnExist: true,
    preserveTimestamps: true,
    filter: async (path) => {
      const parts = relative(source, path).split(sep);
      if (parts.some((part) => excludedDirectories.has(part) || part.startsWith(".e2e-home-"))) {
        return false;
      }
      const stat = await lstat(path);
      if (stat.isSymbolicLink()) {
        const resolved = await realpath(path);
        if (!isWithin(source, resolved)) {
          throw new Error(`Source link escapes workspace: ${path}`);
        }
        if (
          relative(source, resolved)
            .split(sep)
            .some((part) => excludedDirectories.has(part))
        ) {
          return false;
        }
      }
      return true;
    },
  });
  await applyDependencyProfile(target);
  // pnpm owns YAML importers, peer snapshots and integrity resolution. Reuse the copied current
  // lockfile instead of deleting it or doing a broad update; no install lifecycle/build runs here.
  await resolveWorkspaceLockfile(target);
  return target;
}

/** Read manifests without installing, resolving, restoring, or modifying any workspace. */
export async function getBuildWorkspaceStatus(workspace = sourceWorkspaceRoot) {
  const root = await realpath(resolve(workspace));
  const manifest = await readJson(join(root, "package.json"));
  const desktop = await readJson(join(root, "packages", "desktop", "package.json"));
  const declarations = [];
  for (const path of await findManifests(root)) {
    const value = await readJson(path);
    for (const section of dependencySections) {
      for (const name of Object.keys(CENTOS7_DEPENDENCY_PINS)) {
        if (value[section]?.[name] !== undefined) {
          declarations.push({
            manifest: relative(root, path).split(sep).join("/"),
            section,
            name,
            version: value[section][name],
          });
        }
      }
    }
  }
  return {
    workspace: root,
    electron: desktop.devDependencies?.electron,
    runtimeSqlite: desktop.dependencies?.["better-sqlite3"] ?? null,
    overrides: manifest.pnpm?.overrides ?? {},
    declarations,
  };
}

export async function main(args = process.argv.slice(2)) {
  const [command, path, ...extra] = args;
  if (!command || command === "--help" || command === "-h" || command === "help") {
    console.log(
      "Usage: node scripts/prepare-centos7-build.mjs create <destination>\n       node scripts/prepare-centos7-build.mjs status [workspace]\n\ncreate requires pnpm 10.33.2 on PATH and a new destination outside the source tree.\nIt copies current source (including uncommitted edits), applies exact CentOS runtime pins,\nand resolves a temporary lockfile with scripts disabled. Source manifests/lock stay unchanged.\nInstall dependencies afterward in that workspace with pnpm install --frozen-lockfile --ignore-scripts.\nstatus only reads manifests. Neither command builds or runs tests.",
    );
    return;
  }
  if (extra.length || (command === "create" && !path))
    throw new Error("Invalid arguments; use --help");
  if (command === "create") console.log(await createBuildWorkspace(path));
  else if (command === "status")
    console.log(JSON.stringify(await getBuildWorkspaceStatus(path), null, 2));
  else throw new Error(`Unknown command: ${command}; use --help`);
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  main().catch((error) => {
    console.error(error.message);
    process.exitCode = 1;
  });
}

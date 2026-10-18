import { homedir } from "node:os";
import { posix } from "node:path";
import {
  ensureOfflineDataRoot,
  resolveOfflineDataRoots,
  resolveOmpCodePersistentRoot,
  type OfflineDataRootOptions,
  type OfflineDataRoots,
} from "@zcode/shared/node";

const { join } = posix;

export interface OfflineDesktopPaths {
  roots: OfflineDataRoots;
  appData: string;
  userData: string;
  sessionData: string;
  cache: string;
  temp: string;
  crashDumps: string;
  logs: string;
}

/** Pure path selection; injection is for isolated host-platform tests, not a runtime bypass. */
export function resolveOfflineDesktopPaths(
  applicationName: string,
  options: OfflineDataRootOptions & { home?: string } = {},
): OfflineDesktopPaths | undefined {
  const env = options.env ?? process.env;
  const persistentRoot = resolveOmpCodePersistentRoot(options.home ?? homedir(), env, options);
  const roots = resolveOfflineDataRoots(persistentRoot, "ompcode", options);
  if (!roots) return undefined;
  const appData = join(roots.runtimeRoot, "electron");
  const userData = join(appData, applicationName);
  return {
    roots,
    appData,
    userData,
    sessionData: join(userData, "session"),
    cache: join(roots.runtimeRoot, "cache"),
    // Chromium 单实例 socket 会追加子路径；用完整域哈希的紧凑编码避免超长，仍按原规则校验私有 shm。
    temp: join(
      "/dev/shm",
      `ompcode-tmp-${Buffer.from(roots.domainId, "hex").toString("base64url")}`,
    ),
    crashDumps: join(roots.runtimeRoot, "v2", "crash-dumps"),
    logs: join(roots.runtimeRoot, "v2", "logs"),
  };
}

/** Only validates/creates local runtime paths; never probes the persistent or backup root. */
export function initializeOfflineDesktopEnvironment(
  paths: OfflineDesktopPaths,
  env: NodeJS.ProcessEnv = process.env,
  ensure: (roots: OfflineDataRoots) => void = ensureOfflineDataRoot,
): void {
  const root = paths.roots.runtimeRoot;
  const directories = [
    root,
    paths.appData,
    paths.userData,
    paths.sessionData,
    paths.cache,
    paths.temp,
    paths.crashDumps,
    paths.logs,
    join(root, "config"),
    join(root, "data"),
    join(root, "state"),
  ];
  for (const runtimeRoot of directories) ensure({ ...paths.roots, runtimeRoot });
  Object.assign(env, {
    ZCODE_HOME: root,
    TMPDIR: paths.temp,
    TMP: paths.temp,
    TEMP: paths.temp,
    XDG_CONFIG_HOME: join(root, "config"),
    XDG_DATA_HOME: join(root, "data"),
    XDG_CACHE_HOME: paths.cache,
    XDG_STATE_HOME: join(root, "state"),
  });
}

export function applyOfflineDesktopElectronPaths(
  app: {
    setPath(name: string, path: string): void;
    commandLine: { appendSwitch(name: string, value: string): void };
  },
  paths: OfflineDesktopPaths,
): void {
  for (const name of [
    "appData",
    "userData",
    "sessionData",
    "temp",
    "crashDumps",
    "logs",
  ] as const) {
    app.setPath(name, paths[name]);
  }
  // Electron has no public app path named "cache". Chromium and XDG need explicit overrides.
  app.commandLine.appendSwitch("disk-cache-dir", paths.cache);
}

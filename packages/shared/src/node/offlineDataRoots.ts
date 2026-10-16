import { createHash } from "node:crypto";
import { constants, accessSync, lstatSync, mkdirSync } from "node:fs";
import { hostname as machineHostname } from "node:os";
import { posix } from "node:path";

export interface OfflineDataRoots {
  persistentRoot: string;
  runtimeRoot: string;
  domainId: string;
}

export interface OfflineDataRootOptions {
  env?: NodeJS.ProcessEnv;
  platform?: NodeJS.Platform;
  hostname?: string;
  uid?: number;
}

export function isOfflineShmEnabled(
  env: NodeJS.ProcessEnv = process.env,
  platform: NodeJS.Platform = process.platform,
): boolean {
  return platform === "linux" && /^(?:1|true|yes|on)$/i.test(env.OMP_OFFLINE?.trim() ?? "");
}

/** 只做词法映射：启动不得通过 stat/realpath 探测 NFS 持久根。 */
export function resolveOfflineDataRoots(
  persistentRoot: string,
  namespace: "omp" | "ompcode",
  options: OfflineDataRootOptions = {},
): OfflineDataRoots | undefined {
  if (!isOfflineShmEnabled(options.env, options.platform)) return undefined;
  const uid = options.uid ?? process.getuid?.();
  if (uid === undefined || !Number.isSafeInteger(uid) || uid < 0) {
    throw new Error("Offline shm storage requires a valid user ID");
  }
  const domainId = createHash("sha256")
    .update(JSON.stringify([options.hostname ?? machineHostname(), uid, persistentRoot]))
    .digest("hex");
  return {
    persistentRoot,
    runtimeRoot: posix.join(
      "/dev/shm",
      `${namespace}-${uid}-${domainId}`,
      posix.basename(persistentRoot) || "root",
    ),
    domainId,
  };
}

/** 最早期 bootstrap 的必要同步 IO 仅限本机 shm；不创建或访问备份目录。 */
export function ensureOfflineDataRoot(roots: OfflineDataRoots): void {
  const relative = posix.relative("/dev/shm", roots.runtimeRoot);
  if (!relative || relative === ".." || relative.startsWith("../") || posix.isAbsolute(relative)) {
    throw new Error("Offline runtime root must be inside /dev/shm");
  }
  const uid = process.getuid?.();
  if (uid === undefined) throw new Error("Offline shm initialization requires Linux user identity");
  const shm = lstatSync("/dev/shm");
  if (!shm.isDirectory() || shm.isSymbolicLink()) {
    throw new Error("/dev/shm must be an existing real directory");
  }
  accessSync("/dev/shm", constants.W_OK | constants.X_OK);
  let directory = "/dev/shm";
  for (const component of relative.split("/")) {
    directory = posix.join(directory, component);
    try {
      mkdirSync(directory, { mode: 0o700 });
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "EEXIST") throw error;
    }
    const stat = lstatSync(directory);
    if (
      !stat.isDirectory() ||
      stat.isSymbolicLink() ||
      stat.uid !== uid ||
      (stat.mode & 0o077) !== 0
    ) {
      throw new Error("Unsafe offline shm directory: expected an owned, private directory (0700)");
    }
    accessSync(directory, constants.R_OK | constants.W_OK | constants.X_OK);
  }
}

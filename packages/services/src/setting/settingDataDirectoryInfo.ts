import { resolveOfflineDataRoots, resolveOmpCodePersistentRoot } from "@zcode/shared/node";
import { getZCodeDataRootDir } from "../paths.js";
import type { DataDirectoryInfo } from "./setting.js";

/** 只投影当前进程已解析的根，不读取设置、备份或 NFS 状态。 */
export async function getDataDirectoryInfo(): Promise<DataDirectoryInfo> {
  const runtimeRoot = getZCodeDataRootDir();
  const persistentRoot = resolveOmpCodePersistentRoot();
  const offlineRoots = resolveOfflineDataRoots(persistentRoot, "ompcode");
  return {
    runtimeRoot,
    persistentRoot: offlineRoots ? persistentRoot : runtimeRoot,
    offline: offlineRoots !== undefined,
  };
}

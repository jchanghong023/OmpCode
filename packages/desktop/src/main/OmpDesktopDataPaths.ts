import { homedir } from "node:os";
import { join } from "node:path";
import { resolveOmpCodeDataRootFromEnv } from "@zcode/shared/node";

/** Electron 与业务数据共用环境根；未设置时由原桌面默认路径继续解析。 */
export function resolveOmpDesktopDataPaths(
  applicationName: string,
  env: NodeJS.ProcessEnv = process.env,
  home = homedir(),
): { root: string; userData: string; sessionData: string } | undefined {
  const root = resolveOmpCodeDataRootFromEnv(home, env);
  if (!root) return undefined;
  const userData = join(root, "electron", applicationName);
  return { root, userData, sessionData: join(userData, "session") };
}

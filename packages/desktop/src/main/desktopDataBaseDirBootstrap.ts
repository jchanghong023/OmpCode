import { getDataBaseDir } from "@zcode/services/node";

/** Root resolution is captured by services before settings/loggers/Electron IO. */
export function applyEarlyDataBaseDirBootstrap(): string {
  // 原因：旧 ~/.zcode/setting.json 与 ZCODE_DATA_BASE_DIR 不能重定向 OmpCode。
  // 只读取已由启动环境确定的事实，不再读取/复制任何上游文件。
  return getDataBaseDir();
}

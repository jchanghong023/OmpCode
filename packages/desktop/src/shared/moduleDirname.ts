import { dirname } from "node:path";
import { fileURLToPath } from "node:url";

export function resolveImportMetaDirname(meta: ImportMeta): string {
  // 修复依据：CentOS 7 专用 Electron 28 内置 Node 18，尚不支持 import.meta.dirname。
  return meta.dirname ?? dirname(fileURLToPath(meta.url));
}

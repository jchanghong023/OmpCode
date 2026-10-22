import type { RuntimeInfo } from "@zcode/shared-types";

export { type RuntimeInfo };

export const getRuntimeInfo = (): RuntimeInfo => ({
  arch: process.arch,
  cwd: process.cwd(),
  execPath: process.execPath,
  node: process.version,
  platform: process.platform,
  // Node 18 没有 node:sea；沿用 CLI 现有的可选 builtin 探测，普通 Electron/Node 模式返回 false。
  sea: process.getBuiltinModule?.("node:sea")?.isSea() ?? false,
  versions: process.versions,
});

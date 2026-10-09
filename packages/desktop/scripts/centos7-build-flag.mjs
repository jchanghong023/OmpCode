// W1 构建双轨：`__OMPCODE_CENTOS7_DESKTOP__` define 注入源的唯一实现。
//
// 需求依据：docs/requirements/centos7-release.md「Electron 选型」——CentOS 7 构建任务在构建时
// 启用 `__OMPCODE_CENTOS7_DESKTOP__` 发布构建标记，供 UI 层的 CentOS 专用渲染性能策略识别；
// 仓库 manifest 按 Windows 基线维护，Windows 构建不得启用该标记。
//
// 判定规则（按优先级）：
// 1. 环境变量 OMPCODE_CENTOS7_DESKTOP=1：仅供本地开发临时验证 renderer 的 CentOS 渲染分支，
//    不用于发布构建；
// 2. packages/desktop/package.json 载体字段 ompCodeCentos7Desktop === true：由
//    scripts/prepare-centos7-build.mjs 在 CentOS 7 构建态写入，是发布构建的唯一打开方式；
// 3. 其余情况（含 Windows 基线）：false。
import { readFileSync } from "node:fs";
import { resolve } from "node:path";

const CENTOS7_DESKTOP_ENV_FLAG = "OMPCODE_CENTOS7_DESKTOP";
const CENTOS7_DESKTOP_MANIFEST_FIELD = "ompCodeCentos7Desktop";

const defaultDesktopPackageRoot = resolve(import.meta.dirname, "..");

export function isCentos7DesktopBuild({
  desktopPackageRoot = defaultDesktopPackageRoot,
  env = process.env,
} = {}) {
  if (env?.[CENTOS7_DESKTOP_ENV_FLAG] === "1") {
    return true;
  }
  const manifest = JSON.parse(readFileSync(resolve(desktopPackageRoot, "package.json"), "utf8"));
  return manifest[CENTOS7_DESKTOP_MANIFEST_FIELD] === true;
}

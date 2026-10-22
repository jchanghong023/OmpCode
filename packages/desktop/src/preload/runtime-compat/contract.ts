import type { ExecutionScript } from "electron";

/** 编译期确定的自包含安装函数；调用方只传 JSON 数据，不传来自网页的源码或函数。 */
export type TrustedPreloadMainWorldScript = ExecutionScript;

/** 只在隔离的 preload 中调用；不能经 contextBridge 暴露给 renderer。 */
export interface PreloadMainWorldInstaller {
  (script: TrustedPreloadMainWorldScript): void;
}

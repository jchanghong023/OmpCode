/** preload 可信主世界脚本安装的单一兼容适配器，不向 renderer 提供执行入口。 */
export const desktopRuntimeCompatPreloadModule = {
  id: "desktop-runtime-compat-preload",
  requires: [],
  provides: ["trusted-preload-main-world-installation"],
  publicEntrypoints: ["mainWorld.ts", "contract.ts"],
} as const;

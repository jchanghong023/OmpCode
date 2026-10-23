import { app } from "electron";
import { getAppConfigDir } from "@zcode/services/node";
import { ZCODE_PRODUCT_FLAVOR } from "@zcode/shared";
import { desktopProductIdentities } from "../../scripts/desktop-product-identity.mjs";

// 原因：静态依赖可能早于 index.ts 读取 Electron 路径；先确立 fork 身份，不能继承上游 userData/锁。
const electronApp = app as typeof app | undefined;
if (electronApp?.setName) {
  electronApp.setName(
    process.env.ZCODE_DESKTOP_APPLICATION_NAME?.trim() ||
      (electronApp.isPackaged
        ? desktopProductIdentities[ZCODE_PRODUCT_FLAVOR].productName
        : "OmpCode Dev"),
  );
}

export type ElectronAppPathName = "appData" | "userData";

export function isElectronAppPackaged(): boolean {
  return (app as unknown as { isPackaged?: boolean } | undefined)?.isPackaged === true;
}

export function getElectronAppPath(name: ElectronAppPathName): string {
  const electronApp = app as unknown as
    | { getPath?: (pathName: ElectronAppPathName) => string }
    | undefined;
  if (electronApp?.getPath) {
    return electronApp.getPath(name);
  }

  // 部分 main-process 单测只 mock 被测模块直接需要的 Electron API，
  // 间接导入 desktopRuntimeEnv 时可能拿不到 app。真实桌面运行仍走 app.getPath；
  // Node-only 测试用配置目录兜底，避免导入期常量把无关测试打断。
  return getAppConfigDir();
}

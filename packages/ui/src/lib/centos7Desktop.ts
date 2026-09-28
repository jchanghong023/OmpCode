declare const __OMPCODE_CENTOS7_DESKTOP__: boolean;

// 只在本专用分支的桌面 renderer 构建中定义；共享 UI 的 Web 入口仍可正常加载。
export const isCentos7DesktopBuild =
  typeof __OMPCODE_CENTOS7_DESKTOP__ !== "undefined" && __OMPCODE_CENTOS7_DESKTOP__;

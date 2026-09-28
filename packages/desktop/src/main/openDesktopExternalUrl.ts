import { shell } from "electron";

export function openDesktopExternalUrl(url: string): Promise<void> {
  // 修复原因：外部系统浏览器不经过 Electron 的内置浏览器 Session，不能绕过 CentOS 7 内网边界。
  if (process.env.OMPCODE_CENTOS7_LOCAL_ONLY === "1") {
    return Promise.reject(new Error("CentOS 7 desktop external links are disabled"));
  }
  return shell.openExternal(url);
}

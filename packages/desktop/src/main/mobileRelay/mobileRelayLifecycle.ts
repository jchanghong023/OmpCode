import { app, ipcMain } from "electron";
import type { UtilityProcess as ElectronUtilityProcess } from "electron";
import { BrowserWindow } from "electron";
import { PlatformChannels } from "@zcode/shared";
import { logger } from "../logger.js";
import { loadOrCreateMobileRelayCertificate } from "./mobileRelayCertificate.js";
import { MobileRelayServer } from "./mobileRelayServer.js";
import { requestBridgeableWorkspaces } from "./mobileRelayHostQueries.js";

/**
 * 手机远控内嵌中继的生命周期：app ready 后启动、退出前停止，
 * 并注册 Renderer 查询入口状态的 IPC（PlatformChannels.MobileRelayEntry）。
 */

let relayServer: MobileRelayServer | undefined;

export function getMobileRelayServer(): MobileRelayServer | undefined {
  return relayServer;
}

/** 焦点窗口优先；无焦点（后台/托盘）时取任一存活窗口的 Host。 */
function resolveFocusHostFrom(
  getHostProcess: (windowId: number) => ElectronUtilityProcess | undefined,
): ElectronUtilityProcess | undefined {
  const window =
    BrowserWindow.getFocusedWindow() ?? BrowserWindow.getAllWindows().find((item) => !item.isDestroyed());
  if (!window) return undefined;
  return getHostProcess(window.id);
}

export async function startMobileRelay(options: {
  getHostProcess: (windowId: number) => ElectronUtilityProcess | undefined;
}): Promise<MobileRelayServer> {
  if (relayServer) return relayServer;
  const certificate = await loadOrCreateMobileRelayCertificate(
    // 用户数据目录持久化证书：CA 固定复用，避免手机端反复重装信任锚。
    app.getPath("userData"),
  );
  const server = new MobileRelayServer({
    certificate,
    resolveFocusHost: () => resolveFocusHostFrom(options.getHostProcess),
    requestBridgeableWorkspaces: (host) => requestBridgeableWorkspaces(host),
  });
  await server.start();
  relayServer = server;
  ipcMain.handle(PlatformChannels.MobileRelayEntry, () => server.getStatus());
  return server;
}

export async function stopMobileRelay(): Promise<void> {
  try {
    ipcMain.removeHandler(PlatformChannels.MobileRelayEntry);
  } catch {
    // app 退出路径上 handler 可能已随进程销毁；忽略。
  }
  const server = relayServer;
  relayServer = undefined;
  if (!server) return;
  try {
    await server.stop();
  } catch (error) {
    logger.warn("mobile relay stop failed:", {
      error: error instanceof Error ? error.message : String(error),
    });
  }
}

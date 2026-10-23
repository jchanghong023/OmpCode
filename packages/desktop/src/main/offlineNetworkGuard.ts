import { app, session } from "electron";
import { subscribeBeforeRequest } from "./observeBeforeRequest.js";

/**
 * 离线网络隔离的 renderer 侧守卫（docs/requirements/offline-network-isolation.md）：
 * 所有 session（defaultSession 与全部 partition，含后续新建的 embedded-browser、
 * 插件沙箱等）的非回环 http/https/ws/wss 请求一律取消。走 subscribeBeforeRequest
 * 组合入口，不破坏资源管理器网络观测的同 session 订阅。
 * dev 模式 Vite dev server、本地媒体代理等回环目标不受影响。
 */

const NETWORK_URL_PATTERNS = ["http://*/*", "https://*/*", "ws://*/*", "wss://*/*"];

function isLoopbackHostname(hostname: string): boolean {
  const normalized = hostname.toLowerCase().replace(/^\[/, "").replace(/\]$/, "");
  return (
    normalized === "localhost" ||
    normalized === "::1" ||
    normalized === "::ffff:127.0.0.1" ||
    /^127\.\d{1,3}\.\d{1,3}\.\d{1,3}$/.test(normalized)
  );
}

function guardSession(target: Electron.Session): void {
  subscribeBeforeRequest(target.webRequest, NETWORK_URL_PATTERNS, (details) => {
    let hostname: string | null = null;
    try {
      hostname = new URL(details.url).hostname;
    } catch {
      return;
    }
    if (hostname && isLoopbackHostname(hostname)) return;
    return true;
  });
}

export function installOfflineSessionNetworkGuard(): void {
  guardSession(session.defaultSession);
  app.on("session-created", guardSession);
}

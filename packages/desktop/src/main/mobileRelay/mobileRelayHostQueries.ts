import { randomUUID } from "node:crypto";
import type { UtilityProcess as ElectronUtilityProcess } from "electron";
import {
  HostMessageTypes,
  type HostWindowBridgeableWorkspacesResultResponse,
  type WindowBridgeableWorkspace,
} from "@zcode/shared";

/**
 * 手机远控 bootstrap 的 Host 工作区查询（Main 侧请求-响应关联）。
 *
 * Main 向焦点窗口 Host 发 GetWindowBridgeableWorkspaces，Host 回
 * WindowBridgeableWorkspacesResult；此处持有 pending 关联与超时，供
 * desktopHostProcess 的消息分发回调 resolve。
 */

const QUERY_TIMEOUT_MS = 10_000;

interface PendingQuery {
  resolve: (workspaces: WindowBridgeableWorkspace[]) => void;
  reject: (error: Error) => void;
  timer: ReturnType<typeof setTimeout>;
}

const pendingQueries = new Map<string, PendingQuery>();

export function requestBridgeableWorkspaces(
  host: ElectronUtilityProcess,
): Promise<WindowBridgeableWorkspace[]> {
  const requestId = randomUUID();
  return new Promise<WindowBridgeableWorkspace[]>((resolve, reject) => {
    const timer = setTimeout(() => {
      pendingQueries.delete(requestId);
      reject(new Error(`bridgeable workspaces query timed out after ${QUERY_TIMEOUT_MS}ms`));
    }, QUERY_TIMEOUT_MS);
    timer.unref?.();
    pendingQueries.set(requestId, { resolve, reject, timer });
    try {
      host.postMessage({ type: HostMessageTypes.GetWindowBridgeableWorkspaces, requestId });
    } catch (error) {
      clearTimeout(timer);
      pendingQueries.delete(requestId);
      reject(error instanceof Error ? error : new Error(String(error)));
    }
  });
}

export function handleWindowBridgeableWorkspacesResult(
  response: HostWindowBridgeableWorkspacesResultResponse,
): void {
  const pending = pendingQueries.get(response.requestId);
  if (!pending) return;
  pendingQueries.delete(response.requestId);
  clearTimeout(pending.timer);
  if (response.ok && response.workspaces) {
    pending.resolve(response.workspaces);
  } else {
    pending.reject(new Error(response.error ?? "bridgeable workspaces query failed"));
  }
}

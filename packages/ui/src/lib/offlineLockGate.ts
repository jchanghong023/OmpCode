import { useSyncExternalStore } from "react";

/**
 * 离线锁定（CentOS 7 启动器 `--offline`，即 OMPCODE_CENTOS7_LOCAL_ONLY=1）的
 * renderer 侧唯一消费点。
 *
 * 需求边界（docs/requirements/FORK.md「上游同步策略与平台范围」、mobile-relay.md）：
 * 被关功能的 UI 入口在两平台一律保留并呈禁用态，附「离线锁定中已关闭」说明；
 * 不按平台删除或隐藏入口。锁定状态是运行时事实（是否传入 --offline），不是构建标记，
 * 因此 Windows 与未锁定的 CentOS 7 都是全功能。
 *
 * W3 正在 packages/shared 定义唯一门控状态接口；接口合入前，本模块按需求文档预期语义
 * 先行实现消费侧：读取启动时注入的全局只读快照，缺省视为未锁定。集成时若接口命名或
 * 载体有出入，只需调整 readInjectedSnapshot 的取数来源，禁用态消费方不动。
 */

export interface OfflineLockState {
  /** 企业离线锁定是否开启（CentOS 7 `--offline`）。 */
  localOnly: boolean;
}

const OFFLINE_LOCK_NOT_LOCKED: OfflineLockState = { localOnly: false };

/** Main/preload 在 renderer 脚本求值前注入的锁定快照载体；W3 集成时在此对齐命名。 */
interface OfflineLockGlobal {
  __OMPCODE_OFFLINE_LOCK__?: OfflineLockState;
}

function readInjectedSnapshot(): OfflineLockState {
  const injected = (globalThis as typeof globalThis & OfflineLockGlobal)
    .__OMPCODE_OFFLINE_LOCK__;
  // 只认布尔形态的 localOnly，畸形注入不改变缺省（未锁定）行为。
  if (injected && typeof injected.localOnly === "boolean") {
    return injected.localOnly ? { localOnly: true } : OFFLINE_LOCK_NOT_LOCKED;
  }
  return OFFLINE_LOCK_NOT_LOCKED;
}

let currentSnapshot: OfflineLockState = readInjectedSnapshot();
const listeners = new Set<() => void>();

/**
 * 供 W3 集成或测试在运行时更新锁定状态；与注入快照一致的单一写入口。
 * 状态不随渲染变化，正常会话中只会在启动早期被写入一次。
 */
export function applyOfflineLockState(state: OfflineLockState): void {
  const next = state.localOnly ? { localOnly: true } : OFFLINE_LOCK_NOT_LOCKED;
  if (next.localOnly === currentSnapshot.localOnly) return;
  currentSnapshot = next;
  for (const listener of listeners) listener();
}

export function subscribeOfflineLock(listener: () => void): () => void {
  listeners.add(listener);
  return () => {
    listeners.delete(listener);
  };
}

export function getOfflineLockSnapshot(): OfflineLockState {
  return currentSnapshot;
}

/** 非 React 场景（如 renderer 日志门控）的同步读取。 */
export function isOfflineLocked(): boolean {
  return currentSnapshot.localOnly;
}

/** React 消费口：被关功能入口用它切换禁用态与「离线锁定中已关闭」说明。 */
export function useOfflineLock(): boolean {
  return useSyncExternalStore(subscribeOfflineLock, getOfflineLockSnapshot, getOfflineLockSnapshot)
    .localOnly;
}

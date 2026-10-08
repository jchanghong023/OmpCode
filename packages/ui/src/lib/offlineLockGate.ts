import { useSyncExternalStore } from "react";
import type { IPlatformService, OfflineDisabledFeatures, OfflineGateState } from "@zcode/shared";
import { parseOfflineGateState } from "@zcode/shared";

/**
 * 离线锁定（CentOS 7 启动器 `--offline`）的 renderer 侧唯一消费点。
 *
 * 事实源是 W3 的唯一门控状态接口（packages/shared/src/offlineGate.ts）：Main 依据
 * `OMPCODE_CENTOS7_LOCAL_ONLY` 裁决一次，经 `PlatformChannels.OfflineGateState` /
 * `IPlatformService.getOfflineGateState` 暴露；renderer 只消费，不自行读环境变量解释。
 *
 * 需求边界（docs/requirements/FORK.md「上游同步策略与平台范围」）：
 * 被关功能的 UI 入口在两平台一律保留并呈禁用态，附「离线锁定中已关闭」说明；不按
 * 平台删除或隐藏入口。非桌面 / 未提供桥接 / 查询失败一律视为未锁定——Windows 与
 * 未加锁的 CentOS 7 全功能，锁定裁决只能来自 Main 的真实应答。
 */

const OFFLINE_LOCK_NOT_LOCKED: OfflineGateState = {
  localOnly: false,
  disabledFeatures: {
    publicUpdateCheck: false,
    publicConfig: false,
    publicHelp: false,
    community: false,
    feedback: false,
    account: false,
    externalBrowser: false,
    telemetry: false,
    hostOnlineBots: false,
    remoteRecommendedPrompts: false,
  },
};

let currentState: OfflineGateState = OFFLINE_LOCK_NOT_LOCKED;
const listeners = new Set<() => void>();

function sameGateState(a: OfflineGateState, b: OfflineGateState): boolean {
  if (a.localOnly !== b.localOnly) return false;
  return Object.keys(a.disabledFeatures)
    .map((key) => key as keyof OfflineDisabledFeatures)
    .every((key) => a.disabledFeatures[key] === b.disabledFeatures[key]);
}

function applyState(next: OfflineGateState): void {
  // 逐键值比较而非引用比较：不同来源（Main 应答/测试写入）的同值状态不得重复广播。
  if (sameGateState(next, currentState)) {
    return;
  }
  currentState = next;
  for (const listener of listeners) listener();
}

/**
 * 渲染前的早期日志等同步消费口；状态到达前的窗口期按未锁定处理（缺省安全侧），
 * 真实锁定应答到达后立即收敛为 error-only（centos7-performance.md）。
 */
export function isOfflineLocked(): boolean {
  return currentState.localOnly;
}

/** 逐功能禁用态只读口（键含义见 offlineGate.ts，全部 true 表示后端已关闭）。 */
export function getOfflineDisabledFeatures(): OfflineDisabledFeatures {
  return currentState.disabledFeatures;
}

/**
 * 供测试或未来同步快照提供方写入状态；业务代码不得绕过平台通道调用。
 * 输入经运行时校验，非法输入忽略并保持原状态。
 */
export function applyOfflineLockState(state: OfflineGateState): void {
  let validated: OfflineGateState;
  try {
    validated = parseOfflineGateState(state);
  } catch {
    return;
  }
  applyState(validated);
}

let primedPlatform: IPlatformService | null = null;

/**
 * 从平台通道拉取一次门控状态并接入订阅 store。幂等：同一 platform 只发一次请求；
 * Main 应答失败或载荷非法时保持未锁定，不打断启动。由 Root 挂载时调用。
 */
export function primeOfflineLockFromPlatform(platform: IPlatformService): void {
  if (primedPlatform === platform) {
    return;
  }
  primedPlatform = platform;
  void platform
    .getOfflineGateState?.()
    .then((state) => {
      // 仅采纳最新一次 prime 的应答；platform 切换（热更/测试）后旧应答不回写。
      if (primedPlatform === platform) {
        applyState(parseOfflineGateState(state));
      }
    })
    .catch(() => {
      // 查询失败按未锁定处理，不重试、不阻塞渲染。
    });
}

export function subscribeOfflineLock(listener: () => void): () => void {
  listeners.add(listener);
  return () => {
    listeners.delete(listener);
  };
}

export function getOfflineLockSnapshot(): OfflineGateState {
  return currentState;
}

/** React 消费口：整体锁定态（localOnly）。 */
export function useOfflineLock(): boolean {
  return useSyncExternalStore(subscribeOfflineLock, getOfflineLockSnapshot, getOfflineLockSnapshot)
    .localOnly;
}

/** React 消费口：单个功能的禁用态（键见 offlineGate.ts 的门控面清单）。 */
export function useOfflineFeature(feature: keyof OfflineDisabledFeatures): boolean {
  const state = useSyncExternalStore(
    subscribeOfflineLock,
    getOfflineLockSnapshot,
    getOfflineLockSnapshot,
  );
  return state.disabledFeatures[feature];
}

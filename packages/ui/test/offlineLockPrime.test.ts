import assert from "node:assert/strict";
import { test } from "node:test";
import type { IPlatformService, OfflineGateState } from "@zcode/shared";
import {
  applyOfflineLockState,
  getOfflineLockSnapshot,
  isOfflineLocked,
  primeOfflineLockFromPlatform,
  subscribeOfflineLock,
} from "../src/lib/offlineLockGate.js";

function buildPlatform(behavior: {
  state?: OfflineGateState;
  reject?: boolean;
  exposeMethod?: boolean;
}): IPlatformService {
  if (behavior.exposeMethod === false) {
    return {} as IPlatformService;
  }
  return {
    getOfflineGateState: () =>
      behavior.reject ? Promise.reject(new Error("bridge down")) : Promise.resolve(behavior.state!),
  } as unknown as IPlatformService;
}

const LOCKED: OfflineGateState = {
  localOnly: true,
  disabledFeatures: {
    mobileRelay: true,
    publicUpdateCheck: true,
    publicConfig: true,
    publicHelp: true,
    community: true,
    feedback: true,
    accountShare: true,
    externalBrowser: true,
    telemetry: true,
    hostOnlineBots: true,
    remoteRecommendedPrompts: true,
  },
};

test("缺省（未 prime / 平台未提供桥接）视为未锁定，Windows 全功能", async () => {
  assert.equal(isOfflineLocked(), false);
  primeOfflineLockFromPlatform(buildPlatform({ exposeMethod: false }));
  // 无桥接时不发请求；微任务排空后仍是未锁定。
  await new Promise((resolve) => setTimeout(resolve, 0));
  assert.equal(isOfflineLocked(), false);
  assert.deepEqual(getOfflineLockSnapshot(), { ...getOfflineLockSnapshot() });
  assert.equal(getOfflineLockSnapshot().localOnly, false);
});

test("prime 拉取 Main 应答后进入锁定态并通知订阅者；同平台幂等不重复请求", async () => {
  let calls = 0;
  let notified = 0;
  const unsubscribe = subscribeOfflineLock(() => {
    notified += 1;
  });
  try {
    const platform = {
      getOfflineGateState: () => {
        calls += 1;
        return Promise.resolve(LOCKED);
      },
    } as unknown as IPlatformService;
    primeOfflineLockFromPlatform(platform);
    primeOfflineLockFromPlatform(platform);
    await new Promise((resolve) => setTimeout(resolve, 0));
    assert.equal(calls, 1, "同一 platform 只发一次请求");
    assert.equal(isOfflineLocked(), true);
    assert.equal(getOfflineLockSnapshot().disabledFeatures.mobileRelay, true);
    assert.equal(notified, 1);
  } finally {
    unsubscribe();
    applyOfflineLockState({
      localOnly: false,
      disabledFeatures: { ...LOCKED.disabledFeatures, mobileRelay: false } as OfflineGateState["disabledFeatures"],
    });
    // 恢复未锁定基线（applyOfflineLockState 会经 schema 校验归一化全部键）。
  }
  assert.equal(isOfflineLocked(), false);
});

test("Main 应答失败或载荷非法时保持未锁定，不抛错不阻塞", async () => {
  primeOfflineLockFromPlatform(buildPlatform({ reject: true }));
  await new Promise((resolve) => setTimeout(resolve, 0));
  assert.equal(isOfflineLocked(), false);

  const invalid = { localOnly: "yes" } as unknown as OfflineGateState;
  applyOfflineLockState(invalid);
  assert.equal(isOfflineLocked(), false, "非法载荷必须被运行时校验拦截");
});

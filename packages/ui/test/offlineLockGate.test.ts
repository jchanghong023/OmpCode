import assert from "node:assert/strict";
import { test } from "node:test";
import type { OfflineGateState } from "@zcode/shared";
import {
  applyOfflineLockState,
  getOfflineLockSnapshot,
  isOfflineLocked,
  subscribeOfflineLock,
} from "../src/lib/offlineLockGate.js";

function lockedState(localOnly: boolean): OfflineGateState {
  return {
    localOnly,
    disabledFeatures: {
      publicUpdateCheck: localOnly,
      publicConfig: localOnly,
      publicHelp: localOnly,
      community: localOnly,
      feedback: localOnly,
      account: localOnly,
      externalBrowser: localOnly,
      telemetry: localOnly,
      hostOnlineBots: localOnly,
      remoteRecommendedPrompts: localOnly,
    },
  };
}

test("缺省（平台应答到达前）视为未锁定，Windows 与未加锁 CentOS 7 全功能", () => {
  assert.equal(isOfflineLocked(), false);
  assert.equal(getOfflineLockSnapshot().localOnly, false);
  // 逐功能缺省同样全部未关闭（offlineGate.ts 门控面键与 localOnly 同源）。
  assert.equal(Object.values(getOfflineLockSnapshot().disabledFeatures).some(Boolean), false);
});

test("applyOfflineLockState 切换锁定态并通知订阅者；相同值不重复通知", () => {
  let notified = 0;
  const unsubscribe = subscribeOfflineLock(() => {
    notified += 1;
  });
  try {
    applyOfflineLockState(lockedState(true));
    assert.equal(isOfflineLocked(), true);
    assert.equal(notified, 1);

    applyOfflineLockState(lockedState(true));
    assert.equal(notified, 1, "相同状态不得重复通知");

    applyOfflineLockState(lockedState(false));
    assert.equal(isOfflineLocked(), false);
    assert.equal(notified, 2);
  } finally {
    unsubscribe();
  }
});

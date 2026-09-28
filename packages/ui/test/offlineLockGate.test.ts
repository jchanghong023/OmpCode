import assert from "node:assert/strict";
import { test } from "node:test";
import {
  applyOfflineLockState,
  getOfflineLockSnapshot,
  isOfflineLocked,
  subscribeOfflineLock,
} from "../src/lib/offlineLockGate.js";

test("缺省（无注入快照）视为未锁定，Windows 与未加锁 CentOS 7 全功能", () => {
  assert.equal((globalThis as { __OMPCODE_OFFLINE_LOCK__?: unknown }).__OMPCODE_OFFLINE_LOCK__, undefined);
  assert.equal(isOfflineLocked(), false);
  assert.deepEqual(getOfflineLockSnapshot(), { localOnly: false });
});

test("applyOfflineLockState 切换锁定态并通知订阅者；相同值不重复通知", () => {
  let notified = 0;
  const unsubscribe = subscribeOfflineLock(() => {
    notified += 1;
  });
  try {
    applyOfflineLockState({ localOnly: true });
    assert.equal(isOfflineLocked(), true);
    assert.equal(notified, 1);

    applyOfflineLockState({ localOnly: true });
    assert.equal(notified, 1, "相同状态不得重复通知");

    applyOfflineLockState({ localOnly: false });
    assert.equal(isOfflineLocked(), false);
    assert.equal(notified, 2);
  } finally {
    unsubscribe();
  }
});

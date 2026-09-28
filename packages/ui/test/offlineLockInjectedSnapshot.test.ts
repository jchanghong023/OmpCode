import assert from "node:assert/strict";
import { test } from "node:test";

// 在模块加载前注入锁定快照，模拟 W3 门控接口在 renderer 脚本求值前注入的形态；
// 本文件独立成进程，避免与其他用例共享已初始化的模块状态。
(globalThis as { __OMPCODE_OFFLINE_LOCK__?: { localOnly: boolean } }).__OMPCODE_OFFLINE_LOCK__ = {
  localOnly: true,
};

const { isOfflineLocked, applyOfflineLockState } = await import("../src/lib/offlineLockGate.js");

test("启动时注入的 localOnly 快照决定初始锁定态", () => {
  assert.equal(isOfflineLocked(), true);
});

test("运行时更新可以解除锁定（--offline 未传入的全功能形态）", () => {
  applyOfflineLockState({ localOnly: false });
  assert.equal(isOfflineLocked(), false);
});

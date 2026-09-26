import assert from "node:assert/strict";
import test from "node:test";
import { useZCodeSessionStore } from "../src/store/zcodeSessionStore.js";

test("重复 streaming 通知不发布新的 workspace 状态，真实转移仍发布", () => {
  const workspacePath = "C:/performance-test-workspace";
  const taskId = "performance-test-task";
  const store = useZCodeSessionStore;
  let notifications = 0;
  const unsubscribe = store.subscribe(() => {
    notifications += 1;
  });
  try {
    store.getState().setTaskRuntimeState(workspacePath, taskId, "streaming");
    const first = store.getState();
    store.getState().setTaskRuntimeState(workspacePath, taskId, "streaming");
    assert.equal(store.getState(), first);
    assert.equal(notifications, 1);
    store.getState().setTaskRuntimeState(workspacePath, taskId, "failed", "reason");
    assert.equal(notifications, 2);
  } finally {
    unsubscribe();
  }
});

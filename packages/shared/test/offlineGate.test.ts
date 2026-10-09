import assert from "node:assert/strict";
import { test } from "node:test";
import { parseOfflineGateState, resolveOfflineGateState } from "../src/offlineGate.js";

test("Windows 默认启动保持全功能门控", () => {
  const gate = resolveOfflineGateState({});
  assert.equal(gate.localOnly, false);
  assert.deepEqual(gate.disabledFeatures, {
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
  });
});

test("运行时门控校验拒绝缺失、非法及未知功能，合法 IPC 状态保真", () => {
  const valid = resolveOfflineGateState({});
  assert.deepEqual(parseOfflineGateState(JSON.parse(JSON.stringify(valid))), valid);
  assert.throws(() => parseOfflineGateState(null));
  assert.throws(() => parseOfflineGateState({ ...valid, localOnly: "yes" }));
  assert.throws(() => parseOfflineGateState({ ...valid, disabledFeatures: {} }));
  assert.throws(() =>
    parseOfflineGateState({
      ...valid,
      disabledFeatures: { ...valid.disabledFeatures, publicUpdateCheck: "no" },
    }),
  );
  assert.throws(() =>
    parseOfflineGateState({
      ...valid,
      disabledFeatures: { ...valid.disabledFeatures, extra: true },
    }),
  );
});

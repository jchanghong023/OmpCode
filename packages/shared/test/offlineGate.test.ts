import assert from "node:assert/strict";
import { test } from "node:test";
import { parseOfflineGateState, resolveOfflineGateState } from "../src/offlineGate.js";

test("离线锁定仅由启动器的精确激活值启用，其他功能门控随其切换", () => {
  for (const value of [undefined, "", "0", "true", "1"]) {
    const gate = resolveOfflineGateState({ OMPCODE_CENTOS7_LOCAL_ONLY: value });
    const localOnly = value === "1";
    assert.equal(gate.localOnly, localOnly);
    assert.deepEqual(gate.disabledFeatures, {
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
    });
  }
});

test("运行时门控校验拒绝缺失、非法及未知功能，合法 IPC 状态保真", () => {
  const valid = resolveOfflineGateState({ OMPCODE_CENTOS7_LOCAL_ONLY: "1" });
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

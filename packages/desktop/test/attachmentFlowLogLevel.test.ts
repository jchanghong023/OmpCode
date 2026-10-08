import assert from "node:assert/strict";
import test from "node:test";
import { resolveAttachmentFlowLogLevel } from "../src/host/rpcLogLevel.js";

test("关闭后客户端销毁是 debug，运行中的销毁与其他关闭错误仍是 warn", () => {
  for (const message of ["ZCode Protocol client disposed", "ZCode Protocol client is disposed"]) {
    assert.equal(resolveAttachmentFlowLogLevel("closed", message), "debug");
    assert.equal(resolveAttachmentFlowLogLevel("saturated", message), "warn");
    assert.equal(resolveAttachmentFlowLogLevel("drained", message), "warn");
  }
  assert.equal(resolveAttachmentFlowLogLevel("closed", "transport write failed"), "warn");
});

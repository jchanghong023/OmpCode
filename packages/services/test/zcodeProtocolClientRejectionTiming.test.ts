import assert from "node:assert/strict";
import { setImmediate as nextTurn } from "node:timers/promises";
import test from "node:test";
import { Emitter } from "@zcode/rpc";
import type { ZCodeProtocolMessage } from "@zcode/shared";
import { ZCodeProtocolClient } from "../src/zcode-agent/zcodeProtocolClient.js";

for (const failure of ["response", "dispose", "abort", "timeout", "send"] as const) {
  test(`send 尚未完成时 ${failure} 拒绝仍只传递给调用方`, async () => {
    const messages = new Emitter<ZCodeProtocolMessage>();
    const closes = new Emitter<{ reason?: string }>();
    let finishSend!: () => void;
    let failSend!: (error: Error) => void;
    const send = new Promise<void>((resolve, reject) => {
      finishSend = resolve;
      failSend = reject;
    });
    const client = new ZCodeProtocolClient({
      kind: "memory",
      onMessage: messages.event,
      onClose: closes.event,
      send: () => send,
      dispose() {},
    });
    const controller = new AbortController();
    const request = client.request("v4/conversation/workflowRuns", {}, undefined, {
      signal: controller.signal,
      timeoutMs: failure === "timeout" ? 1 : 10_000,
    });
    // 先处理公开 Promise；内部 Promise 的提前拒绝仍须由生产代码自己处理。
    const expected = {
      response: /not supported/,
      dispose: /client disposed/,
      abort: /cancelled/,
      timeout: /timed out/,
      send: /write failed/,
    }[failure];
    const observed = assert.rejects(request, expected);
    try {
      if (failure === "response") {
        messages.fire({ id: 1, error: { code: -32601, message: "not supported" } });
      } else if (failure === "dispose") {
        client.dispose();
      } else if (failure === "abort") {
        controller.abort(new Error("cancelled"));
      } else if (failure === "timeout") {
        await new Promise((resolve) => setTimeout(resolve, 5));
      } else {
        failSend(new Error("write failed"));
      }
      // 给 Node 足够时间发出 unhandledRejection；node:test 会将其判为失败。
      await nextTurn();
      await nextTurn();
      finishSend();
      await observed;
      assert.equal(client.pendingRequestCount, 0);
    } finally {
      finishSend();
      client.dispose();
      messages.dispose();
      closes.dispose();
    }
  });
}

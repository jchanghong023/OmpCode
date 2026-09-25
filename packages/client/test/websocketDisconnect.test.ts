import assert from "node:assert/strict";
import { test } from "node:test";
import { connectViaWebSocket } from "../src/websocket.js";

test("closing WebSocket rejects an in-flight RPC", async () => {
  const original = globalThis.WebSocket;
  class FakeWebSocket extends EventTarget {
    static readonly OPEN = 1;
    static latest: FakeWebSocket | undefined;
    readyState = 1;
    binaryType = "arraybuffer";
    constructor(_url: string) {
      super();
      FakeWebSocket.latest = this;
      queueMicrotask(() => this.dispatchEvent(new Event("open")));
    }
    send(_data: unknown): void {}
    close(): void {
      this.dispatchEvent(new Event("close"));
    }
  }
  globalThis.WebSocket = FakeWebSocket as unknown as typeof WebSocket;
  try {
    const services = await connectViaWebSocket("ws://test");
    const pending = services.fileService.stat({ path: "/tmp/test" });
    FakeWebSocket.latest?.close();
    await assert.rejects(pending, /disposed|closed/i);
  } finally {
    globalThis.WebSocket = original;
  }
});

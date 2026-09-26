import assert from "node:assert/strict";
import { test } from "node:test";
import { VSBuffer } from "@zcode/rpc";
import { connectViaWebSocket, wrapBrowserWebSocket } from "../src/websocket.js";

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

test("browser transport closes a saturated send queue", async () => {
  class FakeWebSocket extends EventTarget {
    static readonly OPEN = 1;
    readyState = 1;
    bufferedAmount = 16 * 1024 * 1024;
    binaryType = "arraybuffer";
    closeCode: number | undefined;
    sent = 0;
    send(_data: unknown): void {
      this.sent += 1;
    }
    close(code?: number): void {
      this.closeCode = code;
      this.readyState = 3;
      setTimeout(() => this.dispatchEvent(new Event("close")), 0);
    }
  }
  const original = globalThis.WebSocket;
  globalThis.WebSocket = FakeWebSocket as unknown as typeof WebSocket;
  try {
    const ws = new FakeWebSocket();
    const socket = wrapBrowserWebSocket(ws as unknown as WebSocket);
    const closed = new Promise<void>((resolve) => socket.onClose(resolve));
    socket.write(VSBuffer.fromString("request"));
    await closed;
    assert.equal(ws.closeCode, 1013);
    assert.equal(ws.sent, 0);
  } finally {
    globalThis.WebSocket = original;
  }
});

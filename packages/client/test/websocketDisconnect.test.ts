import assert from "node:assert/strict";
import { stat } from "node:fs/promises";
import { test } from "node:test";
import { ChannelServer, ProxyChannel, SocketProtocol, VSBuffer } from "@zcode/rpc";
import { IFileService } from "@zcode/services";
import type { FileStat } from "@zcode/shared";
import { connectViaWebSocket, wrapBrowserWebSocket } from "../src/websocket.js";

class FakeWebSocket extends EventTarget {
  static readonly OPEN = 1;
  static latest: FakeWebSocket | undefined;
  readyState = FakeWebSocket.OPEN;
  bufferedAmount = 0;
  binaryType = "arraybuffer";
  sent = 0;
  peer?: FakeWebSocket;

  constructor(url?: string) {
    super();
    if (url) {
      FakeWebSocket.latest = this;
      queueMicrotask(() => this.dispatchEvent(new Event("open")));
    }
  }

  send(data: Uint8Array): void {
    assert.equal(this.readyState, FakeWebSocket.OPEN);
    this.sent += 1;
    this.peer?.dispatchEvent(new MessageEvent("message", { data: data.slice().buffer }));
  }

  close(code = 1000, reason = ""): void {
    // 模拟浏览器规范而非实现常量：非法 code 必须同步失败，不能假装触发 close。
    if (code !== 1000 && !(code >= 3000 && code <= 4999)) {
      throw new DOMException("Invalid WebSocket close code", "InvalidAccessError");
    }
    if (this.readyState !== FakeWebSocket.OPEN) return;
    this.readyState = 2;
    queueMicrotask(() => {
      this.readyState = 3;
      this.dispatchEvent(Object.assign(new Event("close"), { code, reason, wasClean: true }));
    });
  }
}

test("closing WebSocket rejects an in-flight RPC", { timeout: 2000 }, async () => {
  const original = globalThis.WebSocket;
  globalThis.WebSocket = FakeWebSocket as unknown as typeof WebSocket;
  try {
    const services = await connectViaWebSocket("ws://test");
    const pending = services.fileService.stat({ path: "/tmp/test" });
    const rejected = assert.rejects(pending, /disposed|closed/i);
    FakeWebSocket.latest?.close();
    await rejected;
  } finally {
    globalThis.WebSocket = original;
  }
});

test(
  "browser transport closes a saturated send queue without an illegal close code",
  { timeout: 2000 },
  async () => {
    const original = globalThis.WebSocket;
    globalThis.WebSocket = FakeWebSocket as unknown as typeof WebSocket;
    try {
      const ws = new FakeWebSocket();
      ws.bufferedAmount = 16 * 1024 * 1024;
      const socket = wrapBrowserWebSocket(ws as unknown as WebSocket);
      const closed = new Promise<void>((resolve) => socket.onClose(resolve));
      assert.throws(() => ws.close(1013), { name: "InvalidAccessError" });
      assert.equal(ws.readyState, FakeWebSocket.OPEN);
      assert.doesNotThrow(() => socket.write(VSBuffer.fromString("request")));
      await closed;
      assert.equal(ws.readyState, 3);
      assert.equal(ws.sent, 0);
      await assert.rejects(socket.drain(), /closed/i);
    } finally {
      globalThis.WebSocket = original;
    }
  },
);

test("browser transport sends normally at the queue limit", () => {
  const original = globalThis.WebSocket;
  globalThis.WebSocket = FakeWebSocket as unknown as typeof WebSocket;
  try {
    const ws = new FakeWebSocket();
    const request = VSBuffer.fromString("request");
    ws.bufferedAmount = 16 * 1024 * 1024 - request.byteLength;
    const socket = wrapBrowserWebSocket(ws as unknown as WebSocket);
    socket.write(request);
    assert.equal(ws.sent, 1);
    assert.equal(ws.readyState, FakeWebSocket.OPEN);
    socket.dispose();
  } finally {
    globalThis.WebSocket = original;
  }
});

test(
  "saturation rejects all pending RPCs and reports close for reconnection",
  { timeout: 2000 },
  async () => {
    const original = globalThis.WebSocket;
    globalThis.WebSocket = FakeWebSocket as unknown as typeof WebSocket;
    const servers: ChannelServer[] = [];
    const sockets: FakeWebSocket[] = [];
    const received: string[] = [];
    const connect = (onClose?: () => void) =>
      connectViaWebSocket("ws://test", {
        onClose,
        onOpenSocket(raw) {
          const browser = raw as unknown as FakeWebSocket;
          const peer = new FakeWebSocket();
          sockets.push(browser, peer);
          browser.peer = peer;
          peer.peer = browser;
          // Initialize 必须在客户端安装协议监听之后到达，使用真实 Channel/Socket 编解码。
          queueMicrotask(() => {
            const server = new ChannelServer(
              new SocketProtocol(wrapBrowserWebSocket(peer as unknown as WebSocket)),
              "test",
            );
            servers.push(server);
            server.registerChannel(
              IFileService.channelName,
              ProxyChannel.fromService({
                async stat({ path }: { path: string }) {
                  received.push(path);
                  if (path.startsWith("/pending")) return new Promise<never>(() => {});
                  const metadata = await stat(path);
                  return {
                    path,
                    type: metadata.isDirectory() ? "directory" : "file",
                    size: metadata.size,
                  };
                },
              }),
            );
          });
        },
      });
    try {
      let closeCount = 0;
      let notifyClosed!: () => void;
      const closed = new Promise<void>((resolve) => {
        notifyClosed = resolve;
      });
      const services = await connect(() => {
        closeCount += 1;
        notifyClosed();
      });
      const browser = sockets[0];
      const pending = [
        services.fileService.stat({ path: "/pending-1" }),
        services.fileService.stat({ path: "/pending-2" }),
      ];
      const rejections = pending.map((request) => assert.rejects(request, /disposed|closed/i));
      assert.deepEqual(received, ["/pending-1", "/pending-2"]);
      const sentBeforeSaturation = browser.sent;
      browser.bufferedAmount = 16 * 1024 * 1024;
      let saturated!: Promise<FileStat>;
      assert.doesNotThrow(() => {
        saturated = services.fileService.stat({ path: "/saturated" });
      });
      rejections.push(assert.rejects(saturated, /disposed|closed/i));
      await Promise.all([closed, ...rejections]);
      assert.equal(closeCount, 1);
      assert.equal(browser.readyState, 3);
      assert.equal(browser.sent, sentBeforeSaturation);
      assert.deepEqual(received, ["/pending-1", "/pending-2"]);
      const recovered = await connect();
      const recoveredPath = import.meta.filename;
      const metadata = await stat(recoveredPath);
      assert.deepEqual(await recovered.fileService.stat({ path: recoveredPath }), {
        path: recoveredPath,
        type: "file",
        size: metadata.size,
      });
    } finally {
      for (const server of servers) server.dispose();
      for (const socket of sockets) socket.close();
      globalThis.WebSocket = original;
    }
  },
);

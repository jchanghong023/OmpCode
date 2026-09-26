import assert from "node:assert/strict";
import { EventEmitter } from "node:events";
import { test } from "node:test";
import type { WebSocket } from "ws";
import type { RemoteConnection } from "../src/remote/index.js";
import { RemoteConnectionStore, attachClaimedRemoteConnection } from "../src/http.js";

type FakeRemoteConnection = RemoteConnection & {
  readonly disposeCount: number;
  readonly disposeAndWaitCount: number;
};

/** 不真连 SSH：只验证注册表对 dispose 的调度，连接对象用最小假体替代。 */
function createFakeConnection(): FakeRemoteConnection {
  let count = 0;
  let disposeAndWaitCount = 0;
  return {
    services: {} as RemoteConnection["services"],
    client: {} as RemoteConnection["client"],
    dispose() {
      count += 1;
    },
    disposeAndWait: () => {
      disposeAndWaitCount += 1;
      return Promise.resolve();
    },
    get disposeCount() {
      return count;
    },
    get disposeAndWaitCount() {
      return disposeAndWaitCount;
    },
  };
}

/**
 * 最小 ws 假体：满足 wrapWebSocket 的订阅面（on/close/error/readyState/send/close），
 * 测试用 emit("close") 模拟浏览器断开。
 */
class FakeWebSocket extends EventEmitter {
  readonly OPEN = 1;
  readyState = 1;
  closed = false;
  close(): void {
    this.closed = true;
  }
  send(): void {}
}

const sleep = (ms: number) => new Promise<void>((resolve) => setTimeout(resolve, ms));

test("unclaimed connection is disposed and removed after claim timeout", async () => {
  const store = new RemoteConnectionStore({ claimTimeoutMs: 10 });
  const connection = createFakeConnection();
  assert.ok(store.tryStore("timeout-1", connection));
  assert.equal(store.size, 1);

  await sleep(80);

  // F13 核心断言：超时未认领 → dispose 被调用且条目移除，认领路径拿到 undefined
  assert.equal(store.size, 0);
  assert.equal(connection.disposeCount, 1);
  assert.equal(store.claim("timeout-1"), undefined);
});

test("claimed connection clears its timeout and is never disposed by the store", async () => {
  const store = new RemoteConnectionStore({ claimTimeoutMs: 10 });
  const connection = createFakeConnection();
  assert.ok(store.tryStore("claimed-1", connection));

  assert.equal(store.claim("claimed-1"), connection);
  assert.equal(store.size, 0);

  await sleep(80);

  // 认领成功 → 定时器已清除，连接所有权移交 WS 生命周期，store 不得再 dispose
  assert.equal(connection.disposeCount, 0);
});

test("tryStore rejects new connections once pending capacity is reached", () => {
  const store = new RemoteConnectionStore({ claimTimeoutMs: 10_000, maxPending: 2 });
  const first = createFakeConnection();
  const second = createFakeConnection();
  const third = createFakeConnection();

  assert.ok(store.tryStore("cap-a", first));
  assert.ok(store.tryStore("cap-b", second));
  assert.equal(store.tryStore("cap-c", third), false);

  // 拒绝路径：store 不收纳超限连接（dispose 由调用方负责），既有条目不受影响
  assert.equal(store.size, 2);
  assert.equal(store.claim("cap-c"), undefined);
  assert.equal(store.claim("cap-a"), first);
  assert.equal(store.claim("cap-b"), second);
  assert.equal(third.disposeCount, 0);
});

test("storing duplicate id disposes previous connection and re-arms timer", async () => {
  const store = new RemoteConnectionStore({ claimTimeoutMs: 20 });
  const first = createFakeConnection();
  const second = createFakeConnection();

  assert.ok(store.tryStore("dup-1", first));
  assert.ok(store.tryStore("dup-1", second));

  // generateId 冲突路径：覆盖前旧连接必须立即 dispose
  assert.equal(first.disposeCount, 1);
  assert.equal(store.size, 1);

  await sleep(80);

  // 旧条目的定时器应被清除（不重复 dispose），新条目定时器照常生效
  assert.equal(first.disposeCount, 1);
  assert.equal(second.disposeCount, 1);
  assert.equal(store.size, 0);
});

test("claimed connection is disposed exactly once when its websocket closes (F31)", async () => {
  const connection = createFakeConnection();
  const ws = new FakeWebSocket();

  // 模拟 /ws/remote/:id onOpen 的认领后挂接：connection 已被 claim，所有权移交 WS。
  attachClaimedRemoteConnection(ws as unknown as WebSocket, connection);

  ws.emit("close");
  await sleep(0);

  // F31 核心断言：WS 关闭必须把认领后的 RemoteConnection 收口恰好一次，否则浏览器
  // 每次刷新都泄漏一条 SSH/WSL/Docker 远端连接。走 disposeAndWait（宽限收口）而非
  // 立即 kill 的 dispose。
  assert.equal(connection.disposeCount, 0);
  assert.equal(connection.disposeAndWaitCount, 1);
});

test("claimed connection is disposed when its websocket errors (F31)", async () => {
  const connection = createFakeConnection();
  const ws = new FakeWebSocket();
  attachClaimedRemoteConnection(ws as unknown as WebSocket, connection);

  // wrapWebSocket 对 error 同样触发 onClose（close 事件随后必然到来，真实连接幂等），
  // 这里单独验证 error 路径也能触发收口。
  ws.emit("error", new Error("abnormal closure"));
  await sleep(0);

  assert.equal(connection.disposeCount, 0);
  assert.equal(connection.disposeAndWaitCount, 1);
});

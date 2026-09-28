import assert from "node:assert/strict";
import test from "node:test";
import { ApiError } from "@zcode/shared";
import { NodeApiClient } from "../src/providers/api/nodeApiClient.js";

// 验证依据：docs/electron-44-28-api-compat.md §3 —— AbortSignal.any（Node 20.3+）在
// Electron 28 内嵌 Node 18.18 上不可用，已改为 abort 监听转发组合。本文件固化组合信号的
// 关键语义：任一来源中止（调用方取消 / 超时）都取消请求，且错误文案区分超时与外部取消。

function deferredFetchOnAbort(): {
  fetchImpl: typeof fetch;
  observedSignals: AbortSignal[];
} {
  const observedSignals: AbortSignal[] = [];
  const fetchImpl = ((_input: string | URL, init?: RequestInit) => {
    const signal = init?.signal;
    if (!(signal instanceof AbortSignal)) {
      return Promise.reject(new TypeError("expected AbortSignal"));
    }
    observedSignals.push(signal);
    return new Promise<Response>((_resolve, reject) => {
      if (signal.aborted) {
        reject(signal.reason);
        return;
      }
      signal.addEventListener("abort", () => reject(signal.reason), { once: true });
    });
  }) as typeof fetch;
  return { fetchImpl, observedSignals };
}

test("调用方 signal 中止会经组合信号取消请求，文案保留外部取消语义", async () => {
  const { fetchImpl } = deferredFetchOnAbort();
  const client = new NodeApiClient({ fetchImpl });
  const caller = new AbortController();
  const pending = client.request("https://example.com/api", {
    signal: caller.signal,
    timeoutMs: 10_000,
  });
  // 等请求进入 fetch 后再触发调用方取消。
  await new Promise((resolve) => setImmediate(resolve));
  caller.abort();
  await assert.rejects(pending, (error: unknown) => {
    assert.ok(error instanceof ApiError);
    assert.match(error.message, /aborted/i);
    assert.doesNotMatch(error.message, /timed out/i);
    const cause = (error as { cause?: unknown }).cause;
    return cause instanceof DOMException && cause.name === "AbortError";
  });
});

test("超时经组合信号仍然生效并报告超时文案", async () => {
  const { fetchImpl } = deferredFetchOnAbort();
  const client = new NodeApiClient({ fetchImpl });
  const caller = new AbortController();
  await assert.rejects(
    client.request("https://example.com/api", {
      signal: caller.signal,
      timeoutMs: 20,
    }),
    (error: unknown) => {
      assert.ok(error instanceof ApiError);
      assert.match(error.message, /Request timed out after 20ms/);
      const cause = (error as { cause?: unknown }).cause;
      return cause instanceof DOMException && cause.name === "AbortError";
    },
  );
  assert.equal(caller.signal.aborted, false, "超时不应该中止调用方自己的 signal");
});

test("无调用方 signal 时保持原 controller.signal 直通路径", async () => {
  const { fetchImpl, observedSignals } = deferredFetchOnAbort();
  const client = new NodeApiClient({ fetchImpl });
  await assert.rejects(
    client.request("https://example.com/api", { timeoutMs: 20 }),
    (error: unknown) => error instanceof ApiError && /timed out/.test(error.message),
  );
  assert.equal(observedSignals.length, 1);
});

test("调用方 signal 预先已中止时在发起请求前失败", async () => {
  const { fetchImpl, observedSignals } = deferredFetchOnAbort();
  const client = new NodeApiClient({ fetchImpl });
  const caller = new AbortController();
  caller.abort();
  await assert.rejects(
    client.request("https://example.com/api", { signal: caller.signal, timeoutMs: 10_000 }),
    (error: unknown) => {
      assert.ok(error instanceof ApiError);
      const cause = (error as { cause?: unknown }).cause;
      return cause instanceof DOMException && cause.name === "AbortError";
    },
  );
  assert.equal(observedSignals.length, 0, "已中止的请求不应进入 fetch");
});

test("成功路径不受组合信号影响且返回响应", async () => {
  const fetchImpl = (() => Promise.resolve(new Response("ok"))) as typeof fetch;
  const client = new NodeApiClient({ fetchImpl });
  const caller = new AbortController();
  const response = await client.request("https://example.com/api", {
    signal: caller.signal,
    timeoutMs: 10_000,
  });
  assert.equal(await response.text(), "ok");
  // 请求完成后调用方再中止不应产生任何未处理异常。
  caller.abort();
  await new Promise((resolve) => setImmediate(resolve));
});

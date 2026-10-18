import assert from "node:assert/strict";
import test from "node:test";
import { setTimeout as delay } from "node:timers/promises";
import { createMockModel, isMockModel, MockModel, streamMock } from "./fixtures/ompMockModel.mjs";
import { AssistantMessageEventStream, EventStream } from "./fixtures/ompMockStream.mjs";

const context = { messages: [{ role: "user", content: "request" }] };
async function collect(model: MockModel, options = {}) {
  const stream = model.stream(model, context, options);
  const events = [];
  for await (const event of stream) events.push(event);
  return { events, message: await stream.result() };
}
async function text(model: MockModel) {
  return (await collect(model)).message.content
    .map((block: { text?: string }) => block.text ?? "")
    .join("");
}

test("mock engine emits ordered text/thinking/tool events with signatures, object/string arguments and stable IDs", async () => {
  const args = { path: "file.txt" };
  const model = createMockModel({
    responses: [
      {
        responseId: "response-1",
        content: [
          "plain",
          { type: "text", text: "explicit" },
          { type: "thinking", thinking: "reason", thinkingSignature: "signed" },
          { type: "toolCall", name: "read", arguments: args },
          { type: "toolCall", id: "fixed", name: "write", arguments: '{"path":"x"}' },
        ],
      },
      { content: [{ type: "toolCall", name: "read", arguments: {} }] },
    ],
  });
  const { events, message } = await collect(model);
  assert.deepEqual(
    events.map((event) => event.type),
    [
      "start",
      "text_start",
      "text_delta",
      "text_end",
      "text_start",
      "text_delta",
      "text_end",
      "thinking_start",
      "thinking_delta",
      "thinking_end",
      "toolcall_start",
      "toolcall_delta",
      "toolcall_end",
      "toolcall_start",
      "toolcall_delta",
      "toolcall_end",
      "done",
    ],
  );
  assert.deepEqual(
    events.filter((event) => event.type.endsWith("_delta")).map((event) => event.delta),
    ["plain", "explicit", "reason", '{"path":"file.txt"}', '{"path":"x"}'],
  );
  assert.deepEqual(message.content, [
    { type: "text", text: "plain" },
    { type: "text", text: "explicit" },
    { type: "thinking", thinking: "reason", thinkingSignature: "signed" },
    { type: "toolCall", id: "mock-tc-1", name: "read", arguments: args },
    { type: "toolCall", id: "fixed", name: "write", arguments: '{"path":"x"}' },
  ]);
  assert.notEqual(message.content[3].arguments, args);
  assert.equal(message.stopReason, "toolUse");
  assert.equal(message.responseId, "response-1");
  assert.equal((await collect(model)).message.content[0].id, "mock-tc-2");
  assert.ok(Number.isFinite(message.timestamp));
  assert.ok(message.duration >= 0);
});

test(
  "same-block deltas keep one indexed lifecycle, exact content and only expose received prefixes",
  { timeout: 5000 },
  async () => {
    const thinkingRelease = Promise.withResolvers<void>();
    const thinkingBlocked = Promise.withResolvers<void>();
    const thinkingSeen = Promise.withResolvers<void>();
    const toolRelease = Promise.withResolvers<void>();
    const toolBlocked = Promise.withResolvers<void>();
    const toolSeen = Promise.withResolvers<void>();
    const textDeltas = ["## 中文\n\n", "- **逐片", "输出**\n"];
    const thinkingDeltas = ["先比较", "，再选择。"];
    const toolDeltas = ['{"path":"目录\\', '\\文件.md","note":"第一行\\', 'n引用 \\"片段\\""}'];
    const model = createMockModel({
      handler: {
        content: [
          { type: "text", deltas: textDeltas },
          {
            type: "thinking",
            thinkingSignature: "signed-fragments",
            deltas: (async function* () {
              yield thinkingDeltas[0];
              thinkingBlocked.resolve();
              await thinkingRelease.promise;
              yield thinkingDeltas[1];
            })(),
          },
          {
            type: "toolCall",
            id: "fragment-tool",
            name: "write",
            deltas: (async function* () {
              yield toolDeltas[0];
              toolBlocked.resolve();
              await toolRelease.promise;
              yield* toolDeltas.slice(1);
            })(),
          },
        ],
      },
    });
    const stream = model.stream(model, context);
    const events = [];
    let settled = false;
    const completion = stream.result();
    void completion.then(
      () => {
        settled = true;
      },
      () => {
        settled = true;
      },
    );
    const reading = (async () => {
      for await (const event of stream) {
        events.push(structuredClone(event));
        if (event.type === "thinking_delta") thinkingSeen.resolve();
        if (event.type === "toolcall_delta") toolSeen.resolve();
      }
    })();
    try {
      await Promise.all([thinkingBlocked.promise, thinkingSeen.promise]);
      const thinkingPrefix = structuredClone(
        events.findLast((event) => event.type === "thinking_delta").partial,
      );
      assert.equal(thinkingPrefix.content.length, 2);
      assert.deepEqual(thinkingPrefix.content[0], { type: "text", text: textDeltas.join("") });
      assert.equal(thinkingPrefix.content[1].thinking, thinkingDeltas[0]);
      assert.equal(
        events.some((event) => event.type === "thinking_end"),
        false,
      );
      assert.equal(settled, false);
      thinkingRelease.resolve();
      await Promise.all([toolBlocked.promise, toolSeen.promise]);
      const toolPrefix = structuredClone(
        events.findLast((event) => event.type === "toolcall_delta").partial,
      );
      assert.deepEqual(toolPrefix.content[2], {
        type: "toolCall",
        id: "fragment-tool",
        name: "write",
        arguments: toolDeltas[0],
      });
      assert.equal(
        events.some((event) => event.type === "toolcall_end" || event.type === "done"),
        false,
      );
      assert.equal(settled, false, "a partial JSON prefix must not settle the response");
    } finally {
      thinkingRelease.resolve();
      toolRelease.resolve();
    }
    await reading;
    const message = await completion;
    for (const [index, kind, deltas] of [
      [0, "text", textDeltas],
      [1, "thinking", thinkingDeltas],
      [2, "toolcall", toolDeltas],
    ] as const) {
      const blockEvents = events.filter((event) => event.type.startsWith(`${kind}_`));
      assert.deepEqual(
        blockEvents.map((event) => event.type),
        [`${kind}_start`, ...deltas.map(() => `${kind}_delta`), `${kind}_end`],
      );
      assert.deepEqual(
        blockEvents.map((event) => event.contentIndex),
        blockEvents.map(() => index),
      );
      assert.deepEqual(
        blockEvents.filter((event) => event.type.endsWith("_delta")).map((event) => event.delta),
        deltas,
      );
    }
    assert.deepEqual(message.content, [
      { type: "text", text: "## 中文\n\n- **逐片输出**\n" },
      { type: "thinking", thinking: "先比较，再选择。", thinkingSignature: "signed-fragments" },
      {
        type: "toolCall",
        id: "fragment-tool",
        name: "write",
        arguments: { path: "目录\\文件.md", note: '第一行\n引用 "片段"' },
      },
    ]);
    assert.equal(message.stopReason, "toolUse");
    assert.equal(
      events.find((event) => event.type === "thinking_end").partial.content[1].thinkingSignature,
      "signed-fragments",
    );
    assert.equal(events.filter((event) => event.type === "done").length, 1);
  },
);

test("mock scripts consume arrays and synchronous/async iterables before pushed entries and fallback", async () => {
  function* script() {
    yield { content: ["sync-1"] };
    yield async () => ({ content: ["sync-2"] });
  }
  const model = createMockModel({ responses: script(), handler: { content: ["fallback"] } });
  model.push({ content: ["pushed"] });
  assert.equal(await text(model), "sync-1");
  assert.equal(await text(model), "sync-2");
  assert.equal(await text(model), "pushed");
  assert.equal(await text(model), "fallback");
  model.push({ content: ["late"] });
  assert.equal(await text(model), "late");
  assert.equal(await text(model), "fallback");
  const gate = Promise.withResolvers<void>();
  const asyncModel = createMockModel({
    responses: (async function* () {
      yield { content: ["async-1"] };
      await gate.promise;
      yield { content: ["async-2"] };
    })(),
  });
  assert.equal(await text(asyncModel), "async-1");
  const next = text(asyncModel);
  gate.resolve();
  assert.equal(await next, "async-2");
  await assert.rejects(text(asyncModel), /no response or handler/);
});

test("mock async context handler receives original context/options and records invocation order", async () => {
  const controller = new AbortController();
  const options = { signal: controller.signal, temperature: 0.3 };
  const model = createMockModel({
    handler: async (received: typeof context, receivedOptions: typeof options) => {
      await Promise.resolve();
      assert.equal(received, context);
      assert.equal(receivedOptions, options);
      return { content: [`${received.messages[0].content}:${receivedOptions.temperature}`] };
    },
  });
  const { message } = await collect(model, options);
  assert.equal(message.content[0].text, "request:0.3");
  assert.equal(model.calls[0].context, context);
  assert.equal(model.calls[0].options, options);
});

test("mock reset clears calls/extras/ID counter without rewinding scripts; instances never share state", async () => {
  const tool = { content: [{ type: "toolCall", name: "read", arguments: {} }] };
  const first = createMockModel({ responses: [tool, { content: ["second"] }], handler: tool });
  const second = createMockModel({ responses: [{ content: ["independent"] }] });
  assert.ok(isMockModel(first));
  assert.equal(first.model, first);
  assert.equal((await collect(first)).message.content[0].id, "mock-tc-1");
  first.push({ content: ["discarded"] });
  first.reset();
  assert.equal(first.calls.length, 0);
  assert.equal(await text(first), "second");
  assert.equal((await collect(first)).message.content[0].id, "mock-tc-1");
  assert.equal(await text(second), "independent");
  assert.equal(second.calls.length, 1);
  assert.equal(first.calls.length, 2);
});

test("mock computes partial token/cost totals including orchestration but explicit totals win", async () => {
  const model = createMockModel({
    responses: [
      {
        content: [],
        usage: {
          input: 2,
          output: 3,
          cacheRead: 5,
          cacheWrite: 7,
          orchestration: { input: 11, output: 13, cacheRead: 17 },
          cost: { input: 0.1, output: 0.2, cacheRead: 0.3, cacheWrite: 0.4 },
        },
      },
      { usage: { input: 100, totalTokens: 4, cost: { input: 99, total: 0.5 } } },
      {},
    ],
  });
  const partial = (await collect(model)).message.usage;
  assert.equal(partial.totalTokens, 58);
  assert.equal(partial.cost.total, 1);
  assert.deepEqual(partial.orchestration, { input: 11, output: 13, cacheRead: 17 });
  const explicit = (await collect(model)).message.usage;
  assert.equal(explicit.totalTokens, 4);
  assert.deepEqual(explicit.cost, {
    input: 99,
    output: 0,
    cacheRead: 0,
    cacheWrite: 0,
    total: 0.5,
  });
  assert.deepEqual((await collect(model)).message.usage, {
    input: 0,
    output: 0,
    cacheRead: 0,
    cacheWrite: 0,
    totalTokens: 0,
    cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
  });
});

test("engine-only metadata preserves service tier, stop details and opaque fallback credit identity", async () => {
  const handle = { token: Symbol("opaque-credit") };
  const stopDetails = { provider: "anthropic", reason: "refusal" };
  const model = createMockModel({
    responses: [
      {
        content: ["refused"],
        stopReason: "stop",
        responseId: "response-metadata",
        serviceTier: "priority",
        stopDetails,
        fallbackCreditHandle: handle,
      },
      { stopDetails: null },
    ],
  });
  const { message } = await collect(model);
  assert.equal(message.serviceTier, "priority");
  assert.equal(message.stopDetails, stopDetails);
  assert.equal(message.fallbackCreditHandle, handle);
  assert.equal(message.responseId, "response-metadata");
  assert.equal((await collect(model)).message.stopDetails, null);
});

test("onResponse awaits normalized headers/status/requestId before events and callback failure rejects both consumers", async () => {
  const model = createMockModel({
    responses: [
      {
        content: ["after callback"],
        responseHeaders: { "X-Trace": "trace" },
        responseStatus: 202,
        responseRequestId: "req-1",
      },
    ],
  });
  let completed = false;
  const stream = model.stream(model, context, {
    onResponse: async (metadata: unknown, receivedModel: unknown) => {
      assert.deepEqual(metadata, {
        status: 202,
        headers: { "x-trace": "trace" },
        requestId: "req-1",
      });
      assert.equal(receivedModel, model);
      await Promise.resolve();
      completed = true;
    },
  });
  for await (const event of stream) {
    assert.ok(completed);
    assert.ok(event.type);
  }
  assert.equal((await stream.result()).content[0].text, "after callback");
  const broken = createMockModel({
    handler: { responseHeaders: { "X-Test": "yes" }, content: ["never"] },
  });
  const failed = broken.stream(broken, context, {
    onResponse() {
      throw new Error("callback rejected");
    },
  });
  await assert.rejects(failed.result(), /callback rejected/);
  await assert.rejects(async () => {
    for await (const _event of failed) {
      assert.fail("must not emit");
    }
  }, /callback rejected/);
  const fallback = createMockModel({ handler: { responseHeaders: {} } });
  await collect(fallback, {
    onResponse(metadata: { status: number }) {
      assert.equal(metadata.status, 200);
    },
  });
});

test("all explicit terminal reasons and throw forms retain their error versus completion outcomes", async () => {
  for (const reason of ["stop", "length", "toolUse", "error", "aborted"]) {
    const model = createMockModel({
      handler: { content: ["payload"], stopReason: reason, errorMessage: "terminal detail" },
    });
    const { events, message } = await collect(model);
    assert.equal(message.stopReason, reason);
    assert.equal(events.at(-1).type, reason === "error" || reason === "aborted" ? "error" : "done");
    assert.equal(message.content[0].text, "payload");
    if (reason === "error" || reason === "aborted")
      assert.equal(message.errorMessage, "terminal detail");
  }
  for (const thrown of ["string failure", new Error("error failure")]) {
    const { events, message } = await collect(createMockModel({ handler: { throw: thrown } }));
    assert.deepEqual(
      events.map((event) => event.type),
      ["start", "error"],
    );
    assert.equal(message.stopReason, "error");
    assert.equal(message.errorMessage, typeof thrown === "string" ? thrown : thrown.message);
  }
  assert.equal(
    (await collect(createMockModel({ handler: { stopReason: "error" } }))).message.errorMessage,
    "mock error",
  );
});

test("exhaustion, invalid model, handler/iterator failures and malformed content reject without hidden success", async () => {
  const iteratorFailure = {
    [Symbol.iterator]() {
      return {
        next() {
          throw new Error("iterator failed");
        },
      };
    },
  };
  const asyncIteratorFailure = {
    [Symbol.asyncIterator]() {
      return {
        async next() {
          throw new Error("async iterator failed");
        },
      };
    },
  };
  for (const [model, expected] of [
    [createMockModel(), /no response or handler/],
    [
      createMockModel({
        handler() {
          throw new Error("handler failed");
        },
      }),
      /handler failed/,
    ],
    [
      createMockModel({
        handler: async () => {
          throw new Error("async handler failed");
        },
      }),
      /async handler failed/,
    ],
    [createMockModel({ responses: iteratorFailure }), /iterator failed/],
    [createMockModel({ responses: asyncIteratorFailure }), /async iterator failed/],
    [createMockModel({ handler: { content: [null] } }), /null/],
  ] as const)
    await assert.rejects(text(model), expected);
  const invalid = streamMock({}, context);
  await assert.rejects(invalid.result(), /not produced by createMockModel/);
  await assert.rejects(async () => {
    for await (const _event of invalid) {
      assert.fail("unexpected event");
    }
  }, /not produced/);
});

test("delay waits before first event and cancellation before/during delay terminates as aborted", async () => {
  const before = performance.now();
  await collect(createMockModel({ handler: { delayMs: 20, content: ["delayed"] } }));
  assert.ok(performance.now() - before >= 15);
  for (const preaborted of [false, true]) {
    const controller = new AbortController();
    if (preaborted) controller.abort();
    const pending = collect(createMockModel({ handler: { delayMs: 60_000, content: ["never"] } }), {
      signal: controller.signal,
    });
    if (!preaborted) {
      await delay(1);
      controller.abort();
    }
    const { events, message } = await pending;
    assert.deepEqual(
      events.map((event) => event.type),
      ["start", "error"],
    );
    assert.equal(message.stopReason, "aborted");
    assert.match(message.errorMessage, /aborted during delay/);
    assert.deepEqual(message.content, []);
  }
});

test(
  "content streams sync/async iterables incrementally before the producer finishes",
  { timeout: 5000 },
  async () => {
    const release = Promise.withResolvers<void>();
    const reached = Promise.withResolvers<void>();
    const prefixSeen = Promise.withResolvers<void>();
    const response = {
      content: (async function* () {
        yield "prefix";
        reached.resolve();
        await release.promise;
        yield { type: "thinking", thinking: "middle" };
        yield { type: "toolCall", id: "stream_tool", name: "read", arguments: { path: "x" } };
        yield "suffix";
      })(),
    };
    const streaming = createMockModel({ handler: response });
    const stream = streaming.stream(streaming, context);
    const events: { type: string; delta?: string }[] = [];
    let settled = false;
    void stream.result().then(() => {
      settled = true;
    });
    const reading = (async () => {
      for await (const event of stream) {
        events.push(event);
        if (event.type === "text_delta" && event.delta === "prefix") prefixSeen.resolve();
      }
    })();
    try {
      await Promise.all([reached.promise, prefixSeen.promise]);
      assert.equal(settled, false, "prefix must arrive before a terminal response");
      assert.deepEqual(
        events.filter((event) => event.type === "text_delta").map((event) => event.delta),
        ["prefix"],
      );
    } finally {
      release.resolve();
    }
    await reading;
    const message = await stream.result();
    assert.equal(message.stopReason, "toolUse");
    assert.deepEqual(
      message.content.map((block: { type: string }) => block.type),
      ["text", "thinking", "toolCall", "text"],
    );
    assert.deepEqual(
      events.filter((event) => event.type === "text_delta").map((event) => event.delta),
      ["prefix", "suffix"],
    );
    assert.equal(events.filter((event) => event.type === "done").length, 1);
    assert.equal(
      await text(createMockModel({ handler: { content: new Set(["sync-a", "sync-b"]) } })),
      "sync-async-b",
    );
  },
);

test(
  "async content iterator failure rejects iteration and result after preserving visible prefix",
  { timeout: 5000 },
  async () => {
    const failure = new Error("content iterator failed");
    const model = createMockModel({
      handler: {
        content: (async function* () {
          yield "before-failure";
          throw failure;
        })(),
      },
    });
    const stream = model.stream(model, context);
    const events: { type: string; delta?: string }[] = [];
    await assert.rejects(
      async () => {
        for await (const event of stream) events.push(event);
      },
      (error) => error === failure,
    );
    await assert.rejects(stream.result(), (error) => error === failure);
    assert.deepEqual(
      events.filter((event) => event.type === "text_delta").map((event) => event.delta),
      ["before-failure"],
    );
    assert.equal(
      events.some((event) => event.type === "done"),
      false,
    );
  },
);

test(
  "abort interrupts a blocked content next, closes the iterator, and ignores late content",
  { timeout: 5000 },
  async () => {
    for (const preaborted of [false, true]) {
      const controller = new AbortController();
      const blocked = Promise.withResolvers<IteratorResult<string>>();
      const waiting = Promise.withResolvers<void>();
      let nextCalls = 0;
      let returns = 0;
      const content = {
        [Symbol.asyncIterator]() {
          return {
            next() {
              nextCalls++;
              if (nextCalls === 1) return Promise.resolve({ value: "visible-prefix", done: false });
              waiting.resolve();
              return blocked.promise;
            },
            async return() {
              returns++;
              return { value: undefined, done: true };
            },
          };
        },
      };
      if (preaborted) controller.abort();
      const model = createMockModel({ responses: [{ content }, { content: ["next-turn"] }] });
      const stream = model.stream(model, context, { signal: controller.signal });
      const events: { type: string; delta?: string }[] = [];
      const reading = (async () => {
        for await (const event of stream) events.push(event);
      })();
      if (!preaborted) {
        await waiting.promise;
        controller.abort();
      }
      // 超时是失败保护，不释放生产者屏障来伪造取消成功。
      const message = await Promise.race([
        stream.result(),
        delay(1000).then(() => {
          throw new Error("abort waited for blocked content producer");
        }),
      ]);
      await reading;
      assert.equal(message.stopReason, "aborted");
      assert.deepEqual(
        message.content.map((block: { text?: string }) => block.text),
        preaborted ? [] : ["visible-prefix"],
      );
      assert.equal(nextCalls, preaborted ? 0 : 2);
      assert.equal(returns, 1);
      const terminalCount = events.length;
      blocked.resolve({ value: "LATE_MUST_NOT_REVIVE", done: false });
      await delay(0);
      assert.equal(events.length, terminalCount);
      assert.equal(events.at(-1)?.type, "error");
      assert.equal(events.filter((event) => event.type === "done").length, 0);
      assert.equal(await text(model), "next-turn");
    }
  },
);

test(
  "abort never waits for an async generator's blocked return or replays its late yield",
  { timeout: 5000 },
  async () => {
    const controller = new AbortController();
    const release = Promise.withResolvers<void>();
    const blocked = Promise.withResolvers<void>();
    const closed = Promise.withResolvers<void>();
    const content = (async function* () {
      try {
        yield "generator-prefix";
        blocked.resolve();
        await release.promise;
        yield "GENERATOR_LATE_FORBIDDEN";
      } finally {
        closed.resolve();
      }
    })();
    const model = createMockModel({ handler: { content } });
    const stream = model.stream(model, context, { signal: controller.signal });
    const events: { type: string; delta?: string }[] = [];
    const reading = (async () => {
      for await (const event of stream) events.push(event);
    })();
    await blocked.promise;
    controller.abort();
    try {
      const message = await Promise.race([
        stream.result(),
        delay(1000).then(() => {
          throw new Error("cancel waited for async generator return");
        }),
      ]);
      assert.equal(message.stopReason, "aborted");
      await reading;
      assert.deepEqual(
        events.filter((event) => event.type === "text_delta").map((event) => event.delta),
        ["generator-prefix"],
      );
      assert.equal(events.at(-1)?.type, "error");
    } finally {
      release.resolve();
    }
    await closed.promise;
    assert.equal(
      events.some((event) => event.delta === "GENERATOR_LATE_FORBIDDEN"),
      false,
    );
    assert.equal(events.filter((event) => event.type === "error").length, 1);
    assert.equal(events.filter((event) => event.type === "done").length, 0);
  },
);

test(
  "abort ends blocked block deltas without waiting, parsing a prefix or reviving late content",
  { timeout: 5000 },
  async () => {
    const controller = new AbortController();
    const release = Promise.withResolvers<void>();
    const blocked = Promise.withResolvers<void>();
    const closed = Promise.withResolvers<void>();
    const prefix = '{"path":"已收到';
    const deltas = (async function* () {
      try {
        yield prefix;
        blocked.resolve();
        await release.promise;
        yield '晚到.md"}';
      } finally {
        closed.resolve();
      }
    })();
    const model = createMockModel({
      responses: [
        {
          content: [
            { type: "toolCall", id: "cancelled-tool", name: "write", deltas },
            "FORBIDDEN_FOLLOWING_BLOCK",
          ],
        },
        { content: ["next-response"] },
      ],
    });
    const stream = model.stream(model, context, { signal: controller.signal });
    const completion = stream.result();
    const events = [];
    const reading = (async () => {
      for await (const event of stream) events.push(structuredClone(event));
    })();
    let terminalContent: unknown;
    await blocked.promise;
    controller.abort();
    try {
      const message = await Promise.race([
        completion,
        delay(1000).then(() => {
          throw new Error("abort waited for blocked block deltas");
        }),
      ]);
      await reading;
      assert.equal(message.stopReason, "aborted");
      assert.deepEqual(message.content, [
        { type: "toolCall", id: "cancelled-tool", name: "write", arguments: prefix },
      ]);
      terminalContent = structuredClone(message.content);
      assert.deepEqual(
        events.map((event) => event.type),
        ["start", "toolcall_start", "toolcall_delta", "error"],
      );
      assert.equal(events[1].contentIndex, 0);
      assert.equal(events[2].contentIndex, 0);
      assert.equal(events[2].delta, prefix);
      assert.equal(await text(model), "next-response");
    } finally {
      release.resolve();
    }
    await closed.promise;
    await delay(0);
    assert.deepEqual((await completion).content, terminalContent);
    assert.deepEqual(
      events.map((event) => event.type),
      ["start", "toolcall_start", "toolcall_delta", "error"],
    );
  },
);

test(
  "block delta producer failures reject iteration and result without closing the visible prefix",
  { timeout: 5000 },
  async () => {
    const failure = new Error("block delta producer failed");
    for (const block of [
      {
        type: "text",
        deltas: (function* () {
          yield "同步前缀";
          throw failure;
        })(),
      },
      {
        type: "thinking",
        deltas: (async function* () {
          yield "异步前缀";
          throw failure;
        })(),
      },
    ]) {
      const model = createMockModel({ handler: { content: [block] } });
      const stream = model.stream(model, context);
      const events = [];
      await assert.rejects(
        async () => {
          for await (const event of stream) events.push(structuredClone(event));
        },
        (error) => error === failure,
      );
      await assert.rejects(stream.result(), (error) => error === failure);
      assert.deepEqual(
        events.map((event) => event.type),
        ["start", `${block.type}_start`, `${block.type}_delta`],
      );
      assert.equal(events[2].contentIndex, 0);
      assert.equal(events[2].delta, block.type === "text" ? "同步前缀" : "异步前缀");
    }
  },
);

test("fragmented tools reject incomplete JSON and every block rejects competing complete content", async () => {
  const invalid = createMockModel({
    handler: {
      content: [{ type: "toolCall", name: "write", deltas: ['{"path":', '"unfinished"'] }],
    },
  });
  const stream = invalid.stream(invalid, context);
  const events = [];
  await assert.rejects(async () => {
    for await (const event of stream) events.push(structuredClone(event));
  }, SyntaxError);
  await assert.rejects(stream.result(), SyntaxError);
  assert.deepEqual(
    events.map((event) => event.type),
    ["start", "toolcall_start", "toolcall_delta", "toolcall_delta"],
  );
  assert.equal(events.at(-1).partial.content[0].arguments, '{"path":"unfinished"');
  for (const [field, block] of [
    ["text", { type: "text", text: "complete", deltas: ["fragment"] }],
    ["thinking", { type: "thinking", thinking: "complete", deltas: ["fragment"] }],
    ["arguments", { type: "toolCall", name: "write", arguments: {}, deltas: ["{}"] }],
  ] as const) {
    const model = createMockModel({ handler: { content: [block] } });
    const conflicting = model.stream(model, context);
    const conflictEvents = [];
    await assert.rejects(
      async () => {
        for await (const event of conflicting) conflictEvents.push(event.type);
      },
      (error: unknown) =>
        error instanceof TypeError &&
        error.message.includes("deltas") &&
        error.message.includes(field),
    );
    await assert.rejects(
      conflicting.result(),
      (error: unknown) =>
        error instanceof TypeError &&
        error.message.includes("deltas") &&
        error.message.includes(field),
    );
    assert.equal(
      conflictEvents.some(
        (type) => type.endsWith("_delta") || type.endsWith("_end") || type === "done",
      ),
      false,
    );
  }
});

test("copied event stream drains compacted backlog, fails waiting consumers and settles result-less end", async () => {
  const stream = new EventStream(
    (event: number) => event === 200,
    (event: number) => event,
  );
  for (let index = 0; index <= 200; index++) stream.push(index);
  const backlog = [];
  for await (const event of stream) backlog.push(event);
  assert.deepEqual(
    backlog,
    Array.from({ length: 201 }, (_, index) => index),
  );
  assert.equal(await stream.result(), 200);
  stream.push(201);
  const afterTerminal = [];
  for await (const event of stream) afterTerminal.push(event);
  assert.deepEqual(afterTerminal, []);
  const ended = new AssistantMessageEventStream();
  const waiting = ended[Symbol.asyncIterator]().next();
  ended.end();
  assert.equal((await waiting).done, true);
  await assert.rejects(ended.result(), /without a final result/);
  const failed = new AssistantMessageEventStream();
  const failedWait = failed[Symbol.asyncIterator]().next();
  failed.fail(new Error("stream failed"));
  await assert.rejects(failedWait, /stream failed/);
  await assert.rejects(failed.result(), /stream failed/);
  const work = Promise.withResolvers<void>();
  const parent = new AssistantMessageEventStream();
  const child = new AssistantMessageEventStream();
  parent.forwardLocalWorkFrom(child);
  const tracked = child.trackLocalWork(work.promise);
  assert.equal(parent.hasPendingLocalWork, true);
  work.resolve();
  await tracked;
  assert.equal(parent.hasPendingLocalWork, false);
  assert.ok(parent.localWorkSettledAt > 0);
  parent.forwardLocalWorkFrom(undefined);
  assert.equal(parent.localWorkSettledAt, 0);
});

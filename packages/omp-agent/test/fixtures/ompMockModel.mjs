/**
 * Derived from oh-my-pi packages/ai/src/providers/mock.ts at
 * 57672f546162e16b019484626c3b5fa9300aafef, MIT (see third-party/upstream/omp-mock.LICENSE).
 * Modified by ZCode: erase TypeScript, remove catalog/global API registration,
 * use native errors and local event stream; catch unexpected producer failures
 * so malformed scripts cannot create background unhandled rejections; add
 * cancellable per-block deltas without changing complete-block scripts.
 */
import { AssistantMessageEventStream } from "./ompMockStream.mjs";

export const MOCK_API = "mock";
const ZERO_COST = { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 };

export class MockModel {
  api = MOCK_API;
  input = ["text", "image"];
  compat = undefined;
  calls = [];
  extras = [];
  toolCallCounter = 0;

  constructor(options = {}) {
    this.id = options.id ?? "mock-model";
    this.name = options.id ?? "mock-model";
    this.provider = options.provider ?? "mock";
    this.baseUrl = options.baseUrl ?? "mock://";
    this.reasoning = options.reasoning ?? false;
    this.cost = options.cost ?? ZERO_COST;
    this.contextWindow = options.contextWindow ?? 200_000;
    this.maxTokens = options.maxTokens ?? 32_768;
    this.iterator = options.responses === undefined ? undefined : iteratorOf(options.responses);
    this.exhausted = options.responses === undefined;
    this.fallback = options.handler;
  }

  get model() {
    return this;
  }
  stream = (_model, context, options) => streamMock(this, context, options);
  push(response) {
    this.extras.push(response);
  }
  // Constructor responses deliberately do not rewind.
  reset() {
    this.extras.length = 0;
    this.calls.length = 0;
    this.toolCallCounter = 0;
  }
}

export function isMockModel(model) {
  return model instanceof MockModel;
}
export function createMockModel(options = {}) {
  return new MockModel(options);
}

export function streamMock(model, context, options) {
  const stream = new AssistantMessageEventStream();
  if (!isMockModel(model)) {
    queueMicrotask(() =>
      stream.fail(
        new Error(
          "streamMock called with a model not produced by createMockModel(). Pass a MockModel instance.",
        ),
      ),
    );
    return stream;
  }
  model.calls.push({ context, options });
  void runMock(stream, model, context, options).catch((error) => stream.fail(error));
  return stream;
}

function iteratorOf(source) {
  if (Symbol.asyncIterator in source) return source[Symbol.asyncIterator]();
  return source[Symbol.iterator]();
}

async function pullHandler(state) {
  if (state.iterator && !state.exhausted) {
    const result = await Promise.resolve(state.iterator.next());
    if (!result.done) return result.value;
    state.exhausted = true;
  }
  if (state.extras.length > 0) return state.extras.shift();
  return state.fallback;
}

async function runMock(stream, model, context, options) {
  const startedAt = Date.now();
  const perfStart = performance.now();
  let handler;
  try {
    handler = await pullHandler(model);
  } catch (error) {
    stream.fail(error);
    return;
  }
  if (handler === undefined) {
    stream.fail(
      new Error(
        `Mock model "${model.id}" received call ${model.calls.length} but no response or handler is configured.`,
      ),
    );
    return;
  }
  let response;
  try {
    response = typeof handler === "function" ? await handler(context, options) : handler;
  } catch (error) {
    stream.fail(error);
    return;
  }
  if (response.responseHeaders && options?.onResponse) {
    const headers = {};
    for (const [key, value] of Object.entries(response.responseHeaders))
      headers[key.toLowerCase()] = value;
    try {
      await options.onResponse(
        {
          status: response.responseStatus ?? 200,
          headers,
          ...(response.responseRequestId !== undefined
            ? { requestId: response.responseRequestId }
            : {}),
        },
        model,
      );
    } catch (error) {
      stream.fail(error);
      return;
    }
  }
  if (response.delayMs && response.delayMs > 0) {
    try {
      await sleep(response.delayMs, options?.signal);
    } catch {
      emitTerminalError(
        stream,
        model,
        startedAt,
        perfStart,
        "aborted",
        "Mock aborted during delay.",
      );
      return;
    }
  }
  if (response.throw !== undefined) {
    const message =
      typeof response.throw === "string"
        ? response.throw
        : response.throw instanceof Error
          ? response.throw.message
          : String(response.throw);
    emitTerminalError(stream, model, startedAt, perfStart, "error", message);
    return;
  }
  const blocks = [];
  const partial = {
    role: "assistant",
    content: blocks,
    api: model.api,
    provider: model.provider,
    model: model.id,
    responseId: response.responseId,
    usage: emptyUsage(),
    stopReason: "stop",
    timestamp: startedAt,
  };
  stream.push({ type: "start", partial });
  try {
    for await (const input of cancellableContent(response.content ?? [], options?.signal)) {
      const block = normalizeContent(input, model);
      blocks.push(block);
      const contentIndex = blocks.length - 1;
      if (input.deltas !== undefined) {
        await emitBlockDeltas(stream, partial, contentIndex, input.deltas, options?.signal);
        continue;
      }
      if (block.type === "text") {
        stream.push({ type: "text_start", contentIndex, partial });
        stream.push({ type: "text_delta", contentIndex, delta: block.text, partial });
        stream.push({ type: "text_end", contentIndex, content: block.text, partial });
      } else if (block.type === "thinking") {
        stream.push({ type: "thinking_start", contentIndex, partial });
        stream.push({ type: "thinking_delta", contentIndex, delta: block.thinking, partial });
        stream.push({ type: "thinking_end", contentIndex, content: block.thinking, partial });
      } else {
        const serialized =
          typeof block.arguments === "string" ? block.arguments : JSON.stringify(block.arguments);
        stream.push({ type: "toolcall_start", contentIndex, partial });
        stream.push({ type: "toolcall_delta", contentIndex, delta: serialized, partial });
        stream.push({ type: "toolcall_end", contentIndex, toolCall: block, partial });
      }
    }
  } catch (error) {
    if (!options?.signal?.aborted) throw error;
    partial.stopReason = "aborted";
    partial.errorMessage = "Mock aborted during content.";
    partial.duration = performance.now() - perfStart;
    stream.push({ type: "error", reason: "aborted", error: partial });
    return;
  }
  const hasToolCall = blocks.some((block) => block.type === "toolCall");
  const reason = response.stopReason ?? (hasToolCall ? "toolUse" : "stop");
  partial.stopReason = reason;
  partial.stopDetails = response.stopDetails;
  partial.fallbackCreditHandle = response.fallbackCreditHandle;
  partial.errorMessage = response.errorMessage;
  partial.usage = mergeUsage(response.usage);
  partial.serviceTier = response.serviceTier;
  partial.duration = performance.now() - perfStart;
  if (reason === "aborted" || reason === "error") {
    stream.push({
      type: "error",
      reason,
      error: { ...partial, errorMessage: partial.errorMessage ?? "mock error" },
    });
    return;
  }
  stream.push({ type: "done", reason, message: partial });
}

async function emitBlockDeltas(stream, partial, contentIndex, deltas, signal) {
  const block = partial.content[contentIndex];
  const tool = block.type === "toolCall";
  const prefix = tool ? "toolcall" : block.type;
  const field = tool ? "arguments" : block.type;
  stream.push({ type: `${prefix}_start`, contentIndex, partial });
  // 分片只能追加到同一块；复用可取消迭代器，避免屏障阻塞取消或晚到内容复活。
  for await (const delta of cancellableContent(deltas, signal)) {
    if (typeof delta !== "string") throw new TypeError("Mock block deltas must be strings.");
    block[field] += delta;
    stream.push({ type: `${prefix}_delta`, contentIndex, delta, partial });
  }
  if (tool) block.arguments = JSON.parse(block.arguments);
  stream.push({
    type: `${prefix}_end`,
    contentIndex,
    ...(tool ? { toolCall: block } : { content: block[field] }),
    partial,
  });
}

async function* cancellableContent(source, signal) {
  const iterator = iteratorOf(source);
  let finished = false;
  let abort;
  const cancelled = new Promise((_, reject) => {
    abort = () => reject(signal.reason ?? new Error("Mock content aborted"));
    if (signal?.aborted) abort();
    else signal?.addEventListener("abort", abort, { once: true });
  });
  // 预先取消或 next() 同步抛错时可能尚未建立 race；拒绝仍由下面的 abort 分支交付。
  cancelled.catch(() => {});
  // 取消时 next() 可能仍停在模型屏障；终态不能等待生产者配合，也不能晚到复活。
  try {
    while (true) {
      if (signal?.aborted) throw signal.reason ?? new Error("Mock content aborted");
      const result = await Promise.race([Promise.resolve(iterator.next()), cancelled]);
      if (signal?.aborted) throw signal.reason ?? new Error("Mock content aborted");
      if (result.done) {
        finished = true;
        return;
      }
      yield result.value;
    }
  } finally {
    signal?.removeEventListener("abort", abort);
    if (!finished && iterator.return) {
      if (signal?.aborted) void Promise.resolve(iterator.return()).catch(() => {});
      else await iterator.return();
    }
  }
}

function normalizeContent(input, state) {
  if (typeof input === "string") return { type: "text", text: input };
  if (input.deltas !== undefined) {
    const field = { text: "text", thinking: "thinking", toolCall: "arguments" }[input.type];
    if (!field) throw new TypeError(`Unsupported mock delta block: ${input.type}`);
    if (input[field] !== undefined)
      throw new TypeError(`Mock block deltas cannot be combined with ${field}.`);
    const block = { ...input };
    delete block.deltas;
    block[field] = "";
    if (block.type === "toolCall") block.id = block.id ?? generateToolCallId(state);
    return block;
  }
  if (input.type === "toolCall")
    return {
      type: "toolCall",
      id: input.id ?? generateToolCallId(state),
      name: input.name,
      arguments: typeof input.arguments === "string" ? input.arguments : { ...input.arguments },
    };
  return input;
}

function emptyUsage() {
  return {
    input: 0,
    output: 0,
    cacheRead: 0,
    cacheWrite: 0,
    totalTokens: 0,
    cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
  };
}

function mergeUsage(partial) {
  const base = emptyUsage();
  if (!partial) return base;
  const merged = { ...base, ...partial };
  const costProvided = partial.cost !== undefined;
  if (costProvided) merged.cost = { ...base.cost, ...partial.cost };
  if (partial.totalTokens === undefined) {
    const orchestration = merged.orchestration;
    merged.totalTokens =
      merged.input +
      merged.output +
      merged.cacheRead +
      merged.cacheWrite +
      (orchestration?.input ?? 0) +
      (orchestration?.output ?? 0) +
      (orchestration?.cacheRead ?? 0);
  }
  if (costProvided && partial.cost?.total === undefined) {
    merged.cost.total =
      merged.cost.input + merged.cost.output + merged.cost.cacheRead + merged.cost.cacheWrite;
  }
  return merged;
}

function emitTerminalError(stream, model, startedAt, perfStart, reason, message) {
  const failure = {
    role: "assistant",
    content: [],
    api: model.api,
    provider: model.provider,
    model: model.id,
    usage: emptyUsage(),
    stopReason: reason,
    errorMessage: message,
    timestamp: startedAt,
    duration: performance.now() - perfStart,
  };
  stream.push({ type: "start", partial: failure });
  stream.push({ type: "error", reason, error: failure });
}

function sleep(ms, signal) {
  const { promise, resolve, reject } = Promise.withResolvers();
  if (signal?.aborted) {
    reject(signal.reason);
    return promise;
  }
  const onAbort = () => {
    clearTimeout(timer);
    signal?.removeEventListener("abort", onAbort);
    reject(signal?.reason ?? new Error("aborted"));
  };
  const timer = setTimeout(() => {
    signal?.removeEventListener("abort", onAbort);
    resolve();
  }, ms);
  signal?.addEventListener("abort", onAbort, { once: true });
  return promise;
}

function generateToolCallId(state) {
  state.toolCallCounter += 1;
  return `mock-tc-${state.toolCallCounter}`;
}

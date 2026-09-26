// ZCode Protocol stdio 服务端：NDJSON 请求/响应/通知 + agent→host 反向请求。
// 与 apps/zcode-cli 的 ZCodeProtocolNdjsonConnection 语义对齐（response 先行，无 ready 握手帧）。

import { createInterface } from "node:readline";
import { appendFileSync } from "node:fs";
import { AsyncLocalStorage } from "node:async_hooks";
import { encodeJsonlLine } from "../domain/jsonlFraming.js";
import type { HostGateway, HostUserInputAnswer } from "../app/ports.js";
import { logger } from "./logger.js";

// OMP_AGENT_DEBUG_LOG：开发诊断用帧日志（dev 回环临时开启；生产不设置即零开销）。
const DEBUG_LOG = process.env.OMP_AGENT_DEBUG_LOG ?? "";

function debugLog(direction: string, line: string): void {
  if (!DEBUG_LOG) {
    return;
  }
  try {
    appendFileSync(DEBUG_LOG, `${new Date().toISOString()} ${direction} ${line.slice(0, 400)}\n`);
  } catch {
    // 诊断日志失败不影响协议。
  }
}

export interface ProtocolServerOptions {
  input: NodeJS.ReadableStream;
  output: NodeJS.WritableStream;
  handleRequest(method: string, params: unknown): Promise<unknown>;
  handleNotification?(method: string, params: unknown): void;
  onClosed?(error?: Error): void;
}

interface PendingReverseRequest {
  resolve: (result: unknown) => void;
  reject: (error: Error) => void;
  timer: NodeJS.Timeout;
}

interface RequestOutbox {
  active: boolean;
  frames: unknown[];
  flushScheduled: boolean;
}

/** 同一会话保序，跨会话请求独立；无会话 ID 的工作区命令留在一个串行队列。 */
function requestQueueKey(params: unknown): string {
  if (typeof params !== "object" || params === null) return "workspace";
  const record = params as Record<string, unknown>;
  const envelope = record.envelope;
  const nested =
    typeof envelope === "object" && envelope !== null
      ? (envelope as Record<string, unknown>)
      : null;
  const sessionId = nested?.sessionId ?? record.sessionId;
  if (typeof sessionId === "string" && sessionId.length > 0) return `conversation/${sessionId}`;
  const topic = record.topic;
  if (typeof topic === "string" && topic.length > 0) return topic;
  return "workspace";
}

export class ProtocolServer implements HostGateway {
  private readonly options: ProtocolServerOptions;
  private pending = new Map<string, PendingReverseRequest>();
  private closed = false;
  private outputBackpressured = false;
  private readonly pendingEncodedLines: string[] = [];
  private pendingEncodedBytes = 0;
  // 请求处理期间产生的下行帧必须缓存在 response 行之后发出（post-response outbox）。
  // renderer 的订阅流程按「先 ACK 后 initial 帧」建立路由，先到的帧会被丢弃，
  // 订阅恢复等不到有效帧就会 fail-closed（GUI 链路实测踩坑）。
  // outbox 生命周期被压到当前事件循环轮次：response 行与同步发射同属一个微任务级联，
  // setImmediate 必在其后，ACK-first 仍然成立；而请求上下文内注册的 flush 定时器
  // （topicPublisher 30ms 窗口）触发的帧若被扣到请求结束，事件上下文（omp 流式）
  // 的后续更高区间帧会直写线上，同一 topic 区间倒挂，客户端按断档进入恢复
  // （GUI 实测踩坑：sessions-index 非单调 → fail-closed 风暴）。因此缓冲帧在
  // 当前轮次结束即按序上线，不持有到请求结束。
  private readonly requestOutboxes = new AsyncLocalStorage<RequestOutbox>();
  private readonly dispatchTails = new Map<string, Promise<void>>();

  constructor(options: ProtocolServerOptions) {
    this.options = options;
  }

  start(): void {
    const readline = createInterface({ input: this.options.input });
    readline.on("line", (line) => this.handleLine(line));
    readline.once("close", () => this.close());
  }

  private handleLine(line: string): void {
    debugLog("h2a", line.slice(0, 400));
    const trimmed = line.trim();
    if (trimmed.length === 0) {
      return;
    }
    let message: unknown;
    try {
      message = JSON.parse(trimmed);
    } catch {
      logger.warn("host 帧不是 JSON", { preview: trimmed.slice(0, 200) });
      return;
    }
    if (typeof message !== "object" || message === null) {
      return;
    }
    const record = message as {
      id?: unknown;
      method?: unknown;
      params?: unknown;
      result?: unknown;
      error?: unknown;
    };
    if (typeof record.method === "string") {
      if (record.id !== undefined && record.id !== null) {
        this.handleHostRequest(record.id as string | number, record.method, record.params);
      } else {
        this.options.handleNotification?.(record.method, record.params);
      }
      return;
    }
    if (record.id !== undefined && (record.result !== undefined || record.error !== undefined)) {
      const pending = this.pending.get(String(record.id));
      if (pending) {
        this.pending.delete(String(record.id));
        clearTimeout(pending.timer);
        if (record.error !== undefined) {
          pending.reject(
            new Error(
              typeof record.error === "string" ? record.error : JSON.stringify(record.error),
            ),
          );
        } else {
          pending.resolve(record.result);
        }
      }
    }
  }

  private handleHostRequest(id: string | number, method: string, params: unknown): void {
    const key = requestQueueKey(params);
    const previous = this.dispatchTails.get(key) ?? Promise.resolve();
    const current = previous
      .then(() => this.processHostRequest(id, method, params))
      .catch(() => {});
    this.dispatchTails.set(key, current);
    void current.then(() => {
      if (this.dispatchTails.get(key) === current) this.dispatchTails.delete(key);
    });
  }

  private async processHostRequest(
    id: string | number,
    method: string,
    params: unknown,
  ): Promise<void> {
    const outbox: RequestOutbox = { active: true, frames: [], flushScheduled: false };
    try {
      const result = await this.requestOutboxes.run(outbox, () =>
        this.options.handleRequest(method, params),
      );
      this.write({ id, result: result ?? {} });
    } catch (error) {
      const code = (error as { code?: number }).code;
      const message = error instanceof Error ? error.message : String(error);
      logger.warn("host 请求处理失败", { method, message });
      this.write({ id, error: { code: typeof code === "number" ? code : -32603, message } });
    } finally {
      outbox.active = false;
    }
    this.flushOutboxFrames(outbox);
  }

  private flushOutboxFrames(outbox: RequestOutbox): void {
    for (const frame of outbox.frames.splice(0)) {
      this.notify("v4/conversation/frame", frame);
    }
  }

  private write(value: unknown): void {
    if (this.closed) {
      return;
    }
    const encoded = encodeJsonlLine(value);
    if (DEBUG_LOG) debugLog("a2h", encoded.slice(0, 400));
    if (this.outputBackpressured) {
      this.pendingEncodedBytes += Buffer.byteLength(encoded);
      if (this.pendingEncodedBytes > 16 * 1024 * 1024) {
        // Bug 根因：Host 暂停消费时 write(false) 被忽略，Agent 可无限堆积帧。
        // 明确关闭连接触发 Host 重连，不静默舍弃已接受的连续帧。
        this.close(new Error("host transport buffer saturated"));
        this.options.output.end();
        return;
      }
      this.pendingEncodedLines.push(encoded);
      return;
    }
    if (!this.options.output.write(encoded)) {
      this.outputBackpressured = true;
      this.options.output.once("drain", () => this.flushPendingEncodedLines());
    }
  }

  private flushPendingEncodedLines(): void {
    if (this.closed) return;
    while (this.pendingEncodedLines.length > 0) {
      const encoded = this.pendingEncodedLines.shift()!;
      this.pendingEncodedBytes -= Buffer.byteLength(encoded);
      if (!this.options.output.write(encoded)) {
        this.options.output.once("drain", () => this.flushPendingEncodedLines());
        return;
      }
    }
    this.outputBackpressured = false;
  }

  private close(error?: Error): void {
    if (this.closed) return;
    this.closed = true;
    for (const pending of this.pending.values()) {
      clearTimeout(pending.timer);
      pending.reject(error ?? new Error("host transport closed"));
    }
    this.pending.clear();
    this.pendingEncodedLines.length = 0;
    this.pendingEncodedBytes = 0;
    this.options.onClosed?.(error);
  }

  notify(method: string, params: unknown): void {
    this.write({ method, params });
  }

  emitFrame(params: unknown): void {
    const outbox = this.requestOutboxes.getStore();
    if (outbox?.active) {
      outbox.frames.push(params);
      if (!outbox.flushScheduled) {
        outbox.flushScheduled = true;
        // Bug 根因：请求上下文里注册的 flush 定时器（30ms 窗口）会把帧扣到请求
        // 结束才发；期间事件上下文的更高区间帧直写线上，同一 topic 区间倒挂，
        // 客户端断档恢复。当前轮次结束即 flush，既保 ACK-first 又保线上单调。
        setImmediate(() => {
          outbox.flushScheduled = false;
          this.flushOutboxFrames(outbox);
        });
      }
      return;
    }
    this.notify("v4/conversation/frame", params);
  }

  requestUserInput(params: {
    requestId: string;
    sessionId: string;
    prompt: string;
    options?: { optionId: string; label: string }[];
  }): Promise<HostUserInputAnswer> {
    return new Promise<HostUserInputAnswer>((resolve, reject) => {
      if (this.closed) {
        reject(new Error("host transport closed"));
        return;
      }
      const timer = setTimeout(() => {
        this.pending.delete(params.requestId);
        reject(new Error("host interaction timeout"));
      }, 170_000);
      timer.unref?.();
      this.pending.set(params.requestId, {
        resolve: (result) => resolve(userInputAnswerOf(result)),
        reject,
        timer,
      });
      this.write({
        id: params.requestId,
        method: "interaction/requestUserInput",
        params: {
          requestId: params.requestId,
          sessionId: params.sessionId,
          prompt: params.prompt,
          ...(params.options ? { input: { options: params.options } } : {}),
        },
      });
    });
  }

  dispose(): void {
    this.close();
  }
}

function userInputAnswerOf(result: unknown): HostUserInputAnswer {
  if (typeof result !== "object" || result === null) {
    return { action: "cancel" };
  }
  const record = result as { action?: unknown; content?: unknown };
  if (record.action === "accept" || record.action === "decline" || record.action === "cancel") {
    const content =
      typeof record.content === "object" && record.content !== null
        ? (record.content as Record<string, unknown>)
        : {};
    const optionId = typeof content.optionId === "string" ? content.optionId : undefined;
    const freeText =
      typeof content.freeText === "string"
        ? content.freeText
        : typeof content.value === "string"
          ? content.value
          : undefined;
    return record.action === "accept"
      ? { action: "accept", optionId, freeText }
      : { action: record.action };
  }
  return { action: "cancel" };
}

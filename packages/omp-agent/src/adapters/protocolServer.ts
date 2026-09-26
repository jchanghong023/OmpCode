// ZCode Protocol stdio 服务端：NDJSON 请求/响应/通知 + agent→host 反向请求。
// 与 apps/zcode-cli 的 ZCodeProtocolNdjsonConnection 语义对齐（response 先行，无 ready 握手帧）。

import { createInterface } from "node:readline";
import { appendFileSync } from "node:fs";
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
  onClosed?(): void;
}

interface PendingReverseRequest {
  resolve: (result: unknown) => void;
  reject: (error: Error) => void;
  timer: NodeJS.Timeout;
}

export class ProtocolServer implements HostGateway {
  private readonly options: ProtocolServerOptions;
  private pending = new Map<string, PendingReverseRequest>();
  private closed = false;
  // 请求处理期间产生的下行帧必须缓存在 response 行之后发出（post-response outbox）。
  // renderer 的订阅流程按「先 ACK 后 initial 帧」建立路由，先到的帧会被丢弃，
  // 订阅恢复等不到有效帧就会 fail-closed（GUI 链路实测踩坑）。
  private frameOutbox: unknown[] = [];
  private inRequest = false;
  // host 请求串行化：并发处理会让 A 的响应/B 的帧交错（outbox 标志失效），
  // 破坏「response 行 → 该请求的 initial 帧」顺序契约（GUI 链路实测踩坑）。
  private dispatchTail: Promise<void> = Promise.resolve();

  constructor(options: ProtocolServerOptions) {
    this.options = options;
  }

  start(): void {
    const readline = createInterface({ input: this.options.input });
    readline.on("line", (line) => this.handleLine(line));
    readline.once("close", () => {
      this.closed = true;
      for (const pending of this.pending.values()) {
        clearTimeout(pending.timer);
        pending.reject(new Error("host transport closed"));
      }
      this.pending.clear();
      this.options.onClosed?.();
    });
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
    this.dispatchTail = this.dispatchTail
      .then(() => this.processHostRequest(id, method, params))
      .catch(() => {});
  }

  private async processHostRequest(
    id: string | number,
    method: string,
    params: unknown,
  ): Promise<void> {
    this.inRequest = true;
    try {
      const result = await this.options.handleRequest(method, params);
      this.write({ id, result: result ?? {} });
    } catch (error) {
      const code = (error as { code?: number }).code;
      const message = error instanceof Error ? error.message : String(error);
      logger.warn("host 请求处理失败", { method, message });
      this.write({ id, error: { code: typeof code === "number" ? code : -32603, message } });
    } finally {
      this.inRequest = false;
    }
    const queued = this.frameOutbox;
    this.frameOutbox = [];
    for (const frame of queued) {
      this.notify("v4/conversation/frame", frame);
    }
  }

  private write(value: unknown): void {
    if (this.closed) {
      return;
    }
    debugLog("a2h", JSON.stringify(value).slice(0, 400));
    this.options.output.write(encodeJsonlLine(value));
  }

  notify(method: string, params: unknown): void {
    this.write({ method, params });
  }

  emitFrame(params: unknown): void {
    if (this.inRequest) {
      this.frameOutbox.push(params);
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
    this.closed = true;
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

// ZCode Protocol stdio 服务端：NDJSON 请求/响应/通知 + agent→host 反向请求。
// 与 apps/zcode-cli 的 ZCodeProtocolNdjsonConnection 语义对齐（response 先行，无 ready 握手帧）。

import { createInterface } from "node:readline";
import { AsyncLocalStorage } from "node:async_hooks";
import { encodeJsonlLine } from "../domain/jsonlFraming.js";
import type { HostGateway, HostUserInputAnswer } from "../app/ports.js";
import { logger } from "./logger.js";
import {
  hostDiagnostics,
  hostRequestContext,
  isInteractionControlRequest,
  logHostInteraction,
  logHostRequestFailure,
  logHostRequestResult,
  observeHostOutput,
  requestQueueKey,
  safeErrorSummary,
  safeInteractionAction,
  userInputAnswerOf,
} from "./hostRequestDiagnostics.js";

// 原开发帧文件会泄漏输入/答案；仅保留 stderr 安全摘要，Main 是唯一文件 writer。
const DEBUG_LOG = Boolean(process.env.OMP_AGENT_DEBUG_LOG);

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
  releaseSignal: () => void;
  context: Record<string, unknown>;
  startedAt: number;
}

interface RequestOutbox {
  active: boolean;
  frames: unknown[];
  flushScheduled: boolean;
}

// S5-3 依据：本服务端仅发出两类反向请求——interaction/requestUserInput 与
// interaction/requestPermission，均为交互应答类（无非交互类反向请求经过 pending 表）。
// omp 侧权限门 await 无超时（Promise.withResolvers，仅 abort/dispose 可解）、login secret
// 输入 timeout 600_000（rpc-session-host.ts）、ask 的 snooze（ask_pause）表示用户继续作答；
// 原 170s 预算会在这些业务时序内把用户正在处理的审批/登录/表单自动超时，违反协议
// §7.3「截止与暂停等已存在的业务语义归 OMP」。放宽为与 OmpInteractionProxy 的
// INTERACTION_WAIT_BUDGET_MS 一致的宽裕兜底预算（仅防泄漏；主收口是 dispose/close）。
const INTERACTION_REVERSE_REQUEST_TIMEOUT_MS = 30 * 60_000;

export class ProtocolServer implements HostGateway {
  private readonly options: ProtocolServerOptions;
  private pending = new Map<string, PendingReverseRequest>();
  private closed = false;
  private outputBackpressured = false;
  private startedAt = Date.now();
  private backpressureStartedAt = 0;
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
    if (DEBUG_LOG) hostDiagnostics.debugFileDisabled();
    this.startedAt = Date.now();
    const readline = createInterface({ input: this.options.input });
    readline.on("line", (line) => this.handleLine(line));
    readline.once("close", () => this.close());
  }

  private handleLine(line: string): void {
    if (DEBUG_LOG) hostDiagnostics.frame("received", line);
    const trimmed = line.trim();
    if (trimmed.length === 0) {
      return;
    }
    let message: unknown;
    try {
      message = JSON.parse(trimmed);
    } catch {
      hostDiagnostics.invalidJson(trimmed);
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
        logger.run(
          hostRequestContext(record.id as string | number, record.method, record.params),
          () =>
            this.handleHostRequest(
              record.id as string | number,
              record.method as string,
              record.params,
            ),
        );
      } else {
        try {
          this.options.handleNotification?.(record.method, record.params);
        } catch (error) {
          hostDiagnostics.notificationFailed(record.method, error);
          throw error;
        }
      }
      return;
    }
    if (record.id !== undefined && (record.result !== undefined || record.error !== undefined)) {
      const pending = this.pending.get(String(record.id));
      if (pending) {
        this.pending.delete(String(record.id));
        clearTimeout(pending.timer);
        pending.releaseSignal();
        if (record.error !== undefined) {
          logHostInteraction(
            "error",
            pending.context,
            pending.startedAt,
            "response",
            safeErrorSummary(record.error),
          );
        } else {
          logHostInteraction("response", pending.context, pending.startedAt, "response", {
            action: safeInteractionAction(record.result),
          });
        }
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
    const receivedAt = Date.now();
    hostDiagnostics.received(isInteractionControlRequest(method, params));
    if (isInteractionControlRequest(method, params)) {
      // 同步 prompt/confirm 尚未 ACK 时，回答/停止若等同一尾链会与等待用户形成死锁。
      // 同轮微任务保留先收到请求的启动顺序，但控制回路不等待普通请求完成。
      void Promise.resolve()
        .then(() => this.processHostRequest(id, method, params, receivedAt))
        .catch(() => {});
      return;
    }
    const key = requestQueueKey(params);
    const previous = this.dispatchTails.get(key) ?? Promise.resolve();
    const current = previous
      .then(() => this.processHostRequest(id, method, params, receivedAt))
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
    receivedAt: number,
  ): Promise<void> {
    const outbox: RequestOutbox = { active: true, frames: [], flushScheduled: false };
    const startedAt = Date.now();
    let stage = "handle";
    hostDiagnostics.started(startedAt - receivedAt);
    try {
      const result = await this.requestOutboxes.run(outbox, () =>
        this.options.handleRequest(method, params),
      );
      stage = "response";
      this.write({ id, result: result ?? {} });
      logHostRequestResult(result, Date.now() - startedAt, this.closed);
    } catch (error) {
      const code = (error as { code?: number }).code;
      const message = error instanceof Error ? error.message : String(error);
      logHostRequestFailure(
        error,
        typeof code === "number" ? code : -32603,
        stage,
        Date.now() - startedAt,
      );
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
    const encoded = observeHostOutput("encode", () => encodeJsonlLine(value));
    if (DEBUG_LOG) hostDiagnostics.frame("sent", encoded);
    if (this.outputBackpressured) {
      this.pendingEncodedBytes += Buffer.byteLength(encoded);
      if (this.pendingEncodedBytes > 16 * 1024 * 1024) {
        // Bug 根因：Host 暂停消费时 write(false) 被忽略，Agent 可无限堆积帧。
        // 明确关闭连接触发 Host 重连，不静默舍弃已接受的连续帧。
        hostDiagnostics.backpressureFailed(
          this.pendingEncodedBytes,
          Date.now() - this.backpressureStartedAt,
        );
        this.close(new Error("host transport buffer saturated"));
        this.options.output.end();
        return;
      }
      this.pendingEncodedLines.push(encoded);
      return;
    }
    if (!observeHostOutput("send", () => this.options.output.write(encoded))) {
      this.outputBackpressured = true;
      this.backpressureStartedAt = Date.now();
      hostDiagnostics.backpressureStarted();
      this.options.output.once("drain", () => this.flushPendingEncodedLines());
    }
  }

  private flushPendingEncodedLines(): void {
    if (this.closed) return;
    while (this.pendingEncodedLines.length > 0) {
      const encoded = this.pendingEncodedLines.shift()!;
      this.pendingEncodedBytes -= Buffer.byteLength(encoded);
      if (!observeHostOutput("drain", () => this.options.output.write(encoded))) {
        this.options.output.once("drain", () => this.flushPendingEncodedLines());
        return;
      }
    }
    this.outputBackpressured = false;
    hostDiagnostics.backpressureDrained(Date.now() - this.backpressureStartedAt);
  }

  private close(error?: Error): void {
    if (this.closed) return;
    this.closed = true;
    hostDiagnostics.closed(this.pending.size, error, Date.now() - this.startedAt);
    for (const pending of this.pending.values()) {
      clearTimeout(pending.timer);
      pending.releaseSignal();
      logHostInteraction("disconnect", pending.context, pending.startedAt, "disconnect");
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

  requestUserInput(
    params: {
      requestId: string;
      sessionId: string;
      prompt: string;
      options?: { optionId: string; label: string }[];
      questions?: unknown[];
    },
    signal?: AbortSignal,
  ): Promise<HostUserInputAnswer> {
    const startedAt = Date.now();
    const context = {
      ...logger.context(),
      interactionRequestId: params.requestId,
      sessionId: params.sessionId,
    };
    logHostInteraction("started", context, startedAt, "send", {
      questionCount: params.questions?.length,
      optionCount: params.options?.length,
    });
    return new Promise<HostUserInputAnswer>((resolve, reject) => {
      if (signal?.aborted) {
        reject(new DOMException("Host interaction wait released", "AbortError"));
        return;
      }
      if (this.closed) {
        logHostInteraction("disconnect", context, startedAt, "send");
        reject(new Error("host transport closed"));
        return;
      }
      const timer = setTimeout(() => {
        this.pending.delete(params.requestId);
        pending.releaseSignal();
        logHostInteraction("timeout", context, startedAt, "timeout");
        reject(new Error("host interaction timeout"));
      }, INTERACTION_REVERSE_REQUEST_TIMEOUT_MS);
      timer.unref?.();
      const pending: PendingReverseRequest = {
        resolve: (result) => resolve(userInputAnswerOf(result)),
        reject,
        timer,
        releaseSignal: () => signal?.removeEventListener("abort", onAbort),
        context,
        startedAt,
      };
      this.pending.set(params.requestId, pending);
      // 反向 pending 的唯一 owner 在此；其他结算入口只撤销等待，不伪造宿主答案。
      const onAbort = () => {
        if (this.pending.get(params.requestId) !== pending) return;
        this.pending.delete(params.requestId);
        clearTimeout(timer);
        pending.releaseSignal();
        reject(new DOMException("Host interaction wait released", "AbortError"));
      };
      signal?.addEventListener("abort", onAbort, { once: true });
      try {
        this.write({
          id: params.requestId,
          method: "interaction/requestUserInput",
          params: {
            requestId: params.requestId,
            sessionId: params.sessionId,
            prompt: params.prompt,
            ...(params.options ? { input: { options: params.options } } : {}),
            // 富问答（AskUserQuestion 形态）：完整问题集随反向请求下发。
            ...(params.questions ? { questions: params.questions } : {}),
          },
        });
      } catch (error) {
        this.pending.delete(params.requestId);
        clearTimeout(timer);
        pending.releaseSignal();
        logHostInteraction("error", context, startedAt, "send", safeErrorSummary(error));
        reject(error instanceof Error ? error : new Error(String(error)));
      }
    });
  }

  dispose(): void {
    this.close();
  }
}

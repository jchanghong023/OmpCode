// omp 子进程适配器：spawn 内嵌 omp 二进制（--mode rpc-ui），讲 omp RPC-UI。
// 负责 ready、协议协商（v2 分片重组）、命令关联与事件/扩展 UI 分发。

import { spawn, type ChildProcessWithoutNullStreams } from "node:child_process";
import { randomUUID } from "node:crypto";
import { createInterface } from "node:readline";
import { OmpFrameAssembler } from "../domain/frameAssembler.js";
import { parseOmpContextReport, type OmpContextReport } from "../domain/ompContextReport.js";
import { ompRpcChunkFrameSchema, ompStateDataSchema, type OmpCommandFrame } from "../domain/ompFrames.js";
import type { OmpBypassFrame } from "../domain/ompForkFrames.js";
import { encodeJsonlLine } from "../domain/jsonlFraming.js";
import { awaitOmpReady } from "./ompReady.js";
import { dispatchOmpFrame } from "./ompFrameDispatch.js";
import { parseJson } from "./jsonl.js";
import type { OmpCommandOutcome, OmpProcessFactory, OmpSessionProcess, OmpStateData, OmpAskRequest, OmpUiRequest, OmpSideChannelHandlers } from "../app/ports.js";
import { logger } from "./logger.js";
import { PromptResultTracker } from "../domain/promptResultTracker.js";
import { ompCoreFields, startOmpRpc, finishOmpRpc, finishOmpRpcResponse, logOmpCoreExit, logOmpCoreSubscription, type OmpRpcDiagnostic } from "./ompRpcDiagnostics.js";

const COMMAND_TIMEOUT_MS = 120_000;

// 修复（A8）：用户输入类命令（prompt/steer/follow_up/abort_and_prompt）的响应在 omp 输入门 admission 前有意挂起，可跨分钟
// （图像规范化/视觉描述、rpc-fork-permission 权限门 await 无超时）；固定 120s 会误判在途 prompt 失败，放宽到 10 分钟，
// 进程死亡由 handleExit 的 pending 结算兜底，超时不承担存活探测职责。
const USER_INPUT_COMMAND_TIMEOUT_MS = 600_000;
const USER_INPUT_COMMAND_TYPES: ReadonlySet<string> = new Set(["prompt", "steer", "follow_up", "abort_and_prompt"]);

/** 按命令类型选择请求超时（项目模式进程共用；UT 覆盖映射矩阵）。 */
function ompCommandTimeoutMs(command: { type?: unknown }): number {
  return typeof command.type === "string" && USER_INPUT_COMMAND_TYPES.has(command.type) ? USER_INPUT_COMMAND_TIMEOUT_MS : COMMAND_TIMEOUT_MS;
}

interface PendingCommand {
  resolve: (outcome: OmpCommandOutcome) => void;
  reject: (error: Error) => void;
  timer: NodeJS.Timeout;
  diagnostic: OmpRpcDiagnostic;
}

export function createOmpProcessFactory(binaryPath: string, extraArgs: string[] = [], env: NodeJS.ProcessEnv = process.env): OmpProcessFactory {
  return {
    create(options) {
      return new OmpChildProcess(binaryPath, extraArgs, options, env);
    },
  };
}

class OmpChildProcess implements OmpSessionProcess {
  ompSessionFile: string | null = null;
  subagentSubscriptionAvailable: boolean | undefined;
  forkSurface: boolean | undefined;
  private child: ChildProcessWithoutNullStreams | null = null;
  private assembler = new OmpFrameAssembler();
  private pending = new Map<string, PendingCommand>();
  private readonly promptResults = new PromptResultTracker();
  private commandCounter = 0;
  private started = false;
  private disposed = false;
  private exitListener: ((code: number | null) => void) | null = null;
  private stateData: OmpStateData | null = null;
  private contextRead: Promise<OmpContextReport | null> | null = null;
  private contextOutput: string[] | null = null;
  private contextResult: { id: string; resolve: (local: boolean) => void } | null = null;
  private readonly coreInstanceId = randomUUID();
  private readonly creationContext = { ...logger.context() };
  private diagnosticSessionId: unknown = this.creationContext.sessionId;
  private peerPid: number | undefined;
  private spawnAt = 0;
  private readySeen = false;
  private startCompleted = false;
  private startStage = "spawn";
  constructor(
    private readonly binaryPath: string,
    private readonly extraArgs: string[],
    private readonly options: {
      cwd: string;
      resumeSessionPath?: string;
      /** 目录进程：--no-session（工作区级查询，无会话语义）。 */
      sessionless?: boolean;
      onEvent: (event: import("../domain/ompFrames.js").OmpSessionEventFrame) => void;
      onUiRequest: (request: OmpUiRequest) => void;
      onAskRequest?: (request: OmpAskRequest) => void;
      onExit: (code: number | null) => void;
    } & OmpSideChannelHandlers,
    private readonly env: NodeJS.ProcessEnv,
  ) {}

  async start(): Promise<void> {
    if (this.started) {
      return;
    }
    this.started = true;
    this.spawnAt = Date.now();
    this.diagnosticSessionId = logger.context().sessionId ?? this.creationContext.sessionId;
    return logger.run({ ...this.creationContext, ...logger.context(), ...this.coreFields() }, async () => {
      try {
        const args = [...this.extraArgs, "--mode", "rpc-ui", ...(this.options.sessionless ? ["--no-session"] : []), ...(this.options.resumeSessionPath ? ["--resume", this.options.resumeSessionPath] : [])];
        logger.info("omp_core_spawn_started", { event: "omp_core_spawn_started", cwd: this.options.cwd, resumePresent: Boolean(this.options.resumeSessionPath), sessionless: this.options.sessionless === true, elapsedMs: 0 });
        // 修复依据：目录与会话进程必须继承入口的同一环境；OMP_CONFIG_ROOT/OMP_OFFLINE 由 OMP 解析。
        const child = spawn(this.binaryPath, args, { cwd: this.options.cwd, env: this.env, stdio: ["pipe", "pipe", "pipe"], windowsHide: true }) as ChildProcessWithoutNullStreams;
        this.child = child;
        this.peerPid = child.pid;
        child.once("spawn", () => logger.info("omp_core_spawned", { ...this.coreFields(), event: "omp_core_spawned", elapsedMs: Date.now() - this.spawnAt }));
        this.exitListener = (code) => this.handleExit(code);
        child.once("exit", (code, signal) => {
          logOmpCoreExit(this.coreFields(), code, signal, this.disposed ? "dispose" : !this.readySeen ? "before_ready_exit" : this.startCompleted ? "runtime_exit" : "initialization_exit", this.disposed, this.spawnAt);
          this.exitListener?.(code);
        });
        // spawn error 不触发 exit；沿用原 handleExit 收口，不新增业务重试。
        child.once("error", (error) => {
          logger.error("omp_core_spawn_failed", { ...this.coreFields(), event: "omp_core_spawn_failed", stage: "spawn", error, elapsedMs: Date.now() - this.spawnAt });
          this.handleExit(null);
        });
        child.stderr.on("data", (chunk: Buffer) => {
          const text = chunk.toString("utf8").trim();
          if (text.length > 0) {
            logger.debug("omp_core_stderr_observed", { ...this.coreFields(), event: "omp_core_stderr_observed", stage: "stderr", lineLength: text.length });
          }
        });
        // 子进程死亡到 exit 事件之间的在途写会向 stdin emit error；无监听即 uncaught。
        child.stdin.on("error", (error) => {
          logger.warn("omp_core_stdin_failed", { ...this.coreFields(), event: "omp_core_stdin_failed", stage: "send", error });
        });
        // 同批 stdout 可能同时含 ready 与目录更新，持续读取器必须在 ready 等待前接线。
        this.wireStdout(child);
        this.startStage = "ready";
        await this.awaitReadyAndNegotiate(child);
        this.startStage = "subscription";
        const subscription = await this.request({ type: "set_subagent_subscription", level: "events" }, 10_000).catch((error) => ({ success: false, error: String(error) }));
        this.subagentSubscriptionAvailable = subscription.success;
        logOmpCoreSubscription(this.coreFields(), subscription.success, this.forkSurface, subscription.error, this.spawnAt);
        // 富 ask（extension_ui_request method:"ask" 携带完整问题集）需显式启用；旧核无该命令，
        // 失败只降级为逐题 select/editor（不阻塞会话进程启动）。
        if (!this.options.sessionless) {
          const askDialog = await this.request({ type: "set_ask_dialog", enabled: true }, 10_000).catch((error) => ({ success: false, error: String(error) }));
          if (!askDialog.success) {
            logger.warn("omp_core_ask_dialog_unavailable", { ...this.coreFields(), event: "omp_core_ask_dialog_unavailable", stage: "subscription", askDialogAvailable: false, error: askDialog.error ?? "unknown" });
          } else logger.info("omp_core_ask_dialog_completed", { ...this.coreFields(), event: "omp_core_ask_dialog_completed", stage: "subscription", askDialogAvailable: true });
        }
        this.startCompleted = Boolean(this.child && !this.child.killed && !this.disposed);
        const event = this.startCompleted ? "omp_core_start_completed" : "omp_core_start_failed";
        logger[this.startCompleted ? "info" : "error"](event, { ...this.coreFields(), event, success: this.startCompleted, stage: this.startCompleted ? "running" : "initialization_exit", elapsedMs: Date.now() - this.spawnAt });
      } catch (error) {
        logger.error("omp_core_start_failed", { ...this.coreFields(), event: "omp_core_start_failed", stage: this.startStage, error, elapsedMs: Date.now() - this.spawnAt });
        throw error;
      }
    });
  }
  private wireStdout(child: ChildProcessWithoutNullStreams): void {
    const readline = createInterface({ input: child.stdout });
    readline.on("line", (line) => logger.run({ requestId: undefined, commandId: undefined, inputId: undefined, traceId: undefined, ...this.coreFields() }, () => this.handleLine(line)));
  }

  /** ready 等待 + 协商；ready 通告的 v2 重组上限接线到分片重组器。 */
  private async awaitReadyAndNegotiate(child: ChildProcessWithoutNullStreams): Promise<void> {
    await awaitOmpReady(child, {
      request: (command) => this.request(command),
      onForkSurface: () => {
        this.forkSurface = true;
      },
      onReady: (ready) => {
        this.readySeen = true;
        this.startStage = "negotiate";
        logger.info("omp_core_ready", { ...this.coreFields(), event: "omp_core_ready", protocolVersion: ready.protocolVersion, supportedProtocolVersions: ready.supportedProtocolVersions, elapsedMs: Date.now() - this.spawnAt });
        const limit = ready.maxReassembledFrameBytes;
        if (typeof limit === "number" && limit > 0) this.assembler.updateMaxReassembledBytes(limit);
        child.stdout.resume();
      },
    });
  }

  private handleLine(line: string): void {
    const frame = parseJson(line);
    if (!frame || typeof frame !== "object") {
      logger.warn("omp_core_frame_decode_failed", { ...this.coreFields(), event: "omp_core_frame_decode_failed", stage: "json_decode", lineLength: line.length });
      return;
    }
    const record = frame as Record<string, unknown>;
    if (record.type === "rpc_chunk") {
      const chunk = ompRpcChunkFrameSchema.safeParse(record);
      if (!chunk.success) {
        logger.warn("omp_core_frame_decode_failed", { ...this.coreFields(), event: "omp_core_frame_decode_failed", stage: "chunk_decode", issueCount: chunk.error.issues.length });
        return;
      }
      const assembled = this.assembler.push(chunk.data);
      if (assembled.kind === "assembled") {
        this.dispatchFrame(assembled.frame);
      } else if (assembled.kind === "rejected") {
        logger.warn("omp_core_frame_decode_failed", { ...this.coreFields(), event: "omp_core_frame_decode_failed", stage: "chunk_assemble", reason: assembled.reason });
      }
      return;
    }
    this.dispatchFrame(record);
  }
  private dispatchFrame(frame: unknown): void {
    dispatchOmpFrame(frame, {
      promptResults: this.promptResults,
      getContextResult: () => this.contextResult,
      getContextOutput: () => this.contextOutput,
      onResponseDecodeFailure: (id, issueCount) => {
        const diagnostic = id ? this.pending.get(id)?.diagnostic : undefined;
        if (diagnostic) diagnostic.decodeFailed = true;
        logger.error("omp_core_response_decode_failed", { ...this.coreFields(), ...diagnostic?.fields, event: "omp_core_response_decode_failed", stage: "decode", issueCount, elapsedMs: diagnostic ? Date.now() - diagnostic.startedAt : undefined });
      },
      settleCommand: (id, success, data) => this.settleCommand(id, success, data),
      options: this.options,
      respondUi: (response) => this.respondUi(response),
    });
  }
  async send(command: OmpCommandFrame): Promise<OmpCommandOutcome> {
    // /context 是本地 prompt 且 command_output 没有 request id；先收口再下发其它命令。
    if (this.contextRead) await this.contextRead;
    if (command.type === "get_state") {
      // get_state 同步命令在 omp 内部可能较慢（模型注册后台刷新），放宽超时。
      return this.request(command, 10_000);
    }
    return this.request(command);
  }

  readContextReport(): Promise<OmpContextReport | null> {
    if (this.contextRead) return this.contextRead;
    const output: string[] = [];
    this.contextOutput = output;
    const work = (async () => {
      let timer: NodeJS.Timeout | undefined;
      try {
        let resolveLocal!: (local: boolean) => void;
        const localResult = new Promise<boolean>((resolve) => {
          resolveLocal = resolve;
        });
        const response = this.request({ type: "prompt", message: "/context" }, 5_000);
        this.contextResult = { id: `omp-req-${this.commandCounter}`, resolve: resolveLocal };
        timer = setTimeout(() => resolveLocal(false), 5_000);
        timer.unref?.();
        const outcome = await response;
        if (!outcome.success || (outcome.data as { agentInvoked?: boolean } | undefined)?.agentInvoked === true) return null;
        if ((outcome.data as { agentInvoked?: boolean } | undefined)?.agentInvoked !== false && !(await localResult)) return null;
        const report = parseOmpContextReport(output.join("\n"));
        if (!report) logger.warn("omp_core_context_decode_failed", { ...this.coreFields(), event: "omp_core_context_decode_failed", stage: "context_decode", outputLineCount: output.length });
        return report;
      } catch (error) {
        logger.warn("omp_core_context_read_failed", { ...this.coreFields(), event: "omp_core_context_read_failed", stage: "context_read", error });
        return null;
      } finally {
        if (timer) clearTimeout(timer);
        this.contextOutput = null;
        this.contextResult = null;
        this.contextRead = null;
      }
    })();
    this.contextRead = work;
    return work;
  }

  private request(command: OmpCommandFrame, timeoutMs = ompCommandTimeoutMs(command)): Promise<OmpCommandOutcome> {
    const child = this.child;
    const commandType = command.type;
    const diagnostic = startOmpRpc(this.coreFields(), commandType, timeoutMs, child && !child.killed ? `omp-req-${this.commandCounter + 1}` : null);
    if (!child || child.killed) {
      finishOmpRpc(diagnostic, false, "not_running", { error: "omp core is not running" });
      return Promise.resolve({ success: false, error: "omp core is not running" });
    }
    this.commandCounter += 1;
    const id = `omp-req-${this.commandCounter}`;
    const payload = { id, ...command };
    return new Promise<OmpCommandOutcome>((resolve, reject) => {
      const timer = setTimeout(() => {
        this.pending.delete(id);
        const error = new Error(`omp command timeout: ${command.type}`);
        finishOmpRpc(diagnostic, false, diagnostic.decodeFailed ? "decode" : "timeout", { terminalStage: "timeout", error });
        reject(error);
      }, timeoutMs);
      timer.unref?.();
      this.pending.set(id, { resolve, reject, timer, diagnostic });
      try {
        child.stdin.write(encodeJsonlLine(payload), (error) => {
          if (error) {
            finishOmpRpc(diagnostic, false, "send", { error });
            this.pending.delete(id);
            clearTimeout(timer);
            reject(error);
          }
        });
      } catch (error) {
        finishOmpRpc(diagnostic, false, "send", { error });
        throw error;
      }
    });
  }

  private settleCommand(id: string, success: boolean, data: { data?: unknown; error?: string; code?: unknown }): void {
    const pending = this.pending.get(id);
    if (!pending) {
      return;
    }
    this.pending.delete(id);
    clearTimeout(pending.timer);
    finishOmpRpcResponse(pending.diagnostic, success, data);
    // 修复（B5）：omp 响应帧的错误码（code）透传给调用方（对齐项目模式 ompProjectProcess 的 G4 修复），供宿主 UI 归因具体失败类别。
    pending.resolve({ success, data: data.data, error: data.error, ...(typeof data.code === "string" ? { code: data.code } : {}) });
  }
  private coreFields(): Record<string, unknown> {
    return ompCoreFields(this.diagnosticSessionId, this.coreInstanceId, this.peerPid, this.options, this.binaryPath, this.extraArgs.length);
  }
  respondUi(response: OmpBypassFrame): void {
    const child = this.child;
    if (!child || child.killed || !child.stdin.writable) return;
    child.stdin.write(encodeJsonlLine(response), (error) => {
      if (error) logger.warn("omp_core_ui_response_failed", { ...this.coreFields(), event: "omp_core_ui_response_failed", stage: "send", error });
    });
  }
  async refreshState(): Promise<OmpStateData | null> {
    const startedAt = Date.now();
    const response = this.request({ type: "get_state" }, 10_000).catch(() => null);
    const requestContext = { ...this.coreFields(), ...logger.context(), coreInstanceId: this.coreInstanceId, peerPid: this.peerPid, ompRequestId: `omp-req-${this.commandCounter}` };
    const outcome = await response;
    if (!outcome?.success) {
      return null;
    }
    const parsed = ompStateDataSchema.safeParse(outcome.data);
    if (!parsed.success) {
      logger.error("omp_core_state_decode_failed", { ...requestContext, event: "omp_core_state_decode_failed", stage: "state_decode", issueCount: parsed.error.issues.length, elapsedMs: Date.now() - startedAt });
      return null;
    }
    this.stateData = parsed.data;
    if (parsed.data.sessionFile) {
      this.ompSessionFile = parsed.data.sessionFile;
    }
    return parsed.data;
  }
  get state(): OmpStateData | null {
    return this.stateData;
  }
  private handleExit(code: number | null): void {
    if (this.disposed) {
      return;
    }
    this.child = null;
    for (const pending of this.pending.values()) {
      clearTimeout(pending.timer);
      const error = new Error(`omp core exited (code ${code ?? "null"})`);
      finishOmpRpc(pending.diagnostic, false, "exit", { code, error });
      pending.reject(error);
    }
    this.pending.clear();
    this.promptResults.clear();
    this.options.onExit(code);
  }
  async dispose(): Promise<void> {
    // 正常 EOF 关闭也必须结算在途请求；disposed 会阻止 handleExit 的意外退出路径。
    const disposeAt = Date.now();
    logger.info("omp_core_dispose_started", { ...this.coreFields(), event: "omp_core_dispose_started", pendingCount: this.pending.size, elapsedMs: 0 });
    for (const pending of this.pending.values()) {
      clearTimeout(pending.timer);
      const error = new Error("omp core disposed");
      finishOmpRpc(pending.diagnostic, false, "dispose", { error });
      pending.reject(error);
    }
    this.pending.clear();
    this.promptResults.clear();
    this.disposed = true;
    const child = this.child;
    if (!child) {
      logger.info("omp_core_dispose_completed", { ...this.coreFields(), event: "omp_core_dispose_completed", elapsedMs: Date.now() - disposeAt });
      return;
    }
    this.child = null;
    await new Promise<void>((resolve) => {
      const timer = setTimeout(() => {
        logger.warn("omp_core_dispose_forced", { ...this.coreFields(), event: "omp_core_dispose_forced", stage: "dispose_timeout", forced: true, elapsedMs: Date.now() - disposeAt });
        child.kill("SIGKILL");
        resolve();
      }, 3000);
      timer.unref?.();
      child.once("exit", () => {
        clearTimeout(timer);
        resolve();
      });
      // stdin EOF 是 omp 的正常关闭信号（drain 后 exit 0）。
      child.stdin.end();
    });
    logger.info("omp_core_dispose_completed", { ...this.coreFields(), event: "omp_core_dispose_completed", elapsedMs: Date.now() - disposeAt });
  }
}

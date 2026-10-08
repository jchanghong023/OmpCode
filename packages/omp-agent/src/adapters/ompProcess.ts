// omp 子进程适配器：spawn 内嵌 omp 二进制（--mode rpc-ui），讲 omp RPC-UI。
// 负责 ready、协议协商（v2 分片重组）、命令关联与事件/扩展 UI 分发。

import { spawn, type ChildProcessWithoutNullStreams } from "node:child_process";
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

const COMMAND_TIMEOUT_MS = 120_000;

// 修复（A8）：用户输入类命令（prompt/steer/follow_up/abort_and_prompt）的响应在 omp 输入门 admission 前有意挂起，可跨分钟
// （图像规范化/视觉描述、rpc-fork-permission 权限门 await 无超时）；固定 120s 会误判在途 prompt 失败，放宽到 10 分钟，
// 进程死亡由 handleExit 的 pending 结算兜底，超时不承担存活探测职责。
const USER_INPUT_COMMAND_TIMEOUT_MS = 600_000;
const USER_INPUT_COMMAND_TYPES: ReadonlySet<string> = new Set(["prompt", "steer", "follow_up", "abort_and_prompt"]);

/** 按命令类型选择请求超时（项目模式进程共用；UT 覆盖映射矩阵）。 */
export function ompCommandTimeoutMs(command: { type?: unknown }): number {
  return typeof command.type === "string" && USER_INPUT_COMMAND_TYPES.has(command.type) ? USER_INPUT_COMMAND_TIMEOUT_MS : COMMAND_TIMEOUT_MS;
}

interface PendingCommand {
  resolve: (outcome: OmpCommandOutcome) => void;
  reject: (error: Error) => void;
  timer: NodeJS.Timeout;
}

export function createOmpProcessFactory(binaryPath: string, extraArgs: string[] = []): OmpProcessFactory {
  return {
    create(options) {
      return new OmpChildProcess(binaryPath, extraArgs, options);
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
  ) {}

  async start(): Promise<void> {
    if (this.started) {
      return;
    }
    this.started = true;
    const args = [...this.extraArgs, "--mode", "rpc-ui", ...(this.options.sessionless ? ["--no-session"] : []), ...(this.options.resumeSessionPath ? ["--resume", this.options.resumeSessionPath] : [])];
    logger.info("spawn omp core", { binary: this.binaryPath, cwd: this.options.cwd, resume: this.options.resumeSessionPath ?? null, sessionless: this.options.sessionless === true });
    const child = spawn(this.binaryPath, args, { cwd: this.options.cwd, stdio: ["pipe", "pipe", "pipe"], windowsHide: true }) as ChildProcessWithoutNullStreams;
    this.child = child;
    this.exitListener = (code) => this.handleExit(code);
    child.once("exit", this.exitListener);
    // spawn 失败（如二进制缺失/不可执行）不触发 exit，未监听的 'error' 会以 uncaught exception 打崩宿主；收口到 handleExit(null)，与下方 stdin 兜底同源。
    child.once("error", (error) => {
      logger.debug("omp spawn error", { error: String(error) });
      this.handleExit(null);
    });
    child.stderr.on("data", (chunk: Buffer) => {
      const text = chunk.toString("utf8").trim();
      if (text.length > 0) {
        logger.debug("omp stderr", { text: text.slice(0, 2000) });
      }
    });
    // 子进程死亡到 exit 事件之间的在途写会向 stdin emit error；无监听即 uncaught。
    child.stdin.on("error", (error) => {
      logger.debug("omp stdin write failed", { error: String(error) });
    });
    // 同批 stdout 可能同时含 ready 与目录更新，持续读取器必须在 ready 等待前接线。
    this.wireStdout(child);
    await this.awaitReadyAndNegotiate(child);
    const subscription = await this.request({ type: "set_subagent_subscription", level: "events" }, 10_000).catch((error) => ({ success: false, error: String(error) }));
    this.subagentSubscriptionAvailable = subscription.success;
    if (!subscription.success) {
      logger.warn("omp 子代理订阅不可用", { error: subscription.error ?? "unknown" });
    }
    // 富 ask（extension_ui_request method:"ask" 携带完整问题集）需显式启用；旧核无该命令，
    // 失败只降级为逐题 select/editor（不阻塞会话进程启动）。
    if (!this.options.sessionless) {
      const askDialog = await this.request({ type: "set_ask_dialog", enabled: true }, 10_000).catch((error) => ({ success: false, error: String(error) }));
      if (!askDialog.success) {
        logger.info("omp 富 ask 对话框不可用，回落逐题询问", { error: askDialog.error ?? "unknown" });
      }
    }
  }
  private wireStdout(child: ChildProcessWithoutNullStreams): void {
    const readline = createInterface({ input: child.stdout });
    readline.on("line", (line) => this.handleLine(line));
  }

  /** ready 等待 + 协商；ready 通告的 v2 重组上限接线到分片重组器。 */
  private async awaitReadyAndNegotiate(child: ChildProcessWithoutNullStreams): Promise<void> {
    await awaitOmpReady(child, {
      request: (command) => this.request(command),
      onForkSurface: () => {
        this.forkSurface = true;
      },
      onReady: (ready) => {
        const limit = ready.maxReassembledFrameBytes;
        if (typeof limit === "number" && limit > 0) this.assembler.updateMaxReassembledBytes(limit);
        child.stdout.resume();
      },
    });
  }

  private handleLine(line: string): void {
    const frame = parseJson(line);
    if (!frame || typeof frame !== "object") {
      return;
    }
    const record = frame as Record<string, unknown>;
    if (record.type === "rpc_chunk") {
      const chunk = ompRpcChunkFrameSchema.safeParse(record);
      if (!chunk.success) {
        logger.warn("invalid rpc_chunk", { issues: chunk.error.issues.length });
        return;
      }
      const assembled = this.assembler.push(chunk.data);
      if (assembled.kind === "assembled") {
        this.dispatchFrame(assembled.frame);
      } else if (assembled.kind === "rejected") {
        logger.warn("rpc_chunk sequence rejected", { reason: assembled.reason });
      }
      return;
    }
    this.dispatchFrame(record);
  }
  private dispatchFrame(frame: unknown): void {
    dispatchOmpFrame(frame, { promptResults: this.promptResults, getContextResult: () => this.contextResult, getContextOutput: () => this.contextOutput, settleCommand: (id, success, data) => this.settleCommand(id, success, data), options: this.options, respondUi: (response) => this.respondUi(response) });
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
        return parseOmpContextReport(output.join("\n"));
      } catch {
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
    if (!child || child.killed) {
      return Promise.resolve({ success: false, error: "omp core is not running" });
    }
    this.commandCounter += 1;
    const id = `omp-req-${this.commandCounter}`;
    const payload = { id, ...command };
    return new Promise<OmpCommandOutcome>((resolve, reject) => {
      const timer = setTimeout(() => {
        this.pending.delete(id);
        reject(new Error(`omp command timeout: ${command.type}`));
      }, timeoutMs);
      timer.unref?.();
      this.pending.set(id, { resolve, reject, timer });
      child.stdin.write(encodeJsonlLine(payload), (error) => {
        if (error) {
          this.pending.delete(id);
          clearTimeout(timer);
          reject(error);
        }
      });
    });
  }

  private settleCommand(id: string, success: boolean, data: { data?: unknown; error?: string; code?: unknown }): void {
    const pending = this.pending.get(id);
    if (!pending) {
      return;
    }
    this.pending.delete(id);
    clearTimeout(pending.timer);
    // 修复（B5）：omp 响应帧的错误码（code）透传给调用方（对齐项目模式 ompProjectProcess 的 G4 修复），供宿主 UI 归因具体失败类别。
    pending.resolve({ success, data: data.data, error: data.error, ...(typeof data.code === "string" ? { code: data.code } : {}) });
  }
  respondUi(response: OmpBypassFrame): void {
    const child = this.child;
    if (!child || child.killed || !child.stdin.writable) return;
    child.stdin.write(encodeJsonlLine(response), (error) => {
      if (error) logger.warn("omp UI 应答写入失败", { error: String(error) });
    });
  }
  async refreshState(): Promise<OmpStateData | null> {
    const outcome = await this.request({ type: "get_state" }, 10_000).catch(() => null);
    if (!outcome?.success) {
      return null;
    }
    const parsed = ompStateDataSchema.safeParse(outcome.data);
    if (!parsed.success) {
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
      pending.reject(new Error(`omp core exited (code ${code ?? "null"})`));
    }
    this.pending.clear();
    this.promptResults.clear();
    this.options.onExit(code);
  }
  async dispose(): Promise<void> {
    // 正常 EOF 关闭也必须结算在途请求；disposed 会阻止 handleExit 的意外退出路径。
    for (const pending of this.pending.values()) {
      clearTimeout(pending.timer);
      pending.reject(new Error("omp core disposed"));
    }
    this.pending.clear();
    this.promptResults.clear();
    this.disposed = true;
    const child = this.child;
    if (!child) {
      return;
    }
    this.child = null;
    await new Promise<void>((resolve) => {
      const timer = setTimeout(() => {
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
  }
}

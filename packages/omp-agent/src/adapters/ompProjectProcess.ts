// OMP 项目进程宿主（rpc-ui-protocol.md §4/§13）：一个 workspace 一个 omp 项目进程，
// `--mode rpc-ui --rpc-project`，承载全部会话。本文件只负责进程 IO、ready/协商、
// 请求关联与按 sessionId 的帧路由；会话级命令包装与侧信道在 ompProjectChannel。
//
// 回落约定：ready 未声明 mode:"rpc-ui-project"（旧版内嵌 omp）时 start() 返回 null，
// 调用方整体回落「每会话一进程」拓扑，不混用。

import { spawn, type ChildProcessWithoutNullStreams } from "node:child_process";
import { createInterface } from "node:readline";
import { OmpFrameAssembler } from "../domain/frameAssembler.js";
import { ompRpcChunkFrameSchema } from "../domain/ompFrames.js";
import { ompProjectReadyInfoSchema, type OmpProjectCommand } from "../domain/ompProjectFrames.js";
import { encodeJsonlLine } from "../domain/jsonlFraming.js";
import { parseJson } from "./jsonl.js";
import { logger } from "./logger.js";
import type { OmpCommandOutcome } from "../app/ports.js";

const COMMAND_TIMEOUT_MS = 120_000;
const READY_TIMEOUT_MS = 60_000;

interface PendingCommand {
  resolve: (outcome: OmpCommandOutcome) => void;
  timer: NodeJS.Timeout;
}

/** 会话通道在进程宿主上的最小形状（实现见 ompProjectChannel.ts，避免双向运行时依赖）。 */
export interface OmpProjectChannelLike {
  handleFrame(record: Record<string, unknown>): void;
  notifyExit(code: number | null): void;
}

/** 进程级事件出口（目录类变化与进程退出）。 */
export interface OmpProjectProcessHooks {
  onSessionsChanged?: () => void;
  onSkillsChanged?: (scope: string | undefined) => void;
  onCatalogChanged?: () => void;
  onExit: (code: number | null) => void;
}

export class OmpProjectProcess {
  private child: ChildProcessWithoutNullStreams | null = null;
  private assembler = new OmpFrameAssembler();
  private pending = new Map<string, PendingCommand>();
  /** 会话命令发送记录（命令 id→sessionId）：真实 omp 的 response 不带 sessionId 戳，
   * dispatchFrame 据此把 response 路由回会话通道；请求结束（response/超时/退出）即清理。 */
  private readonly requestSessionById = new Map<string, string>();
  private commandCounter = 0;
  private readonly channels = new Map<string, OmpProjectChannelLike>();
  private readonly hooks: OmpProjectProcessHooks;
  private readonly binaryPath: string;
  private readonly extraArgs: string[];
  private readonly cwd: string;
  private disposed = false;
  private readonly instanceIdRef: { value: string | null } = { value: null };

  constructor(options: {
    binaryPath: string;
    extraArgs: string[];
    cwd: string;
    hooks: OmpProjectProcessHooks;
  }) {
    this.binaryPath = options.binaryPath;
    this.extraArgs = options.extraArgs;
    this.cwd = options.cwd;
    this.hooks = options.hooks;
  }

  get instanceId(): string | null {
    return this.instanceIdRef.value;
  }

  /** 启动并完成 ready/项目模式检查与 v3 协商；ready 无项目模式返回 false（进程已回收，
   * 调用方永久回落旧拓扑）；v3 协商失败抛错（调用方按可重试的启动失败处理）。 */
  async start(): Promise<boolean> {
    const args = [...this.extraArgs, "--mode", "rpc-ui", "--rpc-project"];
    logger.info("spawn omp project core", { binary: this.binaryPath, cwd: this.cwd });
    const child = spawn(this.binaryPath, args, {
      cwd: this.cwd,
      stdio: ["pipe", "pipe", "pipe"],
      windowsHide: true,
    }) as ChildProcessWithoutNullStreams;
    this.child = child;
    child.once("exit", (code) => this.handleExit(code));
    // 修复（G6）：omp 进程意外退出后继续写 stdin 会触发 EPIPE，若无人监听将以
    // uncaught 'error' 事件崩溃宿主。挂常驻 debug 监听兜底；真实失败仍由
    // exit 事件与 pending 命令失败路径上报，不在此扩大处理。
    child.stdin.on("error", (error) => {
      logger.debug("omp project stdin error", { error: String(error) });
    });
    child.stderr.on("data", (chunk: Buffer) => {
      const text = chunk.toString("utf8").trim();
      if (text.length > 0) logger.debug("omp project stderr", { text: text.slice(0, 2000) });
    });
    const ready = await this.awaitProjectReady(child);
    if (!ready) {
      await this.killChild();
      return false;
    }
    this.wireStdout(child);
    const negotiation = await this.request(
      { type: "negotiate_protocol", protocolVersion: 3 },
      10_000,
    ).catch((error) => ({ success: false, error: String(error) }) as OmpCommandOutcome);
    if (!negotiation.success) {
      // 协商失败不得与「ready 无项目模式」同路降级（那会让 gateway 永久 capability=false）：
      // 抛错让 gateway startProcess 的 catch 走 capability=null 可重试分支。
      logger.warn("omp 项目模式 v3 协商失败", { error: negotiation.error ?? "unknown" });
      await this.killChild();
      throw new Error(
        `omp project core negotiate_protocol failed: ${negotiation.error ?? "unknown"}`,
      );
    }
    logger.info("omp 项目模式就绪", { processInstanceId: this.instanceIdRef.value, cwd: this.cwd });
    return true;
  }

  /** 解析 ready 帧：仅项目模式（mode:"rpc-ui-project"）返回 true。 */
  private awaitProjectReady(child: ChildProcessWithoutNullStreams): Promise<boolean> {
    return new Promise<boolean>((resolve, reject) => {
      const timer = setTimeout(
        () => reject(new Error("omp project core ready timeout")),
        READY_TIMEOUT_MS,
      );
      const onLine = (line: string) => {
        const frame = parseJson(line);
        if (!frame || typeof frame !== "object" || (frame as { type?: unknown }).type !== "ready") {
          return;
        }
        const parsed = ompProjectReadyInfoSchema.safeParse(frame);
        if (!parsed.success) {
          // 非 v3 fork surface 的旧 omp：单会话模式，整体回落。
          clearTimeout(timer);
          readline.removeListener("line", onLine);
          resolve(false);
          return;
        }
        this.instanceIdRef.value = parsed.data.processInstanceId;
        clearTimeout(timer);
        readline.removeListener("line", onLine);
        resolve(true);
      };
      const readline = createInterface({ input: child.stdout });
      readline.on("line", onLine);
      readline.once("close", () => {
        clearTimeout(timer);
        reject(new Error("omp project core stdout closed before ready"));
      });
      child.once("exit", (code) => {
        clearTimeout(timer);
        reject(new Error(`omp project core exited before ready (code ${code ?? "null"})`));
      });
    });
  }

  private wireStdout(child: ChildProcessWithoutNullStreams): void {
    const readline = createInterface({ input: child.stdout });
    readline.on("line", (line) => this.handleLine(line));
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
        logger.warn("invalid project rpc_chunk", { issues: chunk.error.issues.length });
        return;
      }
      const assembled = this.assembler.push(chunk.data);
      if (assembled.kind === "assembled") {
        this.dispatchFrame(assembled.frame);
      } else if (assembled.kind === "rejected") {
        logger.warn("project rpc_chunk sequence rejected", { reason: assembled.reason });
      }
      return;
    }
    this.dispatchFrame(record);
  }

  /** 帧路由：response 关联请求；目录事件给 hooks；会话帧按 sessionId 给通道。 */
  dispatchFrame(frame: unknown): void {
    if (typeof frame !== "object" || frame === null) {
      return;
    }
    const record = frame as Record<string, unknown>;
    if (record.type === "response") {
      const id = typeof record.id === "string" ? record.id : null;
      if (id) {
        this.settleCommand(
          id,
          record.success === true,
          record as { data?: unknown; error?: string; code?: unknown },
        );
        // 真实 omp 的会话 response 不带 sessionId 戳：按发送记录（命令 id→sessionId）
        // 路由回会话通道，通道用它登记本地命令异步收口 tracker；转交后即清理映射。
        const sessionId = this.requestSessionById.get(id);
        if (sessionId !== undefined) {
          this.requestSessionById.delete(id);
          this.channels.get(sessionId)?.handleFrame(record);
        }
      }
      return;
    }
    switch (record.type) {
      case "sessions_changed":
        this.hooks.onSessionsChanged?.();
        return;
      case "skills_changed":
        this.hooks.onSkillsChanged?.(typeof record.scope === "string" ? record.scope : undefined);
        return;
      case "command_catalog_changed":
        this.hooks.onCatalogChanged?.();
        return;
      case "operation_result":
        return;
      case "extension_error":
      case "host_tool_call":
      case "host_tool_cancel":
      case "host_uri_request":
      case "host_uri_cancel":
      case "ready":
        return;
      default: {
        const sessionId = typeof record.sessionId === "string" ? record.sessionId : null;
        const channel = sessionId ? this.channels.get(sessionId) : undefined;
        if (channel) {
          channel.handleFrame(record);
        } else if (sessionId) {
          logger.debug("project frame for unattached session dropped", {
            sessionId,
            type: String(record.type),
          });
        }
        return;
      }
    }
  }

  /** 项目级命令（信封由本方法补 id）。 */
  async sendProject(command: OmpProjectCommand): Promise<OmpCommandOutcome> {
    return this.request(command);
  }

  /** 会话通道注册（帧路由按 sessionId 归属；通道对象由调用方构造）。 */
  attachSession(sessionId: string, channel: OmpProjectChannelLike): void {
    this.channels.set(sessionId, channel);
  }

  detachSession(sessionId: string): void {
    this.channels.delete(sessionId);
  }

  /** 通道发送会话级命令：补 sessionId 后走同一关联管线，并记录 id→sessionId 供 response 路由。 */
  sendSessionCommand(
    sessionId: string,
    command: Record<string, unknown>,
    timeoutMs = COMMAND_TIMEOUT_MS,
  ): Promise<OmpCommandOutcome> {
    // 显式确定命令 id（request 复用已有 id）：先记发送记录再发送，避免 response 早到无主。
    const id =
      typeof command.id === "string" && command.id.length > 0
        ? command.id
        : this.reserveRequestId();
    this.requestSessionById.set(id, sessionId);
    const payload = { ...command, sessionId, id } as Record<string, unknown>;
    return this.request(payload as OmpProjectCommand & Record<string, unknown>, timeoutMs);
  }

  /** 预留请求 id（contextRead 等需要先记 id 再发帧的侧信道）。 */
  reserveRequestId(): string {
    this.commandCounter += 1;
    return `omp-req-${this.commandCounter}`;
  }

  request(
    command: Record<string, unknown>,
    timeoutMs = COMMAND_TIMEOUT_MS,
  ): Promise<OmpCommandOutcome> {
    const child = this.child;
    if (!child || child.killed) {
      return Promise.resolve({ success: false, error: "omp project core is not running" });
    }
    const id = typeof command.id === "string" ? command.id : this.reserveRequestId();
    const payload = { id, ...command };
    return new Promise<OmpCommandOutcome>((resolve, reject) => {
      const timer = setTimeout(() => {
        this.pending.delete(id);
        // 超时即请求结束：同步清理会话发送记录，避免映射泄漏。
        this.requestSessionById.delete(id);
        reject(new Error(`omp command timeout: ${String(command.type)}`));
      }, timeoutMs);
      timer.unref?.();
      this.pending.set(id, { resolve, timer });
      child.stdin.write(encodeJsonlLine(payload), (error) => {
        if (error) {
          this.pending.delete(id);
          this.requestSessionById.delete(id);
          clearTimeout(timer);
          reject(error);
        }
      });
    });
  }

  respondUi(response: unknown): void {
    const child = this.child;
    if (!child || child.killed || !child.stdin.writable) return;
    child.stdin.write(encodeJsonlLine(response), (error) => {
      if (error) logger.warn("omp 项目模式 UI 应答写入失败", { error: String(error) });
    });
  }

  get running(): boolean {
    return this.child !== null && !this.disposed;
  }

  private settleCommand(
    id: string,
    success: boolean,
    data: { data?: unknown; error?: string; code?: unknown },
  ): void {
    const pending = this.pending.get(id);
    if (!pending) {
      return;
    }
    this.pending.delete(id);
    clearTimeout(pending.timer);
    // 修复（G4）：omp 响应帧的错误码（code）透传给调用方，供宿主 UI 归因具体失败类别。
    pending.resolve({
      success,
      data: data.data,
      error: data.error,
      ...(typeof data.code === "string" ? { code: data.code } : {}),
    });
  }

  private handleExit(code: number | null): void {
    if (this.disposed) {
      return;
    }
    this.child = null;
    for (const pending of this.pending.values()) {
      clearTimeout(pending.timer);
      pending.resolve({
        success: false,
        error: `omp project core exited (code ${code ?? "null"})`,
      });
    }
    this.pending.clear();
    this.requestSessionById.clear();
    const channels = [...this.channels.values()];
    this.channels.clear();
    for (const channel of channels) channel.notifyExit(code);
    this.hooks.onExit(code);
  }

  private async killChild(): Promise<void> {
    const child = this.child;
    if (!child) return;
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
      child.stdin.end();
    });
  }

  /** stdin EOF 是 omp 的有序关闭信号：会话持久化后进程退出。 */
  async dispose(): Promise<void> {
    this.disposed = true;
    await this.killChild();
  }
}

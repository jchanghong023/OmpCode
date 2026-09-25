// omp 子进程适配器：spawn 内嵌 omp 二进制（--mode rpc-ui），讲 omp RPC-UI。
// 负责 ready、协议协商（v2 分片重组）、命令关联与事件/扩展 UI 分发。

import { spawn, type ChildProcessWithoutNullStreams } from "node:child_process";
import { createInterface } from "node:readline";
import { OmpFrameAssembler } from "../domain/frameAssembler.js";
import { parseOmpContextReport, type OmpContextReport } from "../domain/ompContextReport.js";
import {
  ompAvailableCommandsFrameSchema, ompCommandOutputFrameSchema, ompConfigUpdateFrameSchema,
  ompExtensionUiRequestFrameSchema, ompPromptResultFrameSchema, ompReadyFrameSchema,
  ompResponseFrameSchema, ompRpcChunkFrameSchema, ompSessionEventFrameSchema,
  ompSessionInfoUpdateFrameSchema, ompStateDataSchema, ompSubagentFrameSchema,
  type OmpCommandFrame,
  type OmpExtensionUiResponseFrame,
} from "../domain/ompFrames.js";
import { encodeJsonlLine } from "../domain/jsonlFraming.js";
import type { OmpCommandOutcome, OmpProcessFactory, OmpSessionProcess, OmpStateData, OmpUiRequest } from "../app/ports.js";
import type { OmpSideChannelHandlers } from "../app/ports.js";
import { logger } from "./logger.js";

const READY_TIMEOUT_MS = 60_000;
const COMMAND_TIMEOUT_MS = 120_000;

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
  private child: ChildProcessWithoutNullStreams | null = null;
  private assembler = new OmpFrameAssembler();
  private pending = new Map<string, PendingCommand>();
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
      onEvent: (event: import("../domain/ompFrames.js").OmpSessionEventFrame) => void;
      onUiRequest: (request: OmpUiRequest) => void;
      onExit: (code: number | null) => void;
    } & OmpSideChannelHandlers,
  ) {}

  async start(): Promise<void> {
    if (this.started) {
      return;
    }
    this.started = true;
    const args = [
      ...this.extraArgs,
      "--mode",
      "rpc-ui",
      ...(this.options.resumeSessionPath ? ["--resume", this.options.resumeSessionPath] : []),
    ];
    logger.info("spawn omp core", { binary: this.binaryPath, cwd: this.options.cwd, resume: this.options.resumeSessionPath ?? null });
    const child = spawn(this.binaryPath, args, {
      cwd: this.options.cwd,
      stdio: ["pipe", "pipe", "pipe"],
      windowsHide: true,
    }) as ChildProcessWithoutNullStreams;
    this.child = child;
    this.exitListener = (code) => this.handleExit(code);
    child.once("exit", this.exitListener);
    child.stderr.on("data", (chunk: Buffer) => {
      const text = chunk.toString("utf8").trim();
      if (text.length > 0) {
        logger.debug("omp stderr", { text: text.slice(0, 2000) });
      }
    });
    const ready = new Promise<void>((resolve, reject) => {
      const timer = setTimeout(() => reject(new Error("omp core ready timeout")), READY_TIMEOUT_MS);
      const onLine = (line: string) => {
        const frame = parseJson(line);
        if (!frame || typeof frame !== "object") {
          return;
        }
        const readyParsed = ompReadyFrameSchema.safeParse(frame);
        if (readyParsed.success) {
          clearTimeout(timer);
          if (readyParsed.data.supportedProtocolVersions?.includes(2)) {
            this.request({ type: "negotiate_protocol", protocolVersion: 2 }).catch((error) => {
              logger.warn("omp v2 协商失败，回落 v1", { error: String(error) });
            });
          }
          readline.removeListener("line", onLine);
          resolve();
        }
      };
      const readline = createInterface({ input: child.stdout });
      readline.on("line", onLine);
      readline.once("close", () => {
        clearTimeout(timer);
        reject(new Error("omp core stdout closed before ready"));
      });
      child.once("exit", (code) => {
        clearTimeout(timer);
        reject(new Error(`omp core exited before ready (code ${code ?? "null"})`));
      });
    });
    await ready;
    this.wireStdout(child);
    const subscription = await this.request({ type: "set_subagent_subscription", level: "events" }, 10_000).catch((error) => ({ success: false, error: String(error) }));
    this.subagentSubscriptionAvailable = subscription.success;
    if (!subscription.success) {
      logger.warn("omp 子代理订阅不可用", { error: subscription.error ?? "unknown" });
    }
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
    if (typeof frame !== "object" || frame === null) {
      return;
    }
    const record = frame as Record<string, unknown>;
    switch (record.type) {
      case "response": {
        const parsed = ompResponseFrameSchema.safeParse(record);
        if (!parsed.success) {
          return;
        }
        if (parsed.data.id) {
          this.settleCommand(parsed.data.id, parsed.data.success, parsed.data);
        }
        return;
      }
      case "prompt_result": {
        const parsed = ompPromptResultFrameSchema.safeParse(record);
        if (parsed.success) {
          if (parsed.data.id && parsed.data.id === this.contextResult?.id) {
            this.contextResult.resolve(parsed.data.agentInvoked === false);
            return;
          }
          this.options.onPromptResult?.(parsed.data);
        }
        return;
      }
      case "available_commands_update": {
        const parsed = ompAvailableCommandsFrameSchema.safeParse(record);
        if (parsed.success) {
          this.options.onCommandsUpdate?.(parsed.data.commands);
        } else {
          logger.warn("invalid available_commands_update", { issues: parsed.error.issues.length });
        }
        return;
      }
      case "command_output": {
        const parsed = ompCommandOutputFrameSchema.safeParse(record);
        if (parsed.success) {
          if (this.contextOutput) {
            this.contextOutput.push(parsed.data.text);
            return;
          }
          this.options.onCommandOutput?.({ text: parsed.data.text });
        }
        return;
      }
      case "session_info_update": {
        const parsed = ompSessionInfoUpdateFrameSchema.safeParse(record);
        if (parsed.success) {
          this.options.onSessionInfoUpdate?.(parsed.data);
        }
        return;
      }
      case "config_update": {
        const parsed = ompConfigUpdateFrameSchema.safeParse(record);
        if (parsed.success) {
          this.options.onConfigUpdate?.(parsed.data);
        }
        return;
      }
      case "extension_error":
      case "host_tool_call":
      case "host_tool_cancel":
      case "host_uri_request":
      case "host_uri_cancel":
      case "ready":
        return;
      case "subagent_lifecycle":
      case "subagent_progress":
      case "subagent_event": {
        const parsed = ompSubagentFrameSchema.safeParse(record);
        if (parsed.success) this.options.onSubagentFrame?.(parsed.data);
        else logger.warn("invalid omp subagent frame", { issues: parsed.error.issues.length });
        return;
      }
      case "extension_ui_request": {
        const parsed = ompExtensionUiRequestFrameSchema.safeParse(record);
        if (!parsed.success) {
          logger.warn("invalid extension_ui_request", { issues: parsed.error.issues.length });
          return;
        }
        this.options.onUiRequest({ frame: parsed.data, respond: (response) => this.respondUi(response) });
        return;
      }
      default: {
        const parsed = ompSessionEventFrameSchema.safeParse(record);
        if (parsed.success) {
          this.options.onEvent(parsed.data);
        }
        return;
      }
    }
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
        const localResult = new Promise<boolean>((resolve) => { resolveLocal = resolve; });
        const response = this.request({ type: "prompt", message: "/context" }, 5_000);
        this.contextResult = { id: `omp-req-${this.commandCounter}`, resolve: resolveLocal };
        timer = setTimeout(() => resolveLocal(false), 5_000);
        timer.unref?.();
        const outcome = await response;
        if (!outcome.success || (outcome.data as { agentInvoked?: boolean } | undefined)?.agentInvoked === true) return null;
        if ((outcome.data as { agentInvoked?: boolean } | undefined)?.agentInvoked !== false && !await localResult) return null;
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

  private request(command: OmpCommandFrame, timeoutMs = COMMAND_TIMEOUT_MS): Promise<OmpCommandOutcome> {
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

  private settleCommand(id: string, success: boolean, data: { data?: unknown; error?: string }): void {
    const pending = this.pending.get(id);
    if (!pending) {
      return;
    }
    this.pending.delete(id);
    clearTimeout(pending.timer);
    pending.resolve({ success, data: data.data, error: data.error });
  }

  respondUi(response: OmpExtensionUiResponseFrame): void {
    this.child?.stdin.write(encodeJsonlLine(response));
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
    for (const pending of this.pending.values()) {
      clearTimeout(pending.timer);
      pending.reject(new Error(`omp core exited (code ${code ?? "null"})`));
    }
    this.pending.clear();
    this.options.onExit(code);
  }

  async dispose(): Promise<void> {
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

function parseJson(line: string): unknown {
  const trimmed = line.trim();
  if (trimmed.length === 0) {
    return null;
  }
  try {
    return JSON.parse(trimmed);
  } catch {
    return null;
  }
}

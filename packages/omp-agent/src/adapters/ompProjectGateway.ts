// OmpProjectGateway：OMP 项目进程生命周期的唯一所有者（懒启动、能力判定、崩溃重启、
// 会话通道缓存）。属适配层（直接编排 OmpProjectProcess 与会话通道）；app 层经 ports 的
// OmpProjectGatewayPort 消费。available === null 表示 omp 未提供项目模式（旧内嵌核），
// 调用方整体回落旧拓扑；进程意外退出后能力判定不变，下一次 ensure() 重启进程。

import {
  ompProjectSessionSummarySchema,
  type OmpProjectCommand,
  type OmpProjectSessionSummary,
} from "../domain/ompProjectFrames.js";
import type {
  OmpCommandOutcome,
  OmpSessionProcess,
  OmpSessionProcessHandlers,
} from "../app/ports.js";
import { OmpProjectProcess } from "./ompProjectProcess.js";
import { OmpProjectSessionChannel } from "./ompProjectChannel.js";
import { logger } from "./logger.js";

export interface OmpProjectGatewayDeps {
  binaryPath: string;
  extraArgs: string[];
  cwd: string;
  onSessionsChanged?: () => void;
  onCatalogChanged?: () => void;
  onExit?: (code: number | null) => void;
}

export class OmpProjectGateway {
  private process: OmpProjectProcess | null = null;
  private readonly channels = new Map<string, OmpProjectSessionChannel>();
  private starting: Promise<OmpProjectProcess | null> | null = null;
  /** null = 未判定；true/false = 首次启动后的能力事实（进程崩溃不改变）。 */
  private capability: boolean | null = null;
  private readonly deps: OmpProjectGatewayDeps;

  constructor(deps: OmpProjectGatewayDeps) {
    this.deps = deps;
  }

  /** 注入/更新进程级事件钩子（注册表在构造完成后回接）。 */
  setEventHooks(hooks: {
    onSessionsChanged?: () => void;
    onExit?: (code: number | null) => void;
  }): void {
    if (hooks.onSessionsChanged) this.deps.onSessionsChanged = hooks.onSessionsChanged;
    if (hooks.onExit) this.deps.onExit = hooks.onExit;
  }

  /** 懒启动并返回可用进程；无项目模式或启动失败返回 null（回落旧拓扑）。 */
  async ensure(): Promise<OmpProjectProcess | null> {
    if (this.capability === false) return null;
    if (this.process?.running) return this.process;
    if (this.starting) return this.starting;
    this.starting = this.startProcess().finally(() => {
      this.starting = null;
    });
    return this.starting;
  }

  private async startProcess(): Promise<OmpProjectProcess | null> {
    const attempt = new OmpProjectProcess({
      binaryPath: this.deps.binaryPath,
      extraArgs: this.deps.extraArgs,
      cwd: this.deps.cwd,
      hooks: {
        onSessionsChanged: this.deps.onSessionsChanged,
        onCatalogChanged: this.deps.onCatalogChanged,
        onExit: (code) => {
          if (this.process === attempt) this.process = null;
          this.channels.clear();
          this.deps.onExit?.(code);
        },
      },
    });
    try {
      const supported = await attempt.start();
      this.capability = supported;
      if (!supported) {
        logger.info("omp 未提供项目模式（ready 无 rpc-ui-project），回落每会话一进程");
        return null;
      }
      this.process = attempt;
      return attempt;
    } catch (error) {
      // 启动失败按能力缺失处理一次；不永久封死（下次 ensure 重新尝试拉起）。
      this.capability = null;
      logger.warn("omp 项目进程启动失败", {
        error: error instanceof Error ? error.message : String(error),
      });
      await attempt.dispose().catch(() => {});
      return null;
    }
  }

  /** 能力判定（app 层端口）：true = 项目模式可用。 */
  async available(): Promise<boolean> {
    return (await this.ensure()) !== null;
  }

  async sendProject(command: OmpProjectCommand): Promise<OmpCommandOutcome> {
    const process = await this.ensure();
    if (!process) return { success: false, error: "omp project mode unavailable" };
    return process.sendProject(command);
  }

  async createSession(params: { name?: string }): Promise<OmpProjectSessionSummary> {
    const outcome = await this.sendProject({ type: "create_session", ...params });
    return requireSummary(outcome, "create_session");
  }

  async resumeSession(sessionId: string): Promise<OmpProjectSessionSummary> {
    const outcome = await this.sendProject({ type: "resume_session", sessionId });
    return requireSummary(outcome, "resume_session");
  }

  async closeSession(sessionId: string): Promise<OmpCommandOutcome> {
    return this.sendProject({ type: "close_session", sessionId, cancelRunning: true });
  }

  async deleteSession(sessionId: string): Promise<OmpCommandOutcome> {
    return this.sendProject({ type: "delete_session", sessionId, cancelRunning: true });
  }

  async listSessions(
    params: { cursor?: string | number; limit?: number } = {},
  ): Promise<OmpCommandOutcome> {
    return this.sendProject({ type: "list_sessions", ...params });
  }

  /**
   * 会话通道获取（项目模式注册表入口）：确保进程存活、会话已加载（resume 幂等），
   * 并把引擎 handlers 绑定到按 sessionId 路由的通道；进程重启后返回新通道。
   */
  async acquireSessionChannel(
    sessionId: string,
    handlers: OmpSessionProcessHandlers,
  ): Promise<OmpSessionProcess> {
    const process = await this.ensure();
    if (!process) throw new Error("omp project mode unavailable");
    await this.resumeSession(sessionId);
    let channel = this.channels.get(sessionId);
    if (!channel || !channel.alive) {
      channel = new OmpProjectSessionChannel(process, sessionId, handlers);
      this.channels.set(sessionId, channel);
      process.attachSession(sessionId, channel);
    } else {
      channel.refreshHandlers(handlers);
    }
    return channel;
  }

  /** 进程退出：清空通道登记（各引擎已由通道 onExit 终结轮次）。 */
  clearChannels(): void {
    this.channels.clear();
  }

  async dispose(): Promise<void> {
    const process = this.process;
    this.process = null;
    this.channels.clear();
    await process?.dispose();
  }
}

function requireSummary(outcome: OmpCommandOutcome, command: string): OmpProjectSessionSummary {
  if (!outcome.success) {
    throw new Error(outcome.error ?? `${command} failed`);
  }
  const parsed = ompProjectSessionSummarySchema.safeParse(outcome.data);
  if (!parsed.success || !parsed.data.sessionId) {
    throw new Error(`${command} returned invalid session summary`);
  }
  return parsed.data;
}

// OmpDirectoryGateway：工作区常驻目录进程（`--mode rpc-ui --no-session`）的唯一所有者。
// 承载两类查询：v1 目录（模型/思考档位/命令目录，任何核可用）与 v3 fork 能力
// （complete_command 补全、模型角色、会话目录 list/rename/delete）。
// v3 能力三态：available = 进程存活且 forkSurface（协商 v3 成功）；unsupported = 旧核
// （v3 协商失败，进程期内不变，对应 -32601 永久能力缺失）；unavailable = 启动失败/退避
// 窗口（-32000 可重试）。进程意外退出后允许立即重建；启动失败 10s 退避。

import type { OmpCommandFrame } from "../domain/ompFrames.js";
import type { OmpDirectoryCommand } from "../domain/ompForkFrames.js";
import type {
  OmpCommandOutcome,
  OmpDirectoryAvailability,
  OmpProcessFactory,
  OmpSessionProcess,
} from "../app/ports.js";
import { logger } from "./logger.js";

export interface OmpDirectoryGatewayDeps {
  ompFactory: OmpProcessFactory;
  cwd: string;
  /** 命令目录变化推送（available_commands_update；目录进程常驻监听）；载荷为 omp 原始命令数组。 */
  onCommandsUpdate?: (commands: unknown) => void;
}

/** 未协商 v3 的 omp 对目录命令的拒绝文案（isNegotiableRpcProtocolVersion 门控）。 */
export function isUnknownCommand(error: string | undefined): boolean {
  return typeof error === "string" && /unknown command/i.test(error);
}

export class OmpDirectoryGateway {
  private process: OmpSessionProcess | null = null;
  private starting: Promise<OmpSessionProcess | null> | null = null;
  private generation = 0;
  /** v3 协商结果：null = 未判定（启动失败/退避，可重试）；false = 旧核（永久能力缺失）。 */
  private forkSurface: boolean | null = null;
  private disposed = false;
  private nextRetryAt = 0;
  private static readonly START_RETRY_BACKOFF_MS = 10_000;
  private readonly deps: OmpDirectoryGatewayDeps;

  constructor(deps: OmpDirectoryGatewayDeps) {
    this.deps = deps;
  }

  /** 懒启动并返回可用进程；启动失败/退避返回 null。 */
  async ensure(): Promise<OmpSessionProcess | null> {
    if (this.disposed) return null;
    if (this.process) return this.process;
    if (this.starting) return this.starting;
    if (Date.now() < this.nextRetryAt) return null;
    const starting = this.startProcess().finally(() => {
      // 旧代收尾只能释放自己的 flight，不能清除后来登记的新启动。
      if (this.starting === starting) this.starting = null;
    });
    this.starting = starting;
    return starting;
  }

  private async startProcess(): Promise<OmpSessionProcess | null> {
    const generation = ++this.generation;
    let exited = false;
    let signalExit!: () => void;
    const exit = new Promise<void>((resolve) => {
      signalExit = resolve;
    });
    const process = this.deps.ompFactory.create({
      cwd: this.deps.cwd,
      // 目录进程无会话语义：--no-session（上游旗标，open_session 之外的查询均可用）。
      sessionless: true,
      onEvent: () => {},
      onUiRequest: ({ respond, frame }) =>
        respond({ type: "extension_ui_response", id: frame.id, cancelled: true }),
      onExit: (code) => {
        // ready 后的协商/订阅仍属于启动：exit 必须先使本代失效，
        // 不能依赖尚未发布的 this.process 才识别已死亡的实例。
        exited = true;
        signalExit();
        if (this.generation !== generation || this.disposed) return;
        this.process = null;
        this.forkSurface = null;
        logger.warn("omp 目录进程已退出", { code });
      },
      onCommandsUpdate: (commands) => {
        if (!exited && !this.disposed && this.generation === generation) {
          this.deps.onCommandsUpdate?.(commands);
        }
      },
    });
    try {
      await Promise.race([process.start(), exit]);
      if (exited || this.disposed || this.generation !== generation) {
        await process.dispose().catch(() => {});
        return null;
      }
      this.process = process;
      // forkSurface 由 OmpChildProcess 的 ready 协商写就（v3 协商失败回落 v2/v1 时为 false）。
      this.forkSurface = process.forkSurface === true;
      if (this.forkSurface) {
        logger.info("omp 目录进程就绪（v3）", { cwd: this.deps.cwd });
      } else {
        logger.info("omp 目录进程就绪（旧核，无 v3 能力）", { cwd: this.deps.cwd });
      }
      return process;
    } catch (error) {
      if (!exited && !this.disposed && this.generation === generation) {
        this.forkSurface = null;
        this.nextRetryAt = Date.now() + OmpDirectoryGateway.START_RETRY_BACKOFF_MS;
        logger.warn("omp 目录进程启动失败", {
          error: error instanceof Error ? error.message : String(error),
          retryInMs: OmpDirectoryGateway.START_RETRY_BACKOFF_MS,
        });
      }
      await process.dispose().catch(() => {});
      return null;
    }
  }

  /** 三态可用性（app 层端口）：v3 方法报错语义（永久 -32601 vs 暂时 -32000）以此为准。 */
  async availability(): Promise<OmpDirectoryAvailability> {
    const process = await this.ensure();
    if (!process || process !== this.process) return "unavailable";
    return this.forkSurface === true ? "available" : "unsupported";
  }

  /** 发送 v1 目录查询命令（模型/档位/命令目录）。 */
  async send(command: OmpCommandFrame): Promise<OmpCommandOutcome> {
    const process = await this.ensure();
    if (!process || process !== this.process) {
      return { success: false, error: "omp directory process unavailable" };
    }
    return process.send(command);
  }

  /**
   * 发送 v3 目录命令：旧核（unsupported）返回 code:"omp_capability_missing" 的失败
   * （调用方映射 -32601）；其余失败原样透传（含 code）。进程暂时不可用返回
   * code:"omp_directory_unavailable"（调用方映射 -32000 可重试）。
   */
  async sendDirectory(command: OmpDirectoryCommand): Promise<OmpCommandOutcome> {
    const process = await this.ensure();
    if (!process || process !== this.process) {
      return {
        success: false,
        error: "omp directory process unavailable",
        code: "omp_directory_unavailable",
      };
    }
    if (this.forkSurface !== true) {
      return {
        success: false,
        error: `method not supported by omp core: ${command.type}`,
        code: "omp_capability_missing",
      };
    }
    return process.send(command);
  }

  async dispose(): Promise<void> {
    this.disposed = true;
    this.generation += 1;
    this.forkSurface = null;
    const process = this.process;
    this.process = null;
    await process?.dispose();
  }
}

// OMP 项目进程 ready 等待/归因门（自 ompProjectProcess.ts 抽出，架构 maxFileLines=400）：
// 承接 ready 帧解析（仅项目模式 mode:"rpc-ui-project" 放行）、stderr 尾部行缓冲与
// ready 前失败归因（真旧核 OmpProjectUnsupportedError 判定）；进程宿主经 hooks 在 ready
// 解析时回写 processInstanceId 与 v2 重组上限，ready 语义与回落约定不变。

import type { ChildProcessWithoutNullStreams } from "node:child_process";
import { createInterface } from "node:readline";
import { ompProjectReadyInfoSchema } from "../domain/ompProjectFrames.js";
import { parseJson } from "./jsonl.js";
import { logger } from "./logger.js";

const READY_TIMEOUT_MS = 60_000;

/**
 * 真旧核（pre-fork.271）标记错误：该代 omp 不识别 `--rpc-project` flag，按
 * cli/args.ts 的 unknown flag 报错并 process.exit(2)（main.ts），永远不会 emit ready。
 * gateway 据此判定项目能力永久缺失（capability=false，-32601 语义）而非可重试失败，
 * 防止每个退避窗过后再 spawn 一个必败进程。
 */
export class OmpProjectUnsupportedError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "OmpProjectUnsupportedError";
  }
}

/** ready 解析结果接线：processInstanceId 与 v2 重组上限在 ready 到达时回写进程宿主。 */
export interface OmpProjectReadyGateHooks {
  onInstanceId: (instanceId: string) => void;
  onMaxReassembledFrameBytes: (limit: number) => void;
}

export class OmpProjectReadyGate {
  /** stderr 尾部行缓冲（最后 2 行）：真旧核 unknown flag 报错只在 stderr 出现且永不 ready。 */
  private readonly stderrTail: string[] = [];

  constructor(private readonly hooks: OmpProjectReadyGateHooks) {}

  /** stderr 接线：调试留痕 + 保留最后 2 行非空输出，供「ready 前退出」的归因（旧核对
   * --rpc-project 报 unknown flag 后 exit(2)，该报错不进任何协议帧）。 */
  observeStderr(child: ChildProcessWithoutNullStreams): void {
    child.stderr.on("data", (chunk: Buffer) => {
      const text = chunk.toString("utf8").trim();
      if (text.length === 0) return;
      logger.debug("omp project stderr", { text: text.slice(0, 2000) });
      // 修复（B4）：保留最后 2 行非空 stderr 供归因。
      for (const line of text.split(/\r?\n/)) {
        if (line.trim().length === 0) continue;
        this.stderrTail.push(line);
        if (this.stderrTail.length > 2) this.stderrTail.shift();
      }
    });
  }

  /** 解析 ready 帧：仅项目模式（mode:"rpc-ui-project"）返回 true，其余返回 false（调用方整体回落）。 */
  awaitReady(child: ChildProcessWithoutNullStreams): Promise<boolean> {
    return new Promise<boolean>((resolve, reject) => {
      let settled = false;
      let closeFallbackTimer: NodeJS.Timeout | null = null;
      const timer = setTimeout(
        () => settle(() => reject(this.readyFailureError(null, "omp project core ready timeout"))),
        READY_TIMEOUT_MS,
      );
      const settle = (settleFn: () => void) => {
        if (settled) return;
        settled = true;
        clearTimeout(timer);
        if (closeFallbackTimer) clearTimeout(closeFallbackTimer);
        settleFn();
      };
      const onLine = (line: string) => {
        const frame = parseJson(line);
        if (!frame || typeof frame !== "object" || (frame as { type?: unknown }).type !== "ready") {
          return;
        }
        const parsed = ompProjectReadyInfoSchema.safeParse(frame);
        if (!parsed.success) {
          // 非 v3 fork surface 的旧 omp：单会话模式，整体回落。
          readline.removeListener("line", onLine);
          settle(() => resolve(false));
          return;
        }
        this.hooks.onInstanceId(parsed.data.processInstanceId);
        // 修复（B6）：ready 即通告 v2 重组上限，立即接线（rpc_chunk 只在 negotiate
        // 成功后出现，时机安全）；缺失/非法不回调，宿主保持默认 64MiB。
        const limit = (parsed.data as { maxReassembledFrameBytes?: unknown })
          .maxReassembledFrameBytes;
        if (typeof limit === "number" && limit > 0) {
          this.hooks.onMaxReassembledFrameBytes(limit);
        }
        readline.removeListener("line", onLine);
        settle(() => resolve(true));
      };
      const readline = createInterface({ input: child.stdout });
      readline.on("line", onLine);
      readline.once("close", () => {
        // stdout EOF 与 exit 事件次序无保证：真旧核（unknown flag→exit 2）的归因依赖
        // exit code/stderr 尾行，先让 exit 报到，短暂等待后再按 stdout 关闭结算。
        closeFallbackTimer = setTimeout(
          () =>
            settle(() =>
              reject(this.readyFailureError(null, "omp project core stdout closed before ready")),
            ),
          250,
        );
      });
      child.once("exit", (code) => {
        settle(() =>
          reject(this.readyFailureError(code ?? null, "omp project core exited before ready")),
        );
      });
      child.once("error", (error) => {
        settle(() => reject(error instanceof Error ? error : new Error(String(error))));
      });
    });
  }

  /** ready 前失败归因（修复 S1-1）：仅 stderr 尾行命中 unknown flag 才判真旧核
   * （pre-fork.271 对 --rpc-project 报 `Error: unknown flag: …`），携带可判别标记
   * （OmpProjectUnsupportedError）。exit 2 不再单独充分：omp 侧
   * reportUnrecognizedFlags（unknown flag）与 reportInvalidFlagValues（非法 flag 值）
   * 都走 process.exit(2)（main.ts:2509-2513），但后者 stderr 文案是 `Error: <message>`
   * 不含 "unknown flag"（args.ts:422-428）——把非法值误判旧核会造成永久回落。
   * 其余一律为普通启动失败（可重试）。 */
  private readyFailureError(code: number | null, context: string): Error {
    const tail = this.stderrTail.join(" ");
    if (/unknown flag/i.test(tail)) {
      const detail = tail.length > 0 ? `: ${tail.slice(-300)}` : "";
      return new OmpProjectUnsupportedError(
        `omp project unsupported: old core rejected --rpc-project (exit ${code ?? "null"})${detail}`,
      );
    }
    return new Error(`${context} (code ${code ?? "null"})`);
  }
}

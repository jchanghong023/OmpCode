// omp 子进程 ready 等待与协议版本协商（v3 fork surface 优先，v2 回落）。
// 从 ompProcess 拆出：进程适配器只保留 IO 与帧分发，协商策略独立成模块。

import { createInterface } from "node:readline";
import type { ChildProcessWithoutNullStreams } from "node:child_process";
import { ompReadyFrameSchema, type OmpReadyFrame } from "../domain/ompFrames.js";
import type { OmpCommandOutcome } from "../app/ports.js";
import { logger } from "./logger.js";
import { parseJson } from "./jsonl.js";

const READY_TIMEOUT_MS = 60_000;

export interface OmpNegotiationHooks {
  /** 发送命令（带请求关联与超时）。 */
  request: (command: {
    type: "negotiate_protocol";
    protocolVersion: number;
  }) => Promise<OmpCommandOutcome>;
  /** v3 协商成功回调（fork surface 激活）。 */
  onForkSurface: () => void;
  /** ready 到达后先交接持续读流，再发送协商，避免同批 stdout 响应丢失。 */
  onReady: (ready: OmpReadyFrame) => void;
}

/** ready → 持续读流交接 → 协商完成；能力事实必须先于 start() 返回。 */
export function awaitOmpReady(
  child: ChildProcessWithoutNullStreams,
  hooks: OmpNegotiationHooks,
): Promise<OmpReadyFrame> {
  const startedAt = Date.now();
  const diagnosticContext = { ...logger.context(), peerPid: child.pid };
  return logger.run(
    diagnosticContext,
    () =>
      new Promise<OmpReadyFrame>((resolve, reject) => {
        const readline = createInterface({ input: child.stdout });
        const cleanup = () => {
          clearTimeout(timer);
          readline.removeListener("line", onLine);
          readline.removeListener("close", onClose);
          child.removeListener("exit", onExit);
          child.removeListener("error", onError);
          readline.close();
        };
        let failureLogged = false;
        const fail = (error: Error, stage: string) => {
          if (!failureLogged) {
            failureLogged = true;
            logger.error("omp_core_ready_failed", {
              ...diagnosticContext,
              event: "omp_core_ready_failed",
              stage,
              error,
              elapsedMs: Date.now() - startedAt,
              timeoutMs: READY_TIMEOUT_MS,
            });
          }
          cleanup();
          reject(error);
        };
        const onClose = () =>
          fail(new Error("omp core stdout closed before ready"), "ready_stdout_closed");
        const onExit = (code: number | null) =>
          fail(
            new Error(`omp core exited before ready (code ${code ?? "null"})`),
            "before_ready_exit",
          );
        const onError = (error: Error) => fail(error, "spawn");
        const timer = setTimeout(
          () => fail(new Error("omp core ready timeout"), "ready_timeout"),
          READY_TIMEOUT_MS,
        );
        const onLine = (line: string) => {
          const value = parseJson(line);
          const parsed = ompReadyFrameSchema.safeParse(value);
          if (!parsed.success) {
            if (
              value &&
              typeof value === "object" &&
              (value as Record<string, unknown>).type === "ready"
            )
              logger.warn("omp_core_ready_decode_failed", {
                ...diagnosticContext,
                event: "omp_core_ready_decode_failed",
                stage: "ready_decode",
                issueCount: parsed.error.issues.length,
              });
            return;
          }
          cleanup();
          // 原先协商 fire-and-forget，目录读取 forkSurface 时仍未收到 ACK，
          // 会把当前 v3 核永久误判为旧核；先接好读流，再等待能力事实。
          hooks.onReady(parsed.data);
          void negotiate(hooks, parsed.data.supportedProtocolVersions).then(
            () => resolve(parsed.data),
            reject,
          );
        };
        readline.on("line", onLine);
        readline.once("close", onClose);
        child.once("exit", onExit);
        child.once("error", onError);
      }),
  );
}

async function negotiate(
  hooks: OmpNegotiationHooks,
  versions: number[] | undefined,
): Promise<void> {
  const startedAt = Date.now();
  logger.info("omp_protocol_negotiation_started", {
    event: "omp_protocol_negotiation_started",
    supportedProtocolVersions: versions,
    elapsedMs: 0,
  });
  if (versions?.includes(3)) {
    try {
      const outcome = await hooks.request({ type: "negotiate_protocol", protocolVersion: 3 });
      if (outcome.success) {
        hooks.onForkSurface();
        logger.info("omp_protocol_negotiation_completed", {
          event: "omp_protocol_negotiation_completed",
          protocolVersion: 3,
          forkSurface: true,
          elapsedMs: Date.now() - startedAt,
        });
        return;
      }
      logger.warn("omp_protocol_negotiation_fallback", {
        event: "omp_protocol_negotiation_fallback",
        protocolVersion: 3,
        fallbackVersion: 2,
        stage: "remote",
        error: outcome.error ?? "unknown",
        elapsedMs: Date.now() - startedAt,
      });
    } catch (error) {
      logger.warn("omp_protocol_negotiation_fallback", {
        event: "omp_protocol_negotiation_fallback",
        protocolVersion: 3,
        fallbackVersion: 2,
        stage: "request",
        error,
        elapsedMs: Date.now() - startedAt,
      });
    }
  }
  await negotiateV2(hooks, versions, startedAt);
}

/** v2 分片协商（v3 不可用或协商失败时的回落路径）。 */
async function negotiateV2(
  hooks: OmpNegotiationHooks,
  versions: number[] | undefined,
  startedAt: number,
): Promise<void> {
  if (!versions?.includes(2)) {
    logger.info("omp_protocol_negotiation_completed", {
      event: "omp_protocol_negotiation_completed",
      protocolVersion: 1,
      forkSurface: false,
      elapsedMs: Date.now() - startedAt,
    });
    return;
  }
  try {
    const outcome = await hooks.request({ type: "negotiate_protocol", protocolVersion: 2 });
    logger[outcome.success ? "info" : "warn"](
      outcome.success ? "omp_protocol_negotiation_completed" : "omp_protocol_negotiation_fallback",
      {
        event: outcome.success
          ? "omp_protocol_negotiation_completed"
          : "omp_protocol_negotiation_fallback",
        protocolVersion: 2,
        ...(outcome.success ? {} : { fallbackVersion: 1, stage: "remote", error: outcome.error }),
        forkSurface: false,
        elapsedMs: Date.now() - startedAt,
      },
    );
    if (!outcome.success)
      logger.info("omp_protocol_negotiation_completed", {
        event: "omp_protocol_negotiation_completed",
        protocolVersion: 1,
        forkSurface: false,
        elapsedMs: Date.now() - startedAt,
      });
  } catch (error) {
    logger.warn("omp_protocol_negotiation_fallback", {
      event: "omp_protocol_negotiation_fallback",
      protocolVersion: 2,
      fallbackVersion: 1,
      stage: "request",
      error,
      elapsedMs: Date.now() - startedAt,
    });
    logger.info("omp_protocol_negotiation_completed", {
      event: "omp_protocol_negotiation_completed",
      protocolVersion: 1,
      forkSurface: false,
      elapsedMs: Date.now() - startedAt,
    });
  }
}

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
}

/**
 * 等待 omp ready 帧并触发协议协商。resolve 于 ready 到达，携带解析后的 ready 帧
 * （进程层据此接线 v2 分片重组上限 maxReassembledFrameBytes）；协商 fire-and-forget——
 * omp 侧对 fork 命令/帧按协商结果门控，本函数只记录能力事实，不阻塞启动。
 */
export function awaitOmpReady(
  child: ChildProcessWithoutNullStreams,
  hooks: OmpNegotiationHooks,
): Promise<OmpReadyFrame> {
  return new Promise<OmpReadyFrame>((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error("omp core ready timeout")), READY_TIMEOUT_MS);
    const onLine = (line: string) => {
      const frame = parseJson(line);
      if (!frame || typeof frame !== "object") {
        return;
      }
      const readyParsed = ompReadyFrameSchema.safeParse(frame);
      if (!readyParsed.success) {
        return;
      }
      clearTimeout(timer);
      const versions = readyParsed.data.supportedProtocolVersions;
      if (versions?.includes(3)) {
        hooks
          .request({ type: "negotiate_protocol", protocolVersion: 3 })
          .then((outcome) => {
            if (outcome.success) {
              hooks.onForkSurface();
              logger.info("omp rpc-ui fork surface v3 已激活");
              return;
            }
            logger.warn("omp v3 协商失败，回落 v2", { error: outcome.error ?? "unknown" });
            void negotiateV2(hooks, versions);
          })
          .catch((error) => {
            logger.warn("omp v3 协商失败，回落 v2", { error: String(error) });
            void negotiateV2(hooks, versions);
          });
      } else {
        void negotiateV2(hooks, versions);
      }
      readline.removeListener("line", onLine);
      resolve(readyParsed.data);
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
    child.once("error", (error) => {
      clearTimeout(timer);
      reject(error instanceof Error ? error : new Error(String(error)));
    });
  });
}

/** v2 分片协商（v3 不可用或协商失败时的回落路径）。 */
async function negotiateV2(
  hooks: OmpNegotiationHooks,
  versions: number[] | undefined,
): Promise<void> {
  if (!versions?.includes(2)) {
    return;
  }
  try {
    await hooks.request({ type: "negotiate_protocol", protocolVersion: 2 });
  } catch (error) {
    logger.warn("omp v2 协商失败，回落 v1", { error: String(error) });
  }
}

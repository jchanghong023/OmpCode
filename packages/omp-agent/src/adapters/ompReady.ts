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
  return new Promise<OmpReadyFrame>((resolve, reject) => {
    const readline = createInterface({ input: child.stdout });
    const cleanup = () => {
      clearTimeout(timer);
      readline.removeListener("line", onLine);
      readline.removeListener("close", onClose);
      child.removeListener("exit", onExit);
      child.removeListener("error", onError);
      readline.close();
    };
    const fail = (error: Error) => {
      cleanup();
      reject(error);
    };
    const onClose = () => fail(new Error("omp core stdout closed before ready"));
    const onExit = (code: number | null) =>
      fail(new Error(`omp core exited before ready (code ${code ?? "null"})`));
    const onError = (error: Error) => fail(error);
    const timer = setTimeout(() => fail(new Error("omp core ready timeout")), READY_TIMEOUT_MS);
    const onLine = (line: string) => {
      const parsed = ompReadyFrameSchema.safeParse(parseJson(line));
      if (!parsed.success) return;
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
  });
}

async function negotiate(
  hooks: OmpNegotiationHooks,
  versions: number[] | undefined,
): Promise<void> {
  if (versions?.includes(3)) {
    try {
      const outcome = await hooks.request({ type: "negotiate_protocol", protocolVersion: 3 });
      if (outcome.success) {
        hooks.onForkSurface();
        logger.info("omp rpc-ui fork surface v3 已激活");
        return;
      }
      logger.warn("omp v3 协商失败，回落 v2", { error: outcome.error ?? "unknown" });
    } catch (error) {
      logger.warn("omp v3 协商失败，回落 v2", { error: String(error) });
    }
  }
  await negotiateV2(hooks, versions);
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

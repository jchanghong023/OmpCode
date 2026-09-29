// Fork（omp-project-mode.md）：项目模式的会话生命周期（创建/恢复/冷行水合）。
// 从 SessionRegistry 拆出（架构 max-file-lines）；经 host 接口回写注册表，不持有第二份状态。

import type { ConversationRow } from "@zcode/shared/zcode-protocol-v4";
import {
  coldSubagentIds,
  rowsFromOmpEntries,
  transcriptFromOmpEntries,
} from "../domain/coldHistory.js";
import { ConversationEngine } from "./conversationEngine.js";
import { ProtocolError } from "./errors.js";
import type {
  HostGateway,
  OmpProjectGatewayPort,
  OmpSessionProcess,
  OmpSessionProcessHandlers,
  OmpStorePort,
} from "./ports.js";

export interface ProjectSessionHost {
  project: OmpProjectGatewayPort;
  store: OmpStorePort;
  gateway: HostGateway;
  engines: Map<string, ConversationEngine>;
  onIndexChange: (engine: ConversationEngine) => void;
  onCommandsUpdate?: (commands: unknown) => void;
  /** 恢复/创建后的索引摘要回写（含 createdAt/lastActivityAt 覆盖）。 */
  upsertEngineSummary: (
    engine: ConversationEngine,
    overrides?: { createdAt?: number; lastActivityAt?: number },
  ) => void;
  /** 父会话原始子代理帧出口（只读详情视图实时事件）。 */
  dispatchSubagentFrame: (
    sessionId: string,
    frame: import("../domain/ompFrames.js").OmpSubagentFrame,
  ) => void;
}

/** 项目模式创建：sessionId 是 OMP 稳定身份（无临时 ID → 文件 UUID 迁移）。 */
export async function createProjectSession(
  host: ProjectSessionHost,
  params: { workspaceId: string; workspacePath: string; title?: string },
): Promise<ConversationEngine> {
  const summary = await host.project.createSession(params.title ? { name: params.title } : {});
  const engine = new ConversationEngine({
    sessionId: summary.sessionId,
    workspaceId: params.workspaceId,
    workspacePath: params.workspacePath,
    gateway: host.gateway,
    onIndexChange: host.onIndexChange,
    onCommandsUpdate: host.onCommandsUpdate,
    initialTitle: params.title,
    acquireProjectProcess: (handlers: OmpSessionProcessHandlers): Promise<OmpSessionProcess> =>
      host.project.acquireSessionChannel(summary.sessionId, handlers),
    forwardSubagentFrame: (frame) => host.dispatchSubagentFrame(summary.sessionId, frame),
  });
  host.engines.set(engine.sessionId, engine);
  host.upsertEngineSummary(engine, { createdAt: Date.now(), lastActivityAt: Date.now() });
  return engine;
}

/** 项目模式恢复：OMP resume_session 为权威；冷行来自会话文件（与 OMP 同目录）。 */
export async function resumeProjectSession(
  host: ProjectSessionHost,
  params: { sessionId: string; workspaceId: string; workspacePath: string },
): Promise<ConversationEngine> {
  let summary;
  try {
    summary = await host.project.resumeSession(params.sessionId);
  } catch (error) {
    throw new ProtocolError(
      -32004,
      `session unavailable: ${params.sessionId} (${error instanceof Error ? error.message : String(error)})`,
    );
  }
  const cold = await (host.store.findSession
    ? host.store.findSession(params.workspacePath, params.sessionId).catch(() => null)
    : Promise.resolve(null));
  const engine = new ConversationEngine({
    sessionId: params.sessionId,
    workspaceId: params.workspaceId,
    workspacePath: params.workspacePath,
    gateway: host.gateway,
    onIndexChange: host.onIndexChange,
    onCommandsUpdate: host.onCommandsUpdate,
    resumeSessionPath: cold?.sessionPath ?? summary.sessionFile ?? undefined,
    initialTitle: cold?.title ?? summary.name ?? undefined,
    acquireProjectProcess: (handlers: OmpSessionProcessHandlers): Promise<OmpSessionProcess> =>
      host.project.acquireSessionChannel(params.sessionId, handlers),
    forwardSubagentFrame: (frame) => host.dispatchSubagentFrame(params.sessionId, frame),
  });
  await hydrateEngineFromCold(
    host,
    engine,
    cold?.sessionPath ?? summary.sessionFile ?? null,
    cold?.createdAt,
    cold?.updatedAt,
  );
  return engine;
}

/** 冷历史行入投影 + 引擎登记（行缺失时保留空投影，后续事件/重读补齐）。 */
export async function hydrateEngineFromCold(
  host: ProjectSessionHost,
  engine: ConversationEngine,
  sessionPath: string | null,
  createdAt?: number,
  updatedAt?: number,
): Promise<void> {
  if (sessionPath) {
    const entries = await host.store.readSessionEntries(sessionPath);
    const transcripts = new Map(
      await Promise.all(
        coldSubagentIds(entries)
          .slice(0, 20)
          .map(
            async (id) =>
              [
                id,
                transcriptFromOmpEntries(await host.store.readSubagentEntries(sessionPath, id)),
              ] as const,
          ),
      ),
    );
    const rows: ConversationRow[] = rowsFromOmpEntries(entries, transcripts);
    engine.hydrateRows(rows);
  }
  host.engines.set(engine.sessionId, engine);
  host.upsertEngineSummary(engine, {
    createdAt: createdAt ?? Date.now(),
    lastActivityAt: updatedAt ?? Date.now(),
  });
}

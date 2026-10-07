// SessionRegistry 的删除/关闭墓碑、冷恢复登记门与删除/关闭收尾编排（自 sessionRegistry.ts 拆出）。

import type { ConversationEngine } from "./conversationEngine.js";
import { deleteColdSession } from "./deleteColdSession.js";
import { deleteLoadedSession } from "./deleteLoadedSession.js";
import { ProtocolError } from "./errors.js";
import type { OmpDirectoryGatewayPort, OmpStorePort } from "./ports.js";

/** 登记门的注册表读写面（SessionRegistry 的窄视图）。 */
interface RegistryGateIo {
  engines: Map<string, ConversationEngine>;
  getEngine(sessionId: string): ConversationEngine | null;
  removeIndexSession(workspaceId: string, sessionId: string): void;
}

export class SessionRegistryGates {
  /**
   * 删除墓碑（修复 S7-4）：deleteSession 先登记；冷恢复完成后的登记点据此拒绝把
   * 已删除会话复活（幽灵引擎 + 索引行，后续 prompt 对已删会话永久 not_found）。
   * 删除未生效（OMP/存储失败）时回滚，会话身份仍有效。
   */
  private readonly deletedSessionIds = new Set<string>();
  /**
   * 关闭墓碑（修复 S7-4）：closeSession 进行中登记、结束即解除；同身份在途冷恢复
   * 不得把正在关闭的会话登记复活，关闭完成后重新打开不受影响。
   */
  private readonly closingSessionIds = new Set<string>();
  /** dispose 已置位（修复 S7-4）：作废全部在途 create/resume 的登记，销毁期间不得再进表。 */
  private disposing = false;

  constructor(private readonly io: RegistryGateIo) {}

  beginDispose(): void {
    this.disposing = true;
  }

  markDeleted(sessionId: string): void {
    this.deletedSessionIds.add(sessionId);
  }

  rollbackDeleted(sessionId: string): void {
    this.deletedSessionIds.delete(sessionId);
  }

  markClosing(sessionId: string): void {
    this.closingSessionIds.add(sessionId);
  }

  endClosing(sessionId: string): void {
    this.closingSessionIds.delete(sessionId);
  }

  /**
   * 冷恢复登记门（修复 S2-2/S7-4）：hydrateEngineFromCold 不再自行登记，统一在
   * 墓碑检查 + winner 判定通过后才登记引擎。
   * - 命中删除/关闭墓碑或已 dispose：丢弃本次冷恢复结果（冷引擎无子进程，dispose
   *   无副作用）并清理索引行，按「会话不可用」拒绝；
   * - 已有更早登记的并发实例（create 或先完成的加载）：返回已登记引擎，丢弃本次结果；
   * - 否则登记并返回本次引擎。
   */
  settleColdHydration(sessionId: string, engine: ConversationEngine): ConversationEngine {
    if (
      this.disposing ||
      this.deletedSessionIds.has(sessionId) ||
      this.closingSessionIds.has(sessionId)
    ) {
      void engine.dispose().catch(() => {});
      this.io.removeIndexSession(engine.workspaceId, sessionId);
      throw new ProtocolError(-32004, `session unavailable: ${sessionId}`);
    }
    const winner = this.io.getEngine(sessionId);
    if (winner && winner !== engine) {
      return winner;
    }
    this.io.engines.set(engine.sessionId, engine);
    return engine;
  }
}

/** 删除/关闭收尾所需的注册表读写面（SessionRegistry 的窄视图）。 */
export interface SessionTeardownHost {
  gates: SessionRegistryGates;
  directory: OmpDirectoryGatewayPort;
  getEngine(sessionId: string): ConversationEngine | null;
  dropEngine(sessionId: string): void;
  removeIndexSession(workspaceId: string, sessionId: string): void;
  store: OmpStorePort;
  primaryWorkspace(): { id: string; path: string } | null;
  forgetRekeyed(sessionId: string): void;
  upsertEngineSummary(engine: ConversationEngine): void;
}

export async function deleteSessionWith(
  host: SessionTeardownHost,
  sessionId: string,
): Promise<void> {
  // 修复（S7-4）：删除墓碑先行——同身份 resume 在途时，冷恢复完成不得把已删会话
  // 登记复活（幽灵引擎 + 索引行）。删除未生效时在 catch 回滚，会话身份仍有效。
  host.gates.markDeleted(sessionId);
  try {
    // 已加载引擎：先结束其 omp 进程（preparePermanentDeletion 保留投影与 resume 路径）。
    // 上游语义（oh-my-pi rpc-fork-sessions）：承载会话的进程持有文件租约，delete_session
    // 对其拒绝（"Close the session's process before deleting it"）——必须先释放占用再删。
    // 删除墓碑保证释放窗口内同身份 resume 不会复活引擎；删除失败回滚墓碑后引擎仍可
    // 经 resumeSessionPath 重启（会话身份与内容未受影响）。
    const engine = host.getEngine(sessionId);
    if (engine) {
      await engine.preparePermanentDeletion().catch(() => {});
    }
    const directoryOutcome = await host.directory.sendDirectory({
      type: "delete_session",
      sessionId,
    });
    if (directoryOutcome.success || directoryOutcome.code !== "omp_capability_missing") {
      if (!directoryOutcome.success) {
        // omp 权威删除失败（修订冲突/租约冲突等）：如实上报，本地索引保留（可重试）。
        throw new ProtocolError(
          -32004,
          `${directoryOutcome.error ?? `session deletion failed: ${sessionId}`}${directoryOutcome.code ? ` [${directoryOutcome.code}]` : ""}`,
        );
      }
      if (engine) {
        await engine.dispose();
        host.dropEngine(engine.sessionId);
      }
      const workspaceId = engine?.workspaceId ?? host.primaryWorkspace()?.id;
      if (workspaceId) {
        host.removeIndexSession(workspaceId, sessionId);
      }
      return;
    }
    // 旧核无 v3 会话目录：回落本地文件删除路径（仍须确认文件删除成功后才移除索引）。
    if (engine) {
      const stableId = await deleteLoadedSession(engine, host.store, sessionId);
      host.dropEngine(engine.sessionId);
      for (const id of new Set(
        [engine.sessionId, sessionId, stableId].filter((id): id is string => Boolean(id)),
      )) {
        host.removeIndexSession(engine.workspaceId, id);
      }
      host.forgetRekeyed(engine.sessionId);
      return;
    }
    // 冷会话文件与索引同步删除；没有找到时保持明确的 unavailable 错误。
    if (
      await deleteColdSession({
        store: host.store,
        workspace: host.primaryWorkspace(),
        sessionId,
        onDeleted: (workspaceId, id) => {
          host.removeIndexSession(workspaceId, id);
        },
      })
    )
      return;
    throw new ProtocolError(-32004, `session unavailable: ${sessionId}`);
  } catch (error) {
    // 删除未生效（OMP 拒绝/存储失败/会话不存在）：回滚墓碑，会话身份仍可正常使用。
    host.gates.rollbackDeleted(sessionId);
    throw error;
  }
}

export async function closeSessionWith(
  host: SessionTeardownHost,
  sessionId: string,
): Promise<void> {
  // 修复（S7-4）：关闭墓碑先行（close 结束即解除）——同身份 resume 在途时，冷恢复
  // 完成不得把正在关闭的会话登记复活；关闭完成后重新打开不受影响。
  host.gates.markClosing(sessionId);
  try {
    const engine = host.getEngine(sessionId);
    if (!engine) return;
    const persistedPath = engine.ompSessionFile;
    engine.projection.failAllTurns({ code: "session_closed", message: "session closed" });
    if (persistedPath) host.upsertEngineSummary(engine);
    await engine.dispose();
    host.dropEngine(engine.sessionId);
    if (!persistedPath) {
      host.removeIndexSession(engine.workspaceId, engine.sessionId);
    }
  } finally {
    host.gates.endClosing(sessionId);
  }
}

// SessionRegistry 的删除/关闭墓碑、冷恢复登记门与删除/关闭收尾编排（自 sessionRegistry.ts 拆出）。

import type { ConversationEngine } from "./conversationEngine.js";
import { ompSessionIdOfFilePath } from "../domain/ids.js";
import { deleteColdSession } from "./deleteColdSession.js";
import { deleteLoadedSession } from "./deleteLoadedSession.js";
import { ProtocolError } from "./errors.js";
import type { OmpDirectoryGatewayPort, OmpStorePort } from "./ports.js";
import { diagnostics } from "./diagnostics.js";

/** 登记门的注册表读写面（SessionRegistry 的窄视图）。 */
interface RegistryGateIo {
  engines: Map<string, ConversationEngine>;
  getEngine(sessionId: string): ConversationEngine | null;
  pendingResumeClosures?(): Iterable<Set<string>>;
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
    // 关闭标记只活到 close 收尾；失效事实随 Registry 的在途恢复一起释放，不等待冷 IO。
    // 先记原始地址，冷 alias 确认 canonical 后仍用同一登记门判断，不能复活旧代。
    for (const closures of this.io.pendingResumeClosures?.() ?? []) closures.add(sessionId);
  }

  endClosing(sessionId: string): void {
    this.closingSessionIds.delete(sessionId);
  }

  captureResumeClosures(): Set<string> {
    return new Set(this.closingSessionIds);
  }

  canResumeFrom(closedSessionIds: ReadonlySet<string>, ...sessionIds: string[]): boolean {
    return this.canResume(...sessionIds) && sessionIds.every((id) => !closedSessionIds.has(id));
  }

  canResume(...sessionIds: string[]): boolean {
    return (
      !this.disposing &&
      sessionIds.every((id) => !this.deletedSessionIds.has(id) && !this.closingSessionIds.has(id))
    );
  }

  /**
   * 冷恢复登记门（修复 S2-2/S7-4）：hydrateEngineFromCold 不再自行登记，统一在
   * 墓碑检查 + winner 判定通过后才登记引擎。
   * - 命中删除/关闭墓碑、旧恢复关闭边界或已 dispose：丢弃本次冷恢复结果，
   *   按「会话不可用」拒绝；尚未登记的冷结果不发布索引，不清理其他 owner；
   * - 已有更早登记的并发实例（create 或先完成的加载）：返回已登记引擎，丢弃本次结果；
   * - 否则登记并返回本次引擎。
   */
  settleColdHydration(
    sessionId: string,
    engine: ConversationEngine,
    closedSessionIds: ReadonlySet<string>,
    canonicalId = sessionId,
    existingOwner?: ConversationEngine,
  ): ConversationEngine {
    if (!this.canResumeFrom(closedSessionIds, sessionId, canonicalId)) {
      const blockedByDeleted =
        this.deletedSessionIds.has(sessionId) || this.deletedSessionIds.has(canonicalId);
      diagnostics.warn("omp.session.cold_hydration.rejected", {
        sessionId,
        canonicalId,
        stage: this.disposing
          ? "dispose"
          : blockedByDeleted
            ? "delete_tombstone"
            : "close_tombstone",
      });
      // lookup 完成时可能已找到关闭后的新 owner；拒绝的是旧请求，不能销毁那个活引擎。
      if (this.io.engines.get(engine.sessionId) !== engine) void engine.dispose().catch(() => {});
      throw new ProtocolError(-32004, `session unavailable: ${sessionId}`);
    }
    const winner = existingOwner ?? this.io.getEngine(sessionId);
    if (winner && winner !== engine) {
      void engine.dispose().catch(() => {});
      diagnostics.debug("omp.session.cold_hydration.winner_reused", {
        sessionId,
        canonicalId,
        winnerSessionId: winner.sessionId,
        stage: "registration",
      });
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
  const startedAt = Date.now();
  host.gates.markDeleted(sessionId);
  diagnostics.info("omp.session.delete.started", { sessionId, stage: "tombstone" });
  const deletionIds = new Set([sessionId]);
  const markIdentity = (id: string) => {
    deletionIds.add(id);
    host.gates.markDeleted(id);
  };
  try {
    // 已加载引擎：先结束其 omp 进程（preparePermanentDeletion 保留投影与 resume 路径）。
    // 上游语义（oh-my-pi rpc-fork-sessions）：承载会话的进程持有文件租约，delete_session
    // 对其拒绝（"Close the session's process before deleting it"）——必须先释放占用再删。
    // 删除墓碑保证释放窗口内同身份 resume 不会复活引擎；删除失败回滚墓碑后引擎仍可
    // 经 resumeSessionPath 重启（会话身份与内容未受影响）。
    let engine = host.getEngine(sessionId);
    if (engine) markIdentity(engine.sessionId);
    let persistedPath = engine ? await engine.preparePermanentDeletion() : null;
    await host.store.flushCommandOutputs?.();
    let stableId = ompSessionIdOfFilePath(persistedPath) ?? sessionId;
    const workspace = engine
      ? { id: engine.workspaceId, path: engine.workspacePath }
      : host.primaryWorkspace();
    const deleteDerived = async (): Promise<void> => {
      if (
        workspace &&
        host.store.deleteCommandOutputs &&
        !(await host.store.deleteCommandOutputs(workspace.path, sessionId, persistedPath))
      )
        throw new ProtocolError(-32603, `cannot delete omp command history: ${sessionId}`);
    };
    // 本地命令无 OMP journal 时仅删除 GUI 派生文件，不能把逻辑 ID 发给 OMP delete_session。
    const coldSummary = workspace ? await host.store.findSession?.(workspace.path, stableId) : null;
    // 冷 alias 已定位到真实会话；目录删除必须使用 canonical UUID，不能把旧 GUI ID 发给 OMP。
    if (!engine && coldSummary) stableId = coldSummary.sessionId;
    markIdentity(stableId);
    // 别名查找在途时 canonical 冷恢复可能先登记；屏障后复查唯一 owner 并释放其 lease。
    const racedOwner = !engine && coldSummary ? host.getEngine(coldSummary.sessionId) : null;
    if (
      racedOwner &&
      workspace &&
      (racedOwner.workspaceId.trim() || racedOwner.workspacePath) ===
        (workspace.id.trim() || workspace.path) &&
      racedOwner.workspacePath === workspace.path &&
      racedOwner.ompSessionFile === (coldSummary?.sessionPath || null)
    ) {
      engine = racedOwner;
      markIdentity(engine.sessionId);
      persistedPath = await engine.preparePermanentDeletion();
    }
    if (!engine && workspace) {
      if (coldSummary?.commandOutputOnly) {
        await deleteDerived();
        host.removeIndexSession(workspace.id, sessionId);
        diagnostics.info("omp.session.delete.completed", {
          sessionId,
          stage: "cleanup",
          outcome: "command_output_only",
          elapsedMs: Date.now() - startedAt,
        });
        return;
      }
    }
    // 惰性草稿还没有核心文件，不向目录删除不存在的临时 ID；已落盘则用 UUID，
    // 运行中索引仍使用临时 ID 的窗口内也必须能永久删除。
    const directoryOutcome =
      (engine && !persistedPath) || coldSummary?.commandOutputOnly
        ? { success: true, code: undefined, error: undefined }
        : await host.directory.sendDirectory({ type: "delete_session", sessionId: stableId });
    diagnostics[
      directoryOutcome.success
        ? "info"
        : directoryOutcome.code === "omp_capability_missing"
          ? "warn"
          : "error"
    ]("omp.session.delete.directory.result", {
      sessionId,
      directorySessionId: stableId,
      commandType: "delete_session",
      requestSent: !((engine && !persistedPath) || coldSummary?.commandOutputOnly),
      success: directoryOutcome.success,
      code: directoryOutcome.code,
      elapsedMs: Date.now() - startedAt,
    });
    if (directoryOutcome.success || directoryOutcome.code !== "omp_capability_missing") {
      if (!directoryOutcome.success) {
        // omp 权威删除失败（修订冲突/租约冲突等）：如实上报，本地索引保留（可重试）。
        throw new ProtocolError(
          -32004,
          `${directoryOutcome.error ?? `session deletion failed: ${sessionId}`}${directoryOutcome.code ? ` [${directoryOutcome.code}]` : ""}`,
        );
      }
      await deleteDerived();
      if (engine) {
        await engine.dispose();
        host.dropEngine(engine.sessionId);
      }
      const workspaceId = engine?.workspaceId ?? host.primaryWorkspace()?.id;
      if (workspaceId) {
        for (const id of new Set([sessionId, stableId, ...(engine ? [engine.sessionId] : [])])) {
          host.removeIndexSession(workspaceId, id);
        }
      }
      if (engine) host.forgetRekeyed(engine.sessionId);
      diagnostics.info("omp.session.delete.completed", {
        sessionId,
        directorySessionId: stableId,
        stage: "cleanup",
        outcome: "directory",
        elapsedMs: Date.now() - startedAt,
      });
      return;
    }
    // 旧核无 v3 会话目录：回落本地文件删除路径（仍须确认文件删除成功后才移除索引）。
    diagnostics.warn("omp.session.delete.fallback", {
      sessionId,
      directorySessionId: stableId,
      stage: "directory_delete",
      fallback: engine ? "loaded_local_files" : "cold_local_files",
      code: directoryOutcome.code,
    });
    if (engine) {
      const stableId = await deleteLoadedSession(engine, host.store, sessionId);
      await deleteDerived();
      host.dropEngine(engine.sessionId);
      for (const id of new Set(
        [engine.sessionId, sessionId, stableId].filter((id): id is string => Boolean(id)),
      )) {
        host.removeIndexSession(engine.workspaceId, id);
      }
      host.forgetRekeyed(engine.sessionId);
      diagnostics.info("omp.session.delete.completed", {
        sessionId,
        stage: "cleanup",
        outcome: "loaded_local_files",
        elapsedMs: Date.now() - startedAt,
      });
      return;
    }
    // 冷会话文件与索引同步删除；没有找到时保持明确的 unavailable 错误。
    if (
      await deleteColdSession({
        store: host.store,
        workspace: host.primaryWorkspace(),
        sessionId,
        onDeleted: () => {},
      })
    ) {
      await deleteDerived();
      if (workspace) host.removeIndexSession(workspace.id, sessionId);
      diagnostics.info("omp.session.delete.completed", {
        sessionId,
        stage: "cleanup",
        outcome: "cold_local_files",
        elapsedMs: Date.now() - startedAt,
      });
      return;
    }
    throw new ProtocolError(-32004, `session unavailable: ${sessionId}`);
  } catch (error) {
    // 删除未生效（OMP 拒绝/存储失败/会话不存在）：回滚墓碑，会话身份仍可正常使用。
    for (const id of deletionIds) host.gates.rollbackDeleted(id);
    diagnostics.warn("omp.session.delete.rollback", {
      sessionId,
      stage: "tombstone_rollback",
      identityCount: deletionIds.size,
      errorType: error instanceof Error ? error.name : typeof error,
      elapsedMs: Date.now() - startedAt,
    });
    throw error;
  }
}

export async function closeSessionWith(
  host: SessionTeardownHost,
  sessionId: string,
): Promise<void> {
  // 修复（S7-4）：关闭墓碑先行（close 结束即解除）——同身份 resume 在途时，冷恢复
  // 完成不得把正在关闭的会话登记复活；关闭完成后重新打开不受影响。
  const startedAt = Date.now();
  host.gates.markClosing(sessionId);
  diagnostics.info("omp.session.close.started", { sessionId, stage: "tombstone" });
  let outcome: "failed" | "not_loaded" | "closed" = "failed";
  const closingIds = new Set([sessionId]);
  try {
    let engine = host.getEngine(sessionId);
    if (!engine) {
      const workspace = host.primaryWorkspace();
      const cold = workspace
        ? host.store.findSession
          ? await host.store.findSession(workspace.path, sessionId)
          : (await host.store.listSessions(workspace.path)).find(
              (session) => session.sessionId === sessionId,
            )
        : null;
      if (cold) {
        // 原始 alias 与 UUID 走不同协议尾链；无 owner 时也要从既有存储事实补齐登记边界。
        if (!closingIds.has(cold.sessionId)) {
          closingIds.add(cold.sessionId);
          host.gates.markClosing(cold.sessionId);
        }
        const racedOwner = host.getEngine(cold.sessionId);
        // 复用既有 workspace/文件 epoch 校验；查找期间登记的同一 owner 也必须被关闭。
        if (
          racedOwner &&
          workspace &&
          (racedOwner.workspaceId.trim() || racedOwner.workspacePath) ===
            (workspace.id.trim() || workspace.path) &&
          racedOwner.workspacePath === workspace.path &&
          racedOwner.ompSessionFile === (cold.sessionPath || null)
        )
          engine = racedOwner;
      }
    }
    if (!engine) {
      outcome = "not_loaded";
      return;
    }
    const persistedPath = engine.ompSessionFile;
    // 查找别名共享一个 owner，关闭窗口必须拦住 owner/canonical 的恢复，不能复用 disposed 引擎。
    for (const id of [engine.sessionId, ompSessionIdOfFilePath(persistedPath)])
      if (id) {
        closingIds.add(id);
        host.gates.markClosing(id);
      }
    await host.store.flushCommandOutputs?.();
    const hasCommandHistory = Boolean(
      (await host.store.readCommandOutputs?.(engine.workspacePath, engine.sessionId, persistedPath))
        ?.length,
    );
    engine.projection.failAllTurns({ code: "session_closed", message: "session closed" });
    if (persistedPath || hasCommandHistory) host.upsertEngineSummary(engine);
    await engine.dispose();
    host.dropEngine(engine.sessionId);
    if (!persistedPath && !hasCommandHistory) {
      host.removeIndexSession(engine.workspaceId, engine.sessionId);
    }
    outcome = "closed";
  } finally {
    for (const id of closingIds) host.gates.endClosing(id);
    const fields = { sessionId, stage: "teardown", outcome, elapsedMs: Date.now() - startedAt };
    if (outcome === "failed") diagnostics.warn("omp.session.close.failed", fields);
    else diagnostics.info("omp.session.close.completed", fields);
  }
}

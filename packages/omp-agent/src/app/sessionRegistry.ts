// SessionRegistry：会话引擎注册表（引擎生命周期 + 项目模式编排）。
// 本适配器进程 = 一个 workspace 的 agent 端点；冷会话来自 omp 会话存储的只读扫描。
// 项目模式（omp-project-mode.md）：project 网关可用时会话生命周期走共享 OMP 项目进程，
// 会话 ID 自创建起即为 OMP 稳定身份；网关不可用时保持「每会话一进程」旧拓扑。
// sessions-index / workspace-config topic 权威在 SessionIndexTopics。

import { createId, ompSessionIdOfFilePath } from "../domain/ids.js";
import { ConversationEngine } from "./conversationEngine.js";
import { deleteColdSession } from "./deleteColdSession.js";
import { deleteLoadedSession } from "./deleteLoadedSession.js";
import { listLegacySessions } from "./legacySessionList.js";
import { ProtocolError } from "./errors.js";
import type { HostGateway, OmpProjectGatewayPort, OmpProcessFactory, OmpStorePort } from "./ports.js";
import { controlSubagent, projectSubagentDirectory } from "./ompProjectDirectory.js";
import { createProjectSession, hydrateEngineFromCold as hydrateLifecycleCold, resumeProjectSession } from "./projectSessionLifecycle.js";
import type { ProjectSessionHost } from "./projectSessionLifecycle.js";
import { SessionIndexTopics } from "./sessionIndexTopics.js";

export interface RegistryDeps {
  ompFactory: OmpProcessFactory;
  store: OmpStorePort;
  gateway: HostGateway;
  /** 会话进程的 available_commands_update（omp 命令目录热更新）上报出口。 */
  onCommandsUpdate?: (commands: unknown) => void;
  /** 项目模式网关端口：可用时会话生命周期走共享 OMP 项目进程（不可用时整体回落旧拓扑）。 */
  project?: OmpProjectGatewayPort | null;
  /** 原始子代理帧出口（只读详情视图实时事件；项目模式有效）。 */
  forwardSubagentFrame?: (parentSessionId: string, frame: import("../domain/ompFrames.js").OmpSubagentFrame) => void;
}

export class SessionRegistry {
  private engines = new Map<string, ConversationEngine>();
  private primaryWorkspace: { id: string; path: string } | null = null;
  private readonly rekeyedEngineIds = new Set<string>();
  private readonly ompFactory: OmpProcessFactory;
  private readonly store: OmpStorePort;
  private readonly gateway: HostGateway;
  private readonly onCommandsUpdate: ((commands: unknown) => void) | undefined;
  private readonly project: OmpProjectGatewayPort | null | undefined;
  private readonly forwardSubagentFrame: ((parentSessionId: string, frame: import("../domain/ompFrames.js").OmpSubagentFrame) => void) | undefined;
  private readonly indexTopics: SessionIndexTopics;
  /** 子代理只读详情视图（serverApp 注入；getEngine 兜底解析 view 地址）。 */
  private subagentViews: { getEngine(viewId: string): ConversationEngine | null; ingestFrame(parentSessionId: string, frame: import("../domain/ompFrames.js").OmpSubagentFrame): void } | null = null;

  constructor(deps: RegistryDeps) {
    this.ompFactory = deps.ompFactory;
    this.store = deps.store;
    this.gateway = deps.gateway;
    this.onCommandsUpdate = deps.onCommandsUpdate;
    this.project = deps.project;
    this.forwardSubagentFrame = deps.forwardSubagentFrame;
    this.indexTopics = new SessionIndexTopics({
      gateway: deps.gateway,
      store: deps.store,
      getEngine: (sessionId) => this.getEngine(sessionId),
      primaryWorkspacePath: () => this.primaryWorkspace?.path ?? null,
      rekeyedEngineIds: this.rekeyedEngineIds,
    });
  }

  /** 项目模式能力事实（OMP 未提供项目模式时恒为 false，调用方回落旧拓扑）。 */
  async projectAvailable(): Promise<boolean> {
    return this.project ? this.project.available() : Promise.resolve(false);
  }

  /** 项目生命周期 host（projectSessionLifecycle 的回写接口）。 */
  private projectHost(): ProjectSessionHost {
    return {
      project: this.project!,
      store: this.store,
      gateway: this.gateway,
      engines: this.engines,
      onIndexChange: (changed) => this.upsertEngineSummary(changed),
      onCommandsUpdate: this.onCommandsUpdate,
      upsertEngineSummary: (engine, overrides) => this.upsertEngineSummary(engine, overrides),
      dispatchSubagentFrame: (sessionId, frame) => this.dispatchSubagentFrame(sessionId, frame),
    };
  }

  /** 引擎原始子代理帧出口：显式注入优先，缺省进入只读详情视图。 */
  private dispatchSubagentFrame(parentSessionId: string, frame: import("../domain/ompFrames.js").OmpSubagentFrame): void {
    if (this.forwardSubagentFrame) {
      this.forwardSubagentFrame(parentSessionId, frame);
      return;
    }
    this.subagentViews?.ingestFrame(parentSessionId, frame);
  }

  getEngine(sessionId: string): ConversationEngine | null {
    const byOmpFile = (engine: ConversationEngine) => {
      const file = engine.ompSessionFile;
      const id = file ? ompSessionIdOfFilePath(file) : null;
      return id === sessionId;
    };
    return this.engines.get(sessionId) ?? [...this.engines.values()].find(byOmpFile) ?? this.subagentViews?.getEngine(sessionId) ?? null;
  }
  requireEngine(sessionId: string): ConversationEngine {
    const engine = this.getEngine(sessionId);
    if (!engine) {
      throw new ProtocolError(-32004, `session unavailable: ${sessionId}`);
    }
    return engine;
  }

  setConnectionFlowState(connectionId: string, state: "saturated" | "drained" | "closed"): void {
    for (const engine of this.engines.values()) engine.setConnectionFlowState(connectionId, state);
  }

  async createSession(params: { sessionId?: string; workspaceId: string; workspacePath: string; title?: string }): Promise<ConversationEngine> {
    this.primaryWorkspace = { id: params.workspaceId, path: params.workspacePath };
    if (this.project && (await this.projectAvailable())) {
      return createProjectSession(this.projectHost(), params);
    }
    const sessionId = params.sessionId ?? createId("omp-session");
    const engine = new ConversationEngine({
      sessionId,
      workspaceId: params.workspaceId,
      workspacePath: params.workspacePath,
      ompFactory: this.ompFactory,
      gateway: this.gateway,
      onIndexChange: (changed) => this.upsertEngineSummary(changed),
      onCommandsUpdate: this.onCommandsUpdate,
      initialTitle: params.title,
    });
    this.engines.set(sessionId, engine);
    this.upsertEngineSummary(engine, { createdAt: Date.now(), lastActivityAt: Date.now() });
    return engine;
  }

  /** 恢复会话：冷历史行先行入投影；项目模式经 resume_session 加载，旧拓扑按 --resume 启动。 */
  async resumeSession(params: { sessionId: string; workspaceId: string; workspacePath: string }): Promise<ConversationEngine> {
    this.primaryWorkspace = { id: params.workspaceId, path: params.workspacePath };
    const existing = this.getEngine(params.sessionId);
    if (existing) {
      return existing;
    }
    if (this.project && (await this.projectAvailable())) {
      return resumeProjectSession(this.projectHost(), params);
    }
    const cold = this.store.findSession
      ? await this.store.findSession(params.workspacePath, params.sessionId)
      : (await this.store.listSessions(params.workspacePath)).find((session) => session.sessionId === params.sessionId);
    if (!cold) {
      // 未知会话必须显式拒绝；继续创建会凭空产出幽灵引擎（订阅 conversation/undefined
      // 实测会在侧栏多出一行永不收敛的空会话）。
      throw new ProtocolError(-32004, `session unavailable: ${params.sessionId}`);
    }
    const engine = new ConversationEngine({
      sessionId: params.sessionId,
      workspaceId: params.workspaceId,
      workspacePath: params.workspacePath,
      ompFactory: this.ompFactory,
      gateway: this.gateway,
      onIndexChange: (changed) => this.upsertEngineSummary(changed),
      onCommandsUpdate: this.onCommandsUpdate,
      resumeSessionPath: cold.sessionPath,
      initialTitle: cold.title ?? undefined,
    });
    // 旧拓扑冷行水合复用 lifecycle 的行投影（project 字段不会被旧路径触碰）。
    await hydrateLifecycleCold(this.projectHost(), engine, cold.sessionPath, cold.createdAt, cold.updatedAt);
    return engine;
  }

  async deleteSession(sessionId: string): Promise<void> {
    if (this.project && (await this.projectAvailable())) {
      // 项目模式：先卸载引擎（close_session），删除结果以 OMP 为准（文件由 OMP 删除）。
      const engine = this.getEngine(sessionId);
      if (engine) {
        await engine.dispose();
        this.engines.delete(engine.sessionId);
      }
      const outcome = await this.project.deleteSession(sessionId);
      if (!outcome.success) {
        throw new ProtocolError(-32004, outcome.error ?? `session deletion failed: ${sessionId}`);
      }
      const workspaceId = engine?.workspaceId ?? this.primaryWorkspace?.id;
      if (workspaceId) {
        this.indexTopics.removeSession(workspaceId, sessionId);
      }
      return;
    }
    const engine = this.getEngine(sessionId);
    if (engine) {
      const stableId = await deleteLoadedSession(engine, this.store, sessionId);
      this.engines.delete(engine.sessionId);
      for (const id of new Set([engine.sessionId, sessionId, stableId].filter((id): id is string => Boolean(id)))) {
        this.indexTopics.removeSession(engine.workspaceId, id);
      }
      this.rekeyedEngineIds.delete(engine.sessionId);
      return;
    }
    // 冷会话文件与索引同步删除；没有找到时保持明确的 unavailable 错误。
    if (
      await deleteColdSession({
        store: this.store,
        workspace: this.primaryWorkspace,
        sessionId,
        onDeleted: (workspaceId, id) => {
          this.indexTopics.removeSession(workspaceId, id);
        },
      })
    )
      return;
    throw new ProtocolError(-32004, `session unavailable: ${sessionId}`);
  }

  async closeSession(sessionId: string): Promise<void> {
    const engine = this.getEngine(sessionId);
    if (!engine) return;
    const persistedPath = engine.ompSessionFile;
    engine.projection.failAllTurns({ code: "session_closed", message: "session closed" });
    if (persistedPath) this.upsertEngineSummary(engine);
    await engine.dispose();
    this.engines.delete(engine.sessionId);
    if (!persistedPath) {
      this.indexTopics.removeSession(engine.workspaceId, engine.sessionId);
    }
  }

  upsertEngineSummary(engine: ConversationEngine, overrides?: { createdAt?: number; lastActivityAt?: number }): void {
    this.indexTopics.upsertEngineSummary(engine, overrides);
  }
  /** legacy session/list：冷会话 + 引擎会话合并（形状对齐 zcodeSessionInfoSchema）。 */
  async listLegacySessions(workspacePath: string, workspaceKey: string): Promise<Record<string, unknown>[]> {
    return listLegacySessions({ engines: this.engines.values(), rekeyedEngineIds: this.rekeyedEngineIds, store: this.store, workspacePath, workspaceKey });
  }

  resyncIndexOrConfig(subscriptionId: string, base: { logEpoch: string; seq: number } | null, forceSnapshot = false): { subscriptionId: string; mode: "snapshot" | "resume"; logEpoch: string } {
    return this.indexTopics.resyncIndexOrConfig(subscriptionId, base, forceSnapshot);
  }

  onProjectSessionsChanged(): Promise<void> {
    return this.indexTopics.onProjectSessionsChanged();
  }

  /** 项目模式子代理目录（omp-project-mode.md）：委托 OMP 持久目录 + 父会话投影合并。 */
  async projectSubagentDirectory(sessionId: string, offset: number): Promise<Record<string, unknown> | null> {
    return projectSubagentDirectory(
      {
        project: this.project,
        projectAvailable: () => this.projectAvailable(),
        projectionDirectory: (id) => {
          const engine = this.getEngine(id);
          return (engine?.projection.subagentDirectory(0) as Record<string, unknown> | undefined) ?? null;
        },
      },
      sessionId,
      offset,
    );
  }

  /** 项目模式子代理控制（control_subagent）：send_message/stop 的业务入口。 */
  async controlSubagent(sessionId: string, subagentId: string, action: "send_message" | "stop", message?: string): Promise<{ success: boolean; data?: unknown; error?: string }> {
    return controlSubagent({ project: this.project, projectAvailable: () => this.projectAvailable(), projectionDirectory: () => null }, sessionId, subagentId, action, message);
  }

  subscribeSessionsIndex(params: { workspaceId: string; workspacePath: string; connectionId: string }): Promise<{ subscriptionId: string; mode: "snapshot" | "resume"; logEpoch: string }> {
    return this.indexTopics.subscribeSessionsIndex(params);
  }
  subscribeWorkspaceConfig(params: { workspaceId: string; config: import("@zcode/shared/zcode-protocol-v4").WorkspaceConfigState }): {
    subscriptionId: string;
    mode: "snapshot" | "resume";
    logEpoch: string;
  } {
    return this.indexTopics.subscribeWorkspaceConfig(params);
  }
  updateWorkspaceConfig(workspaceId: string, config: import("@zcode/shared/zcode-protocol-v4").WorkspaceConfigState): void {
    this.indexTopics.updateWorkspaceConfig(workspaceId, config);
  }
  unsubscribe(topic: string, subscriptionId: string): void {
    this.indexTopics.unsubscribe(topic, subscriptionId);
  }

  setSubagentViews(views: { getEngine(viewId: string): ConversationEngine | null; ingestFrame(parentSessionId: string, frame: import("../domain/ompFrames.js").OmpSubagentFrame): void }): void {
    this.subagentViews = views;
  }

  async dispose(): Promise<void> {
    this.indexTopics.dispose();
    this.rekeyedEngineIds.clear();
    await Promise.all([...this.engines.values()].map((engine) => engine.dispose()));
    this.engines.clear();
  }
}

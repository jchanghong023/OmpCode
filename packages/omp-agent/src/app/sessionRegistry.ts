// SessionRegistry：会话引擎注册表（引擎生命周期 + 项目模式编排）。
// 本适配器进程 = 一个 workspace 的 agent 端点；冷会话来自 omp 会话存储的只读扫描。
// 项目模式（omp-project-mode.md）：project 网关可用时会话生命周期走共享 OMP 项目进程，
// 会话 ID 自创建起即为 OMP 稳定身份；网关不可用时保持「每会话一进程」旧拓扑。
// sessions-index / workspace-config topic 权威在 SessionIndexTopics。

import { createId, ompSessionIdOfFilePath } from "../domain/ids.js";
import { ConversationEngine } from "./conversationEngine.js";
import { listLegacySessions } from "./legacySessionList.js";
import { ProtocolError } from "./errors.js";
import type { HostGateway, OmpProjectAvailability, OmpProjectGatewayPort, OmpProcessFactory, OmpStorePort } from "./ports.js";
import { controlSubagent, projectSubagentDirectory } from "./ompProjectDirectory.js";
import { createProjectSession, hydrateEngineFromCold as hydrateLifecycleCold, resumeProjectSession } from "./projectSessionLifecycle.js";
import type { ProjectSessionHost } from "./projectSessionLifecycle.js";
import { SessionIndexTopics } from "./sessionIndexTopics.js";
import { closeSessionWith, deleteSessionWith, SessionRegistryGates, type SessionTeardownHost } from "./sessionRegistryGates.js";

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
  /** 并发 resume 去重：同 sessionId 只允许一次冷加载（见 resumeSession 修复说明）。 */
  private pendingResumes = new Map<string, Promise<ConversationEngine>>();
  /** 在途 createSession：resume/read 必须等其登记完成，否则会在注册空窗期构建冷引擎并覆盖活引擎（GUI 实测缺陷）。 */
  private pendingCreates = new Set<Promise<unknown>>();
  private readonly gates: SessionRegistryGates;
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
    this.gates = new SessionRegistryGates({
      engines: this.engines,
      getEngine: (sessionId) => this.getEngine(sessionId),
      removeIndexSession: (workspaceId, sessionId) => this.indexTopics.removeSession(workspaceId, sessionId),
    });
  }

  /** 项目模式能力事实（OMP 未提供项目模式时恒为 false，调用方回落旧拓扑）。 */
  async projectAvailable(): Promise<boolean> {
    return this.project ? this.project.available() : Promise.resolve(false);
  }

  /**
   * 项目模式三态可用性：网关未注入按「永久不支持」；否则透传网关判定。
   * 报错语义（永久 -32601 / 暂时 -32000）以本方法为准，拓扑回落仍用 projectAvailable。
   */
  async projectAvailability(): Promise<OmpProjectAvailability> {
    return this.project ? this.project.availability() : Promise.resolve("unsupported");
  }

  /**
   * 项目模式生命周期拓扑路由（修复 S1-2）：区分能力事实与瞬时失败。
   * - available → 项目拓扑；unsupported（旧核能力事实，永久）→ 返回 null 回落旧拓扑；
   * - unavailable（启动失败/退避窗口，含尚未判定）→ 抛 -32000 可重试错误。
   * 依据 rpc-ui-protocol §13.3「启动或协商失败展示原始可诊断原因，不自动为每个会话
   * 退回独立进程」：瞬时失败期间静默走旧拓扑会让同 workspace 混用两种会话拓扑。
   * 与 ompProjectMethods.requireProject 的三态语义一致；delete/rename 等读路径仍用
   * projectAvailable（布尔事实）维持现状。
   */
  private async projectRouteForLifecycle(): Promise<OmpProjectGatewayPort | null> {
    if (!this.project) return null;
    const availability = await this.projectAvailability();
    if (availability === "available") return this.project;
    if (availability === "unsupported") return null;
    throw new ProtocolError(-32000, "omp project process unavailable: session lifecycle");
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

  createSession(params: { sessionId?: string; workspaceId: string; workspacePath: string; title?: string }): Promise<ConversationEngine> {
    const create = this.createSessionInner(params);
    this.pendingCreates.add(create);
    return create.finally(() => {
      this.pendingCreates.delete(create);
    });
  }

  /** resume/read 到达早于 createSession 登记时的串行屏障（GUI 实测竞态，见 resumeSession）。 */
  private async settlePendingCreates(): Promise<void> {
    while (this.pendingCreates.size > 0) {
      // 屏障只需「等待在途 create 结束」，不传播其失败：create 的错误已由 create 调用方
      // 自己收到；Promise.all 会让无关会话的 resume/read 连坐拒绝（如预热创建被拒后，
      // 用户继续打开既有会话也被同一错误打断）。
      await Promise.allSettled(Array.from(this.pendingCreates));
    }
  }

  private async createSessionInner(params: { sessionId?: string; workspaceId: string; workspacePath: string; title?: string }): Promise<ConversationEngine> {
    this.primaryWorkspace = { id: params.workspaceId, path: params.workspacePath };
    // 修复（S1-2）：拓扑路由区分能力事实与瞬时失败——unavailable（启动失败/退避窗）
    // 抛 -32000 可重试错误，不再静默回落旧拓扑 spawn 单会话进程。
    if (await this.projectRouteForLifecycle()) {
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

  /**
   * 恢复会话：冷历史行先行入投影；项目模式经 resume_session 加载，旧拓扑按 --resume 启动。
   * 修复依据：同一会话的并发 resume（如会话创建 ACK 后宿主 readSession 与 task-index 回源
   * 同时到达）会各自构建冷引擎并相互覆盖注册表，把正在运行回合的活引擎顶成 0 行冷引擎，
   * 会话面板因此永久空白（GUI 实测缺陷）。此处按 sessionId 去重并发加载；加载完成后若
   * 已有更早登记的引擎（并发 createProjectSession 或先完成的加载），一律返回已登记引擎，
   * 丢弃本次冷恢复结果（冷恢复引擎惰性挂载、无子进程，丢弃无副作用）。
   */
  async resumeSession(params: { sessionId: string; workspaceId: string; workspacePath: string }): Promise<ConversationEngine> {
    this.primaryWorkspace = { id: params.workspaceId, path: params.workspacePath };
    await this.settlePendingCreates();
    const existing = this.getEngine(params.sessionId);
    if (existing) {
      return existing;
    }
    const pending = this.pendingResumes.get(params.sessionId);
    if (pending) {
      return pending;
    }
    const load = this.loadSessionForResume(params).finally(() => {
      this.pendingResumes.delete(params.sessionId);
    });
    this.pendingResumes.set(params.sessionId, load);
    return load;
  }

  private async loadSessionForResume(params: { sessionId: string; workspaceId: string; workspacePath: string }): Promise<ConversationEngine> {
    // 排队期间可能已有并发加载/create 完成：再查一次，绝不覆盖已登记引擎。
    const raced = this.getEngine(params.sessionId);
    if (raced) {
      return raced;
    }
    // 修复（S1-2）：同 createSession——unavailable 抛 -32000 可重试，不静默回落旧拓扑。
    if (await this.projectRouteForLifecycle()) {
      const engine = await resumeProjectSession(this.projectHost(), params);
      // 修复（S2-2/S7-4）：登记统一走登记门（墓碑 + winner 判定）；hydrateEngineFromCold
      // 不再自行登记，原「先覆盖注册表再检查」的死代码检查由此恢复实效。
      return this.gates.settleColdHydration(params.sessionId, engine);
    }
    const cold = this.store.findSession
      ? await this.store.findSession(params.workspacePath, params.sessionId)
      : (await this.store.listSessions(params.workspacePath)).find((session) => session.sessionId === params.sessionId);
    if (!cold) {
      // 未知会话必须显式拒绝；继续创建会凭空产出幽灵引擎（订阅 conversation/undefined
      // 实测会在侧栏多出一行永不收敛的空会话）。
      throw new ProtocolError(-32004, `session unavailable: ${params.sessionId}`);
    }
    const racedAfterCold = this.getEngine(params.sessionId);
    if (racedAfterCold) {
      return racedAfterCold;
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
    // 旧拓扑冷行水合复用 lifecycle 的行投影（project 字段不会被旧路径触碰）；
    // 修复（S2-2/S7-4）：水合不再自行登记，登记统一走登记门。
    await hydrateLifecycleCold(this.projectHost(), engine, cold.sessionPath, cold.createdAt, cold.updatedAt);
    return this.gates.settleColdHydration(params.sessionId, engine);
  }

  async deleteSession(sessionId: string): Promise<void> {
    await deleteSessionWith(this.teardownHost(), sessionId);
  }

  async closeSession(sessionId: string): Promise<void> {
    await closeSessionWith(this.teardownHost(), sessionId);
  }

  private teardownHost(): SessionTeardownHost {
    return {
      gates: this.gates,
      project: this.project,
      projectAvailable: () => this.projectAvailable(),
      getEngine: (sessionId) => this.getEngine(sessionId),
      dropEngine: (sessionId) => this.engines.delete(sessionId),
      removeIndexSession: (workspaceId, sessionId) => this.indexTopics.removeSession(workspaceId, sessionId),
      store: this.store,
      primaryWorkspace: () => this.primaryWorkspace,
      forgetRekeyed: (sessionId) => this.rekeyedEngineIds.delete(sessionId),
      upsertEngineSummary: (engine) => this.upsertEngineSummary(engine),
    };
  }

  /**
   * 项目模式冷会话（无引擎）改名：真实 omp 的 rename_session 支持未加载（H）会话按稳定 ID
   * 改名（rpc-project-sessions.rename：locateListed 定位文件后原地改标题槽），适配器此前只走
   * engine.rename，冷会话改名被 -32004 拒。成功后同步本地 sessions-index 标题——与
   * engine.rename 的 notifyIndexChange 等价实现：omp 已把新标题落盘，先移除旧摘要再触发冷会话
   * 重扫（onProjectSessionsChanged 只补缺，不刷新已存在行），重扫即写入新标题。
   * 项目模式不可用（旧核）返回 unsupported，调用方维持既有错误语义。
   */
  async renameColdSession(sessionId: string, title: string): Promise<{ ok: true } | { ok: false; unsupported: boolean; error?: string; code?: string }> {
    if (!this.project || !(await this.projectAvailable())) {
      return { ok: false, unsupported: true };
    }
    const outcome = await this.project.sendProject({ type: "rename_session", sessionId, name: title });
    if (!outcome.success) {
      return { ok: false, unsupported: false, error: outcome.error, code: outcome.code };
    }
    const workspaceId = this.primaryWorkspace?.id;
    if (workspaceId && this.indexTopics.removeSession(workspaceId, sessionId)) {
      await this.indexTopics.onProjectSessionsChanged();
    }
    return { ok: true };
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
  async projectSubagentDirectory(sessionId: string, offset: number, limit?: number): Promise<Record<string, unknown> | null> {
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
      limit,
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
    // 修复（S7-4）：先置 disposing 作废在途 create/resume 的登记（登记门检查），
    // 再销毁引擎——销毁期间/之后完成的冷恢复不得把引擎重新登记进已清空的注册表。
    this.gates.beginDispose();
    this.indexTopics.dispose();
    this.rekeyedEngineIds.clear();
    await Promise.all([...this.engines.values()].map((engine) => engine.dispose()));
    this.engines.clear();
  }
}

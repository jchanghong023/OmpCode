// 子代理只读详情视图（omp-core-integration.md）：合成 childSessionId 复用引擎的投影/订阅；
// 行来自父会话进程 get_subagent_messages（fromByte/nextByte 续读，上游无 hasMore，以游标
// 不再推进为读尽）。实时更新 = subagent_event 尾随节流（≥800ms）触发「记录重读 + mergeRows
// 幂等合并」；reset=true 按同一订阅的删除屏障替换视图行（S6-4）。lifecycle 终态后
// 停止重读调度。查看不触发模型执行、不产生控制副作用。

import { ConversationEngine } from "./conversationEngine.js";
import { rowsFromOmpEntries } from "../domain/coldHistory.js";
import { readPersistedSubagentEntries, recordUnavailableMarkerRow } from "./coldHydration.js";
import { TrailingThrottle } from "./trailingThrottle.js";
import {
  buildOmpSubagentViewId,
  ompSessionEventFrameSchema,
  parseOmpSubagentViewId,
} from "../domain/ompFrames.js";
import type { OmpSubagentFrame } from "../domain/ompFrames.js";
import type { HostGateway, OmpStorePort } from "./ports.js";
import { readSubagentRecord } from "./subagentControl.js";

/** subagent_event → 重读的尾随节流窗口：事件风暴合并为一次重读，末事件由尾沿保证必达。 */
const REFRESH_THROTTLE_MS = 800;

/** 单次 hydrate/refresh 的续读窗口数安全上限：超出暂停续读，剩余由下一事件触发续读。 */
const SUBAGENT_WINDOW_READ_CAP = 8;

/** 视图读侧状态：窗口游标 + 已累积记录 + 不可用事实（行重建的本地事实源）。 */
interface ViewReadState {
  nextByte: number;
  entries: unknown[];
  /** 成功响应但记录不可用（不存在/已清理）。 */
  unavailable: boolean;
  /** 本次 readWindows 至少一窗出现 reset=true（记录被截断/重写）；rebuildRows 消费后清零。 */
  resetSeen: boolean;
}

/** 单次续读的结果：驱动调用方决定行重建与提示行。 */
type WindowReadResult = "complete" | "capped" | "unavailable";

/** 单个视图的实时重读状态：throttle 调度、refreshing 单飞、rerun 重叠补跑、terminated 停表。 */
interface ViewRefreshState {
  throttle: TrailingThrottle;
  refreshing: Promise<void> | null;
  rerun: boolean;
  terminated: boolean;
}

/** app 层无 logger 依赖；与 conversationEngine.engineWarn 同格式写 stderr。 */
const viewWarn = (message: string, details?: Record<string, unknown>): void => {
  process.stderr
    .write(`${JSON.stringify({ ts: new Date().toISOString(), level: "warn", scope: "omp-agent", message, ...details })}
`);
};

export interface SubagentViewDeps {
  registry: SubagentViewRegistry;
  gateway: HostGateway;
  workspaceId: string;
  workspacePath: string;
  store?: Pick<OmpStorePort, "readSessionEntries" | "readSubagentEntries">;
}

/** 视图所需的注册表面：SessionRegistry 的结构化窄视图。 */
interface SubagentViewRegistry {
  getEngine(sessionId: string): ConversationEngine | null;
  resumeSession(params: {
    sessionId: string;
    workspaceId: string;
    workspacePath: string;
  }): Promise<ConversationEngine>;
}

export class SubagentViewStore {
  private readonly views = new Map<string, ConversationEngine>();
  private readonly hydrating = new Map<string, Promise<void>>();
  private readonly refreshStates = new Map<string, ViewRefreshState>();
  private readonly readStates = new Map<string, ViewReadState>();
  private readonly deps: SubagentViewDeps;
  private disposed = false;

  constructor(deps: SubagentViewDeps) {
    this.deps = deps;
  }

  getEngine(viewId: string): ConversationEngine | null {
    return this.views.get(viewId) ?? null;
  }

  /** 视图读侧状态（窗口游标 + 累积记录）；随视图惰性建立。 */
  private viewReadState(viewId: string): ViewReadState {
    let state = this.readStates.get(viewId);
    if (!state) {
      state = {
        nextByte: 0,
        entries: [],
        unavailable: false,
        resetSeen: false,
      };
      this.readStates.set(viewId, state);
    }
    return state;
  }

  /** 父会话引擎定位：已登记引擎优先；冷父会话按目录身份冷恢复（记录读取会现场拉起 --resume 进程）。 */
  private async parentEngine(parentSessionId: string): Promise<ConversationEngine | null> {
    const existing = this.deps.registry.getEngine(parentSessionId);
    if (existing) return existing;
    return this.deps.registry
      .resumeSession({
        sessionId: parentSessionId,
        workspaceId: this.deps.workspaceId,
        workspacePath: this.deps.workspacePath,
      })
      .catch(() => null);
  }

  /**
   * 游标续读：从视图游标循环调用父会话进程的 get_subagent_messages（{subagentId, fromByte}），
   * 追加进本地累积；nextByte 不再推进（或无 nextByte 的旧形状一次性全量）即读尽。安全上限内
   * 未读尽则返回 capped（剩余留待下一事件续读）；进程就绪失败/命令失败返回 unavailable。
   */
  private async readWindows(
    viewId: string,
    parentSessionId: string,
    subagentId: string,
  ): Promise<WindowReadResult> {
    const state = this.viewReadState(viewId);
    state.unavailable = false;
    state.resetSeen = false;
    const engine = await this.parentEngine(parentSessionId);
    if (!engine) return "unavailable";
    for (let window = 0; window < SUBAGENT_WINDOW_READ_CAP; window += 1) {
      const outcome = await readSubagentRecord(
        engine.subagentProcessHost(),
        subagentId,
        state.nextByte,
      );
      if (outcome === null) {
        // 进程就绪失败：按传输层异常语义上抛——调用方（ensureHydrated/refreshView）捕获后
        // 保持当前内容（G7），不插「记录不可用」提示行。
        throw new Error(`parent session process unavailable: ${parentSessionId}`);
      }
      if (!outcome.success) {
        const entries = await readPersistedSubagentEntries(
          engine.ompSessionFile,
          this.deps.store,
          subagentId,
          outcome.error,
        );
        if (entries) {
          if (entries.length === 0) return "unavailable";
          state.resetSeen ||= state.entries.length > 0;
          state.entries = entries;
          state.nextByte = 0;
          return "complete";
        }
        return "unavailable";
      }
      const record =
        typeof outcome.data === "object" && outcome.data !== null
          ? (outcome.data as {
              entries?: unknown;
              nextByte?: unknown;
              reset?: unknown;
            })
          : {};
      if (!Array.isArray(record.entries)) {
        // 形状异常按读尽处理：保持当前内容，不向订阅链路抛错（G7 同语义）。
        return "complete";
      }
      if (typeof record.nextByte !== "number") {
        // 无 nextByte 的旧形状：一次性全量响应整体替换（防重复追加）。
        state.entries = [...record.entries];
        return "complete";
      }
      // reset：记录被截断/重写（游标越界归零），丢弃旧累积从当前窗口重建，
      // 避免把重写后的部分记录拼在旧记录之后。resetSeen 交给 rebuildRows 切换替换语义
      // （S6-4：mergeRows 只增不删，投影残留陈旧行必须清除）。
      if (record.reset === true) {
        state.entries = [];
        state.resetSeen = true;
      }
      const advanced = record.nextByte > state.nextByte;
      state.entries.push(...record.entries);
      state.nextByte = record.nextByte;
      // 上游游标单调推进（oh-my-pi rpc-subagents.ts nextByte 语义）：不再推进即读尽
      // （fromByte 之后无更多记录时返回空 entries 且 nextByte 原样）。
      if (!advanced) return "complete";
    }
    return "capped";
  }

  /** reset 使用同一视图投影的 row.removed 屏障；保留订阅身份，不冻结已打开详情。 */
  private rebuildRows(viewId: string, merge: boolean): void {
    const state = this.readStates.get(viewId);
    if (!state || this.disposed) return;
    const rows = rowsFromOmpEntries(state.entries, new Map());
    if (merge && state.resetSeen) {
      state.resetSeen = false;
      this.views.get(viewId)?.replaceHydratedRows(rows);
      return;
    }
    const engine = this.views.get(viewId);
    if (!engine) return;
    engine.hydrateRows(rows, merge);
  }

  /** 合成视图引擎（acquire 与 S6-4 reset 重建共用同一构造）。 */
  private createViewEngine(viewId: string): ConversationEngine {
    return new ConversationEngine({
      sessionId: viewId,
      workspaceId: this.deps.workspaceId,
      workspacePath: this.deps.workspacePath,
      gateway: this.deps.gateway,
      onIndexChange: () => {},
    });
  }

  /** 订阅 conversation/omp-subagent:<id>@<parent>：先水合历史行，再返回视图引擎。 */
  async acquire(viewId: string): Promise<ConversationEngine | null> {
    if (this.disposed) return null;
    const parsed = parseOmpSubagentViewId(viewId);
    if (!parsed) return null;
    const existing = this.views.get(viewId);
    if (existing) {
      await this.hydrating.get(viewId);
      return this.views.get(viewId) ?? null;
    }
    const engine = this.createViewEngine(viewId);
    this.views.set(viewId, engine);
    // 历史行先行入投影（订阅快照即含已保存记录）；实时增量由 ingestFrame 触发重读合并。
    await this.ensureHydrated(viewId, parsed.parentSessionId, parsed.subagentId);
    return this.disposed ? null : (this.views.get(viewId) ?? null);
  }

  /**
   * 首次水合（hydrating 去重并发订阅）。G7：命令失败/传输层 reject（超时/EPIPE）与记录
   * 不可用同语义——视图保持当前内容（空或已水合），acquire 不 reject，订阅不得因此 -32603；
   * 后续 subagent_event 仍会触发重读自愈。记录不可用（不存在/已清理）时插入「记录不可用」
   * 提示行（Z14：缺失内容要有明确提示），不再静默返回空视图；已有内容保持不变。
   */
  private ensureHydrated(
    viewId: string,
    parentSessionId: string,
    subagentId: string,
  ): Promise<void> {
    let pending = this.hydrating.get(viewId);
    if (pending) return pending;
    pending = (async () => {
      try {
        const result = await this.readWindows(viewId, parentSessionId, subagentId);
        const engine = this.views.get(viewId);
        if (!engine) return;
        if (result === "unavailable") {
          if (engine.projection.rowsRange(undefined, 1).rows.length === 0) {
            engine.hydrateRows([recordUnavailableMarkerRow(1)]);
          }
          return;
        }
        this.rebuildRows(viewId, false);
      } catch {
        // 传输层失败同语义：不向订阅链路抛错（G7）。
      }
    })().finally(() => {
      this.hydrating.delete(viewId);
    });
    this.hydrating.set(viewId, pending);
    return pending;
  }

  /** 父会话子代理帧出口：subagent_event 触发详情视图重读；lifecycle started 重武装、终态停表。 */
  ingestFrame(parentSessionId: string, frame: OmpSubagentFrame): void {
    // subagent_progress 是父会话过程卡片数据，不进详情视图（payload 无 id，无法归属视图）。
    if (frame.type === "subagent_progress") return;
    const viewId = buildOmpSubagentViewId(parentSessionId, frame.payload.id);
    if (frame.type === "subagent_lifecycle") {
      // started 重新允许调度（同一 subagentId 的新一轮运行）；终态补读一次后停止调度。
      if (frame.payload.status === "started") this.rearmView(viewId);
      else this.finishView(viewId);
      return;
    }
    const view = this.views.get(viewId);
    if (!view) return;
    const parsed = ompSessionEventFrameSchema.safeParse(frame.payload.event);
    if (!parsed.success) return;
    // 唤醒后 agent_start/user message_start 会建立活动轮；把整条事件送进 projector
    // 会与记录补读双写同一工具。详情只转发用量/错误状态，所有行由补读唯一持有。
    // 防御（A9）：单帧投影异常跳过，不断事件流（与主会话 handleOmpEvent 同理）。
    try {
      const event = parsed.data;
      if (
        event.type === "notice" ||
        (event.type === "message_end" && event.message.role === "assistant") ||
        event.type === "thinking_level_changed"
      )
        view.projector.handleEvent(event);
    } catch (error) {
      viewWarn("omp view event projection failed", {
        type: parsed.data.type,
        error: error instanceof Error ? error.message : String(error),
      });
    }
    view.scheduleFlush();
    const state = this.viewState(viewId);
    if (state && !state.terminated) state.throttle.ping();
  }

  /** 惰性建立视图重读状态（仅对已打开视图）。 */
  private viewState(viewId: string): ViewRefreshState | null {
    if (!this.views.has(viewId)) return null;
    let state = this.refreshStates.get(viewId);
    if (!state) {
      state = {
        throttle: new TrailingThrottle(REFRESH_THROTTLE_MS, () => void this.refreshView(viewId)),
        refreshing: null,
        rerun: false,
        terminated: false,
      };
      this.refreshStates.set(viewId, state);
    }
    return state;
  }

  /** lifecycle started：重建节流器并重新允许调度（终态后同一 subagentId 的新运行）。 */
  private rearmView(viewId: string): void {
    const state = this.refreshStates.get(viewId);
    if (!state) return;
    state.terminated = false;
    state.throttle.dispose();
    state.throttle = new TrailingThrottle(REFRESH_THROTTLE_MS, () => void this.refreshView(viewId));
  }

  /** 运行结束：补一次重读收尾（捕获节流窗口内最后一批记录），随后停止该视图的重读调度。 */
  private finishView(viewId: string): void {
    const state = this.viewState(viewId);
    if (!state || state.terminated) return;
    state.terminated = true;
    state.throttle.dispose();
    if (state.refreshing) state.rerun = true;
    else void this.refreshView(viewId);
  }

  /**
   * 单飞重读：与「在途」的首次水合串行化（避免对同一 rowId 先 append 再 hydrate 双写产生重复
   * 行），再按视图游标续读并幂等合并（merge 带增量，恢复路径对订阅端可见）；水合已完成
   * （含传输失败）时直接续读——已累积记录不重复请求。重叠触发只记 rerun，完成后补跑一次保证
   * 收敛到最新记录；传输失败保持当前内容，不抛出。记录不可用且视图尚为空时补「记录不可用」
   * 提示行（Z14），已有内容保持不变。
   */
  private async refreshView(viewId: string): Promise<void> {
    const parsed = parseOmpSubagentViewId(viewId);
    const state = this.refreshStates.get(viewId);
    if (!parsed || !state) return;
    if (state.refreshing) {
      state.rerun = true;
      return;
    }
    state.refreshing = (async () => {
      try {
        await this.hydrating.get(viewId);
        const result = await this.readWindows(viewId, parsed.parentSessionId, parsed.subagentId);
        const engine = this.views.get(viewId);
        if (result === "unavailable") {
          if (engine && engine.projection.rowsRange(undefined, 1).rows.length === 0) {
            engine.hydrateRows([recordUnavailableMarkerRow(1)], true);
          }
          return;
        }
        this.rebuildRows(viewId, true);
      } catch {
        // 传输层失败：保持当前内容；下一事件或 rerun 会再次尝试。
      }
    })().finally(() => {
      state.refreshing = null;
      if (state.rerun && !this.disposed) {
        state.rerun = false;
        void this.refreshView(viewId);
      }
    });
    await state.refreshing;
  }

  dispose(): void {
    this.disposed = true;
    for (const view of this.views.values()) void view.dispose();
    this.views.clear();
    this.readStates.clear();
    for (const state of this.refreshStates.values()) state.throttle.dispose();
    this.refreshStates.clear();
  }
}

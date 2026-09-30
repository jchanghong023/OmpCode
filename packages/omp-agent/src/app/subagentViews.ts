// 子代理只读详情视图（omp-project-mode.md）：合成 childSessionId（编码父会话与子代理身份）
// 复用 ConversationEngine 的投影/订阅发布；行来自 OMP get_subagent_messages 的已保存记录。
// 实时更新（事件驱动重水合）：ingestFrame 收到该子代理的 subagent_event 时按 ≥800ms 尾随节流
// 触发「全量重读 + mergeRows 幂等合并」（同 rowId 内容变化才 upsert、新行 append），订阅端实时
// 增长且不出现重复行。为何全量重读而非 fromByte 增量：rowId 由 rowsFromOmpEntries 对完整记录
// 确定性重建，尾部局部 entries 既无法对齐全量行号，也缺早前轮次/工具行上下文（toolResult 会
// 回填更早的 toolCall 行）；详情视图记录有界、单视图低频，全量成本可接受。lifecycle 终态后
// 停止重读调度（终态帧补读一次收尾）。查看不触发模型执行、不产生控制副作用。

import { ConversationEngine } from "./conversationEngine.js";
import { rowsFromOmpEntries } from "../domain/coldHistory.js";
import { TrailingThrottle } from "./trailingThrottle.js";
import {
  buildOmpSubagentViewId,
  ompProjectSubagentMessagesSchema,
  parseOmpSubagentViewId,
} from "../domain/ompProjectFrames.js";
import { ompSessionEventFrameSchema } from "../domain/ompFrames.js";
import type { OmpSubagentFrame } from "../domain/ompFrames.js";
import type { HostGateway, OmpProjectGatewayPort, OmpStorePort } from "./ports.js";
import type { SessionRegistry } from "./sessionRegistry.js";

/** subagent_event → 重读的尾随节流窗口：事件风暴合并为一次重读，末事件由尾沿保证必达。 */
const REFRESH_THROTTLE_MS = 800;

/** 单个视图的实时重读状态：throttle 调度、refreshing 单飞、rerun 重叠补跑、terminated 停表。 */
interface ViewRefreshState {
  throttle: TrailingThrottle;
  refreshing: Promise<void> | null;
  rerun: boolean;
  terminated: boolean;
}

export interface SubagentViewDeps {
  registry: SessionRegistry;
  project: OmpProjectGatewayPort;
  store: OmpStorePort;
  gateway: HostGateway;
  workspaceId: string;
  workspacePath: string;
}

export class SubagentViewStore {
  private readonly views = new Map<string, ConversationEngine>();
  private readonly hydrating = new Map<string, Promise<void>>();
  private readonly refreshStates = new Map<string, ViewRefreshState>();
  private readonly deps: SubagentViewDeps;

  constructor(deps: SubagentViewDeps) {
    this.deps = deps;
  }

  getEngine(viewId: string): ConversationEngine | null {
    return this.views.get(viewId) ?? null;
  }

  /** 订阅 conversation/omp-subagent:<id>@<parent>：先水合历史行，再返回视图引擎。 */
  async acquire(viewId: string): Promise<ConversationEngine | null> {
    const parsed = parseOmpSubagentViewId(viewId);
    if (!parsed) return null;
    const existing = this.views.get(viewId);
    if (existing) {
      return existing;
    }
    const engine = new ConversationEngine({
      sessionId: viewId,
      workspaceId: this.deps.workspaceId,
      workspacePath: this.deps.workspacePath,
      gateway: this.deps.gateway,
      onIndexChange: () => {},
    });
    this.views.set(viewId, engine);
    // 历史行先行入投影（订阅快照即含已保存记录）；实时增量由 ingestFrame 触发重读合并。
    await this.ensureHydrated(viewId, parsed.parentSessionId, parsed.subagentId);
    return engine;
  }

  /**
   * 首次水合（hydrating 去重并发订阅）。G7：sendProject 传输层 reject（超时/EPIPE）与记录
   * 不可用同语义——视图保持当前内容（空或已水合），acquire 不 reject，订阅不得因此 -32603；
   * 后续 subagent_event 仍会触发重读自愈。
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
        const outcome = await this.deps.project.sendProject({
          type: "get_subagent_messages",
          sessionId: parentSessionId,
          subagentId,
        });
        if (!outcome.success) {
          // 记录不可用（不存在/已清理）：视图保持空投影，不伪造内容。
          return;
        }
        const parsed = ompProjectSubagentMessagesSchema.safeParse(outcome.data);
        if (!parsed.success || !Array.isArray(parsed.data.entries)) return;
        this.views.get(viewId)?.hydrateRows(rowsFromOmpEntries(parsed.data.entries, new Map()));
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
    // 事件在视图内无活动轮可投影（appendStreamDelta/upsertToolCall 均以 turn 为前置），
    // 行的唯一实时来源是「事件触发的记录重读」；状态面（usage/错误事实）保持既有转发。
    view.applyViewEvent(parsed.data);
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
    const state = this.refreshStates.get(viewId);
    if (!state || state.terminated) return;
    state.terminated = true;
    state.throttle.dispose();
    if (state.refreshing) state.rerun = true;
    else void this.refreshView(viewId);
  }

  /**
   * 单飞重读：与「在途」的首次水合串行化（避免对同一 rowId 先 append 再 hydrate 双写产生重复
   * 行），再全量读取并幂等合并；水合已完成（含传输失败）时直接重读——mergeRows 带增量，恢复
   * 路径对订阅端可见。重叠触发只记 rerun，完成后补跑一次保证收敛到最新记录；传输失败保持当前
   * 内容，不抛出。
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
        const outcome = await this.deps.project.sendProject({
          type: "get_subagent_messages",
          sessionId: parsed.parentSessionId,
          subagentId: parsed.subagentId,
        });
        if (!outcome.success) return;
        const messages = ompProjectSubagentMessagesSchema.safeParse(outcome.data);
        if (!messages.success || !Array.isArray(messages.data.entries)) return;
        this.views
          .get(viewId)
          ?.hydrateRows(rowsFromOmpEntries(messages.data.entries, new Map()), true);
      } catch {
        // 传输层失败：保持当前内容；下一事件或 rerun 会再次尝试。
      }
    })().finally(() => {
      state.refreshing = null;
      if (state.rerun) {
        state.rerun = false;
        void this.refreshView(viewId);
      }
    });
    await state.refreshing;
  }
}

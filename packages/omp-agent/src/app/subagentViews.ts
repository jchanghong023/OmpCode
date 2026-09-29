// 子代理只读详情视图（omp-project-mode.md）：合成 childSessionId（编码父会话与子代理身份）
// 复用 ConversationEngine 的投影/订阅发布；行来自 OMP get_subagent_messages 的已保存记录，
// 实时更新来自父会话转发的 subagent_event 帧。查看不触发模型执行、不产生控制副作用。

import { ConversationEngine } from "./conversationEngine.js";
import { rowsFromOmpEntries } from "../domain/coldHistory.js";
import {
  buildOmpSubagentViewId,
  ompProjectSubagentMessagesSchema,
  parseOmpSubagentViewId,
} from "../domain/ompProjectFrames.js";
import { ompSessionEventFrameSchema } from "../domain/ompFrames.js";
import type { OmpSubagentFrame } from "../domain/ompFrames.js";
import type { HostGateway, OmpProjectGatewayPort, OmpStorePort } from "./ports.js";
import type { SessionRegistry } from "./sessionRegistry.js";

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
    // 历史行先行入投影（订阅快照即含已保存记录）；实时增量走 ingestFrame。
    await this.ensureHydrated(viewId, parsed.parentSessionId, parsed.subagentId);
    return engine;
  }

  /** 历史行只读一次（记录事实不随重读变化；实时增量走 ingestFrame）。 */
  private ensureHydrated(
    viewId: string,
    parentSessionId: string,
    subagentId: string,
  ): Promise<void> {
    let pending = this.hydrating.get(viewId);
    if (pending) return pending;
    pending = (async () => {
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
      const rows = rowsFromOmpEntries(parsed.data.entries, new Map());
      const engine = this.views.get(viewId);
      if (engine) engine.hydrateRows(rows);
    })().finally(() => {
      this.hydrating.delete(viewId);
    });
    this.hydrating.set(viewId, pending);
    return pending;
  }

  /** 父会话子代理帧出口：subagent_event 喂给打开中的详情视图（事件级订阅的实时源）。 */
  ingestFrame(parentSessionId: string, frame: OmpSubagentFrame): void {
    if (frame.type !== "subagent_event") return;
    const view = this.views.get(buildOmpSubagentViewId(parentSessionId, frame.payload.id));
    if (!view) return;
    const parsed = ompSessionEventFrameSchema.safeParse(frame.payload.event);
    if (!parsed.success) return;
    view.applyViewEvent(parsed.data);
  }
}

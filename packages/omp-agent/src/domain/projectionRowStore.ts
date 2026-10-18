// 投影行存储（从 conversationProjection 拆出；架构 maxFileLines=400）。
// 单一 owner：行表、行号序列、流式文本暂存与工具行索引；只提供行级读写与冷恢复/重水合入口，
// 不持有会话状态——行变更经 host 发布 pending delta / state patch，视图归属复用子代理投影。

import type {
  ConversationDelta,
  ConversationRow,
  StatePatch,
  ToolCallRow,
} from "@zcode/shared/zcode-protocol-v4";
import type { OmpSubagentProjection } from "./ompSubagentDirectory.js";
import { mergeProjectionRows } from "./projectionRowMerge.js";
import { materializeStreamTextRow } from "./projectionStreamText.js";
import { ProjectionToolCallIndex } from "./projectionToolCallIndex.js";
import { ompTodoState } from "./ompTodoPlan.js";

/** 行写出口由 ConversationProjection 提供：pending delta、state patch 与子代理视图归属。 */
export interface ProjectionRowStoreHost {
  pushPending(delta: ConversationDelta): void;
  patchState(patch: StatePatch): void;
  subagents(): OmpSubagentProjection;
}

export class ProjectionRowStore {
  readonly rows = new Map<number, ConversationRow>();
  readonly rowIds: number[] = [];
  readonly pendingStreamTextByRowId = new Map<number, string[]>();
  private readonly toolCallIndex = new ProjectionToolCallIndex();
  private nextRowId = 1;

  constructor(private readonly host: ProjectionRowStoreHost) {}

  /** 行号分配：新行按投影内单调递增发放。 */
  allocateRowId(): number {
    return this.nextRowId++;
  }

  rowAt(rowId: number): ConversationRow | undefined {
    return this.rows.get(rowId);
  }

  /** 权限卡锚定：按 omp toolCallId 找最近一条工具行（找不到返回 null）。 */
  rowIdOfToolCall(toolCallId: string): number | null {
    return this.toolCallIndex.latestRowId(toolCallId);
  }

  /** 工具行更新的锚点：同 toolCallId 的首行（未记录返回 undefined）。 */
  firstToolCallRow(toolCallId: string): ToolCallRow | undefined {
    return this.toolCallIndex.firstRow(toolCallId, this.rows);
  }

  /** 快照/范围读面共用：流式文本按需合并后再交付，避免逐 chunk 复制整段正文。 */
  materialize(rowId: number): ConversationRow | undefined {
    return materializeStreamTextRow(this.rows, this.pendingStreamTextByRowId, rowId);
  }

  append(row: ConversationRow): void {
    this.rows.set(row.rowId, row);
    this.rowIds.push(row.rowId);
    this.toolCallIndex.append(row);
    this.host.pushPending({ op: "row.appended", row });
    const plan = ompTodoState(row);
    if (plan !== undefined) this.host.patchState({ plan });
  }

  /** 水合/合并行自带稳定 rowId：只抬升分配下界，不回收编号。 */
  claimRowId(rowId: number): void {
    this.nextRowId = Math.max(this.nextRowId, rowId + 1);
  }

  upsert(row: ConversationRow): void {
    // Bug 根因：首次工具/子代理行误发 row.upserted，桌面增量客户端对未知 rowId
    // 按协议忽略，导致运行态只有状态计数、没有可见记录；首次必须 append。
    const previous = this.rows.get(row.rowId);
    const isNew = previous === undefined;
    this.rows.set(row.rowId, row);
    if (isNew) {
      this.rowIds.push(row.rowId);
    }
    this.toolCallIndex.upsert(previous, row, this.rows, this.rowIds);
    this.host.pushPending(isNew ? { op: "row.appended", row } : { op: "row.upserted", row });
    const plan = ompTodoState(row);
    if (plan !== undefined) this.host.patchState({ plan });
  }

  /** 冷恢复：历史行直接入库（不产生 delta）；返回视图归属后的行，供 subagents/plan 水合复用。 */
  hydrate(rows: ConversationRow[]): ConversationRow[] {
    const viewRows = this.viewRows(rows);
    for (const row of viewRows) {
      this.rows.set(row.rowId, row);
      this.rowIds.push(row.rowId);
      this.claimRowId(row.rowId);
    }
    this.rowIds.sort((a, b) => a - b);
    this.toolCallIndex.rebuild(this.rows, this.rowIds);
    return viewRows;
  }

  /** 只读详情视图的事件驱动重水合：全量重读行幂等合并（新行 append、同 rowId 内容变化才 upsert），订阅端实时增长且无重复行。 */
  merge(rows: ConversationRow[]): void {
    mergeProjectionRows(
      {
        rows: this.rows,
        claimRowId: (rowId) => this.claimRowId(rowId),
        appendRow: (row) => this.append(row),
        upsertRow: (row) => this.upsert(row),
      },
      this.viewRows(rows),
    );
  }

  /** 只读记录重写：同一 owner 发删除屏障再追加，实时/恢复订阅看到相同替换结果；返回视图归属后的行。 */
  replace(rows: ConversationRow[]): ConversationRow[] {
    const viewRows = this.viewRows(rows);
    if (this.rowIds.length > 0)
      this.host.pushPending({ op: "row.removed", fromRowId: this.rowIds[0]! });
    this.rows.clear();
    this.toolCallIndex.clear();
    this.pendingStreamTextByRowId.clear();
    this.rowIds.length = 0;
    for (const row of viewRows) {
      this.claimRowId(row.rowId);
      this.append(row);
    }
    return viewRows;
  }

  /** 子代理地址携带父会话归属；无父会话语义的只读视图由 host 侧 viewIdOf 覆盖。 */
  private viewRows(rows: ConversationRow[]): ConversationRow[] {
    const subagents = this.host.subagents();
    return rows.map((row) => subagents.withViewId(row));
  }
}

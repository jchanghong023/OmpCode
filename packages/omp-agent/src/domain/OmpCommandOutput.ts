import type { AssistantTextRow } from "@zcode/shared/zcode-protocol-v4";
import type { ProjectionStreamHost } from "./projectionStreamText.js";
import { rowBaseFields } from "./projectionTypes.js";

/** GUI 收到的单帧显示事实；不承载 OMP 业务状态或命令终态。 */
export interface OmpCommandOutputRecord {
  id: string;
  text: string;
  createdAt: number;
  /** 原生可见 custom 的显示事实；用于与后来落盘的 journal 去重，不承载业务状态。 */
  customType?: string;
  /** 仅 frame 提供的原生事件时间；不能用 GUI 接收时间猜测 journal 的同一事件。 */
  nativeTimestamp?: number;
  /** 原生显示事实所属的 session epoch；后续 file/UUID 变化不能吞掉旧结果。 */
  nativeSessionId?: string;
}

/** ACK 后仍可输出且帧没有请求 ID，不能依附已关闭的轮或污染模型流式行。 */
export function appendOmpCommandOutput(
  host: ProjectionStreamHost,
  record: OmpCommandOutputRecord,
): AssistantTextRow {
  const rowId = host.nextRowId();
  const turnId = `omp-command-output:${record.id}`;
  const row: AssistantTextRow = {
    ...rowBaseFields({
      rowId,
      turnId,
      productTurnId: turnId,
      entityId: turnId,
      createdAtSeq: host.sequence() + 1,
    }),
    createdAt: record.createdAt,
    kind: "assistantText",
    text: record.text,
    state: "complete",
  };
  host.appendRow(row);
  return row;
}

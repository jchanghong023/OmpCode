// 原生历史与 GUI command_output 的纯合并：派生记录 ID 幂等，原生行逐条保留。
import type { ConversationRow } from "@zcode/shared/zcode-protocol-v4";
import type { OmpCommandOutputRecord } from "./OmpCommandOutput.js";
import { rowBaseFields } from "./projectionTypes.js";
import { nativeOmpCustomDisplays } from "./OmpCustomMessage.js";

export function mergeOmpCommandOutputHistory(
  rows: ConversationRow[],
  outputs: OmpCommandOutputRecord[],
  nativeEntries: readonly unknown[] = [],
  nativeSessionId?: string,
): ConversationRow[] {
  // 既有冷解析原生 entityId 仅表示行类别，多轮/多段都会重复；全局 Map 会吞掉
  // 已落 journal 的模型历史。只把本桥拥有的派生记录作为幂等身份，保留每条原生行。
  const nativeRows = rows.filter((row) => !row.entityId?.startsWith("omp-command-output:"));
  const byEntity = new Map(
    rows
      .filter((row) => row.entityId?.startsWith("omp-command-output:"))
      .map((row) => [row.entityId, row]),
  );
  const nativeCustom = nativeOmpCustomDisplays(nativeEntries);
  const seenOutputIds = new Set<string>();
  for (const output of outputs) {
    if (seenOutputIds.has(output.id)) continue;
    seenOutputIds.add(output.id);
    const entityId = `omp-command-output:${output.id}`;
    if (output.customType !== undefined) {
      // OMP 先创建 message.timestamp，再 await normalize，最后生成 entry.timestamp；同事件
      // 的 entry 时间可能更晚。仅在原始 session epoch 内按因果顺序一对一匹配，不用容差。
      const matching =
        output.nativeSessionId !== undefined &&
        output.nativeSessionId === nativeSessionId &&
        output.nativeTimestamp !== undefined
          ? nativeCustom.findIndex(
              (native) =>
                native.customType === output.customType &&
                native.text === output.text &&
                native.timestamp !== undefined &&
                native.timestamp >= output.nativeTimestamp!,
            )
          : -1;
      if (matching >= 0) {
        nativeCustom.splice(matching, 1);
        byEntity.delete(entityId);
        continue;
      }
    }
    if (byEntity.has(entityId)) continue;
    const turnId = entityId;
    byEntity.set(entityId, {
      ...rowBaseFields({ rowId: 1, turnId, productTurnId: turnId, entityId, createdAtSeq: 1 }),
      createdAt: output.createdAt,
      kind: "assistantText",
      text: output.text,
      state: "complete",
    });
  }
  return [...nativeRows, ...byEntity.values()]
    .sort((left, right) => left.createdAt - right.createdAt)
    .map((row, index) => ({ ...row, rowId: index + 1, createdAtSeq: index + 1 }));
}

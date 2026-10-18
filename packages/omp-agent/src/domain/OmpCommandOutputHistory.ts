// 原生历史与 GUI command_output 的纯合并：派生记录 ID 幂等，原生行逐条保留。
import type { ConversationRow } from "@zcode/shared/zcode-protocol-v4";
import type { OmpCommandOutputRecord } from "./OmpCommandOutput.js";
import { rowBaseFields } from "./projectionTypes.js";
import { isOmpCoordinationCustomType, nativeOmpCustomDisplays } from "./OmpCustomMessage.js";

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
  // 每次合并重建匹配池：即使 rows 已含 live 身份，也须消费其对应原生事实，
  // 避免后续同文独立事件错配；幂等性属于纯合并，不依赖投影重复初始化。
  const seenOutputIds = new Set<string>();
  for (const output of outputs) {
    // 修复：旧 GUI 曾把技能全文和协调提示存成显示记录；冷恢复也必须排除这些上下文。
    if (output.customType === "skill-prompt" || isOmpCoordinationCustomType(output.customType)) {
      byEntity.delete(`omp-command-output:${output.id}`);
      continue;
    }
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
        const [native] = nativeCustom.splice(matching, 1);
        // 真实 team-result 已在 journal 落盘，但 live 发布的是 command_output 身份；
        // 删除派生行会让冷恢复丢失该 ID。只移除这一次原生显示，沿用已发布的完整记录。
        const nativeRowIndex = nativeRows.findIndex(
          (row) =>
            row.kind === "assistantText" &&
            row.entityId?.startsWith("omp-native-custom") &&
            row.text === native!.text &&
            row.createdAt === native!.timestamp,
        );
        if (nativeRowIndex >= 0) nativeRows.splice(nativeRowIndex, 1);
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

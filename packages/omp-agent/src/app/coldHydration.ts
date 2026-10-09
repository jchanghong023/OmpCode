// 冷历史行入投影 + 索引摘要回写（自原 projectSessionLifecycle 收敛；行缺失时保留空投影，
// 后续事件/重读补齐）。修复（S2-2）：不把引擎登记进注册表——登记统一走 SessionRegistry
// 的墓碑检查 + winner 判定；冷恢复引擎惰性挂载、无子进程，丢弃无副作用。

import type { ConversationRow } from "@zcode/shared/zcode-protocol-v4";
import {
  coldSubagentIds,
  rowsFromOmpEntries,
  transcriptFromOmpEntries,
} from "../domain/coldHistory.js";
import type { ConversationEngine } from "./conversationEngine.js";
import type { OmpStorePort } from "./ports.js";
import { rowBaseFields } from "../domain/projectionTypes.js";
import { mergeOmpCommandOutputHistory } from "../domain/OmpCommandOutputHistory.js";
import { ompSessionIdOfFilePath } from "../domain/ids.js";

export interface ColdHydrationHost {
  store: OmpStorePort;
  /** 冷恢复后的索引摘要回写（含 createdAt/lastActivityAt 覆盖）。 */
  upsertEngineSummary: (
    engine: ConversationEngine,
    overrides?: { createdAt?: number; lastActivityAt?: number },
  ) => void;
}

export async function hydrateEngineFromCold(
  host: ColdHydrationHost,
  engine: ConversationEngine,
  sessionPath: string | null,
  createdAt?: number,
  updatedAt?: number,
): Promise<void> {
  let rows: ConversationRow[] = [];
  let entries: unknown[] = [];
  if (sessionPath) {
    entries = await host.store.readSessionEntries(sessionPath);
    const childRecords = new Map(
      await Promise.all(
        coldSubagentIds(entries)
          .slice(0, 20)
          .map(async (id) => [id, await host.store.readSubagentEntries(sessionPath, id)] as const),
      ),
    );
    const transcripts = new Map(
      [...childRecords].map(([id, records]) => [id, transcriptFromOmpEntries(records)]),
    );
    rows = rowsFromOmpEntries(entries, transcripts, childRecords);
  }
  const outputs =
    (await host.store.readCommandOutputs?.(engine.workspacePath, engine.sessionId, sessionPath)) ??
    [];
  engine.hydrateRows(
    outputs.length
      ? mergeOmpCommandOutputHistory(
          rows,
          outputs,
          entries,
          ompSessionIdOfFilePath(sessionPath) ?? undefined,
        )
      : rows,
  );
  host.upsertEngineSummary(engine, {
    createdAt: createdAt ?? Date.now(),
    lastActivityAt: updatedAt ?? Date.now(),
  });
}

/** 当前进程没有旧 roster 时，仅允许读取父历史证明归属的持久子代理记录。 */
export async function readPersistedSubagentEntries(
  sessionPath: string | null,
  store: Pick<OmpStorePort, "readSessionEntries" | "readSubagentEntries"> | undefined,
  subagentId: string,
  error: string | undefined,
): Promise<unknown[] | null> {
  // 普通 RPC/传输失败不能用旧记录伪装成功，客户端 ID 也不能成为任意文件读入口。
  if (!sessionPath || !store || !error?.startsWith("Unknown subagent or session file unavailable:"))
    return null;
  if (!coldSubagentIds(await store.readSessionEntries(sessionPath)).includes(subagentId))
    return null;
  return store.readSubagentEntries(sessionPath, subagentId);
}

/** 持久记录不存在时沿用详情投影的明确提示行。 */
export function recordUnavailableMarkerRow(rowId: number): ConversationRow {
  return {
    ...rowBaseFields({
      rowId,
      turnId: "turn-subagent-record",
      entityId: "subagent-record-unavailable",
      productTurnId: "turn-subagent-record",
      createdAtSeq: rowId,
    }),
    kind: "assistantText",
    text: "记录不可用（不存在或已清理）",
    state: "complete",
  };
}

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
  if (sessionPath) {
    const entries = await host.store.readSessionEntries(sessionPath);
    const transcripts = new Map(
      await Promise.all(
        coldSubagentIds(entries)
          .slice(0, 20)
          .map(
            async (id) =>
              [
                id,
                transcriptFromOmpEntries(await host.store.readSubagentEntries(sessionPath, id)),
              ] as const,
          ),
      ),
    );
    const rows: ConversationRow[] = rowsFromOmpEntries(entries, transcripts);
    engine.hydrateRows(rows);
  }
  host.upsertEngineSummary(engine, {
    createdAt: createdAt ?? Date.now(),
    lastActivityAt: updatedAt ?? Date.now(),
  });
}

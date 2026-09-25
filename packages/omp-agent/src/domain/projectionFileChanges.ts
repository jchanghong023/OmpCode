import type { ConversationRow } from "@zcode/shared/zcode-protocol-v4";
import { TurnFileFacts } from "./fileFacts.js";

/** 文件变更只从当前轮或已落盘的 turnHeader 事实读取。 */
export function readProjectionFileChanges(
  targetRowId: number,
  rows: ReadonlyMap<number, ConversationRow>,
  turn: { turnId: string; fileFacts: TurnFileFacts } | null,
  turnFacts: ReadonlyMap<string, TurnFileFacts>,
) {
  const row = rows.get(targetRowId);
  if (!row) throw new Error("row not found");
  const header = [...rows.values()].find((candidate) => candidate.kind === "turnHeader" && candidate.turnId === row.turnId);
  if (!header || header.kind !== "turnHeader") return { files: 0, additions: 0, deletions: 0, items: [] };
  const facts = turn?.turnId === row.turnId
    ? turn.fileFacts
    : turnFacts.get(row.turnId) ?? TurnFileFacts.fromSummary(header.fileChanges);
  return { ...facts.summary(), items: facts.items() };
}

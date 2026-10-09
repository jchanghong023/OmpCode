import { z } from "zod";
import type { ConversationRow } from "@zcode/shared/zcode-protocol-v4";
import { rowBaseFields } from "./projectionTypes.js";

const ompBtwTurnSchema = z.object({
  question: z.string(),
  answer: z.string(),
  status: z.enum(["running", "complete", "cancelled", "error", "interrupted"]),
  createdAt: z.number(),
  updatedAt: z.number(),
  error: z.string().optional(),
});
const ompBtwRecordSchema = ompBtwTurnSchema.extend({
  id: z.string().min(1),
  leafId: z.string().nullable(),
  followUps: z.array(ompBtwTurnSchema).optional(),
});
export const ompBtwHistorySchema = z.object({ records: z.array(ompBtwRecordSchema) });
export const ompBtwResponseSchema = z.object({ record: ompBtwRecordSchema });
export const ompBtwCancelSchema = z.object({ cancelled: z.boolean() });
export const ompBtwFrameSchema = z.discriminatedUnion("type", [
  z.object({ type: z.literal("btw_record"), record: ompBtwRecordSchema }),
  z.object({ type: z.literal("btw_delta"), recordId: z.string(), delta: z.string() }),
  z.object({
    type: z.literal("notice"),
    source: z.literal("btw-history"),
    level: z.string(),
    message: z.string(),
  }),
]);
export type OmpBtwRecord = z.infer<typeof ompBtwRecordSchema>;
export type OmpBtwFrame = z.infer<typeof ompBtwFrameSchema>;
export type OmpBtwCommand =
  | { id?: string; type: "btw"; question: string; recordId?: string }
  | { id?: string; type: "btw_cancel"; recordId?: string }
  | { id?: string; type: "get_btw_history" };

// 地址只存在于核心适配层；UI 将 sessionId 当不透明标识。
export function btwViewId(parent: string, record: string): string {
  return `omp-btw:${encodeURIComponent(parent)}:${encodeURIComponent(record)}`;
}
export function parseBtwViewId(id: string): { parent: string; record: string } | null {
  const match = /^omp-btw:([^:]+):([^:]+)$/.exec(id);
  if (!match) return null;
  try {
    return { parent: decodeURIComponent(match[1]!), record: decodeURIComponent(match[2]!) };
  } catch {
    return null;
  }
}
export function latestBtwTurn(record: OmpBtwRecord) {
  return record.followUps?.at(-1) ?? record;
}
export function btwRows(
  record: OmpBtwRecord,
  sourceIds: ReadonlyMap<number, string>,
): ConversationRow[] {
  return [record, ...(record.followUps ?? [])].flatMap((turn, index) => {
    const turnId = `${record.id}:${index}`;
    const base = (offset: number) => ({
      ...rowBaseFields({
        rowId: index * 3 + offset,
        turnId,
        entityId: `${turnId}:${offset}`,
        productTurnId: turnId,
        createdAtSeq: index * 3 + offset,
      }),
      createdAt: turn.createdAt,
    });
    const sourceCommandId = sourceIds.get(index);
    return [
      {
        ...base(1),
        kind: "turnHeader",
        origin: "userInput",
        executionKind: "agent",
        ...(sourceCommandId ? { sourceCommandId } : {}),
        startedAt: turn.createdAt,
        ...(turn.status !== "running" ? { endedAt: turn.updatedAt } : {}),
        state:
          turn.status === "running"
            ? "running"
            : turn.status === "complete"
              ? "completedSuccess"
              : turn.status === "error"
                ? "failed"
                : "completedInterrupted",
      },
      {
        ...base(2),
        kind: "userInput",
        origin: "realUser",
        text: turn.question,
        ...(sourceCommandId ? { sourceCommandId } : {}),
      },
      {
        ...base(3),
        kind: "assistantText",
        text: turn.answer,
        state:
          turn.status === "running"
            ? "streaming"
            : turn.status === "complete"
              ? "complete"
              : turn.status === "error"
                ? "failed"
                : "interrupted",
      },
    ] satisfies ConversationRow[];
  });
}

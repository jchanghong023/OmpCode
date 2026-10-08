import type { QueueItem } from "@zcode/shared/zcode-protocol-v4";
import type { QueuedTurnReconcileHost } from "./queuedTurnReconcile.js";
import { activateQueuedTurnOf } from "./queuedTurnReconcile.js";
import { finalizeTurnContexts } from "./projectionTurnFinalizer.js";

const observedUserStarts = new WeakSet<import("./projectionRows.js").TurnContext>();

/** 修复：此前 queuedTurns 没有发布 queue，UI 把等待轮误显示为正在执行。
 * 这里只派生展示，不建立第二份接受队列；重复文本按 command ID 区分。
 */
export function publishQueuedInputsOf(host: QueuedTurnReconcileHost): void {
  const previous = host.state().queue;
  if (
    host.queuedTurns.length === previous.items.length &&
    host.queuedTurns.every((turn, i) => turn.sourceCommandId === previous.items[i]?.sourceCommandId)
  )
    return;
  const inputs = new Map(
    host.rowIds.flatMap((id) => {
      const row = host.rowAt(id);
      return row?.kind === "userInput" ? [[row.turnId, row] as const] : [];
    }),
  );
  const items: QueueItem[] = host.queuedTurns.flatMap((turn) => {
    const row = inputs.get(turn.turnId);
    return row
      ? [
          {
            sourceCommandId: turn.sourceCommandId,
            queueItemId: turn.sourceCommandId,
            clientId: row.clientId ?? "omp",
            kind: "sendText" as const,
            text: row.text,
            attachments: row.attachments ?? [],
            delivery: { requested: "queue" as const, admitted: "queue" as const },
            order: { admissionSeq: row.createdAtSeq },
            steer: { state: "notRequested" as const },
            dispatch: { state: "queued" as const },
            admittedAt: row.createdAt,
          },
        ]
      : [];
  });
  if (
    items.length === previous.items.length &&
    items.every((item, i) => item.sourceCommandId === previous.items[i]?.sourceCommandId)
  )
    return;
  host.patchState({ queue: { ...previous, items } });
}

/** 同一 run 内 follow_up 消费不另发 agent_start；只以匹配的用户消息激活队首。
 * message_end 不调用此入口，旧进程事件由引擎既有 fence 拦截。
 */
export function consumeQueuedInputOf(host: QueuedTurnReconcileHost, text?: string): void {
  if (text === undefined) {
    activateQueuedTurnOf(host);
    publishQueuedInputsOf(host);
    return;
  }
  const active = host.activeTurn();
  // 首条 prompt 的用户回显可能晚于后续同文本入队；不能把回显误当作消费下一条。
  if (
    active &&
    !observedUserStarts.has(active) &&
    host.inputTextByTurnId.get(active.turnId)?.trim() === text.trim()
  ) {
    observedUserStarts.add(active);
    return;
  }
  const next = host.queuedTurns[0];
  if (!next || host.inputTextByTurnId.get(next.turnId)?.trim() !== text.trim()) return;
  if (active) {
    finalizeTurnContexts({
      turns: [active],
      outcome: "success",
      rowAt: host.rowAt,
      upsertRow: host.upsertRow,
      closeStreamingRows: (turn) => host.closeStreamingRows("complete", turn),
      turnFacts: host.turnFacts,
    });
    host.inputTextByTurnId.delete(active.turnId);
  }
  host.queuedTurns.shift();
  host.setActiveTurn(next);
  observedUserStarts.add(next);
  const header = host.rowAt(next.headerRowId);
  if (header?.kind === "turnHeader") host.upsertRow({ ...header, startedAt: Date.now() });
  publishQueuedInputsOf(host);
}

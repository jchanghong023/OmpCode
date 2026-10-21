import type { QueueItem } from "@zcode/shared/zcode-protocol-v4";
import type { QueuedTurnReconcileHost } from "./queuedTurnReconcile.js";
import type { TurnContext } from "./projectionRows.js";
import { finalizeTurnContexts } from "./projectionTurnFinalizer.js";
import { runningControlPatch } from "./projectionStatePatches.js";

const observedUserStarts = new WeakSet<TurnContext>();

function dispatchState(turn: TurnContext): QueueItem["dispatch"]["state"] {
  return turn.submission?.state === "pending"
    ? "queued"
    : turn.submission?.delivery === "steer"
      ? "promoting"
      : "reserved";
}

function sameItem(turn: TurnContext, item: QueueItem | undefined): boolean {
  return (
    turn.sourceCommandId === item?.sourceCommandId &&
    dispatchState(turn) === item.dispatch.state &&
    (turn.submission?.delivery === "steer" ? "guide" : "queue") === item.delivery.admitted
  );
}

/** 修复：此前 queuedTurns 没有发布 queue，UI 把等待轮误显示为正在执行。
 * 这里只派生展示，不建立第二份接受队列；重复文本按 command ID 区分。
 */
export function publishQueuedInputsOf(host: QueuedTurnReconcileHost): void {
  const previous = host.state().queue;
  if (
    host.queuedTurns.length === previous.items.length &&
    host.queuedTurns.every((turn, i) => sameItem(turn, previous.items[i]))
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
            delivery: {
              requested:
                turn.submission?.delivery === "steer" ? ("guide" as const) : ("queue" as const),
              admitted:
                turn.submission?.delivery === "steer" ? ("guide" as const) : ("queue" as const),
            },
            order: { admissionSeq: row.createdAtSeq },
            steer: { state: "notRequested" as const },
            dispatch: { state: dispatchState(turn) },
            admittedAt: row.createdAt,
          },
        ]
      : [];
  });
  if (
    items.length === previous.items.length &&
    items.every(
      (item, i) =>
        item.sourceCommandId === previous.items[i]?.sourceCommandId &&
        item.dispatch.state === previous.items[i]?.dispatch.state &&
        item.delivery.admitted === previous.items[i]?.delivery.admitted,
    )
  )
    return;
  host.patchState({ queue: { ...previous, items } });
}

/** 仅真实用户 message_start 消费一项；agent_start/ACK/空快照都不能移出等待项。 */
export function consumeQueuedInputOf(host: QueuedTurnReconcileHost, text?: string): void {
  if (text === undefined) return;
  // 原生 steer 会前置固定工作插话信封；只移除该精确信封，不用尾部/模糊文本匹配。
  const input = text.replace(
    /^<system-notice>\nUser interjection during work: priority; supersedes conflicting prior instructions\. Re-read; ensure current work reflects user intent\.\n<\/system-notice>\n/u,
    "",
  );
  const active = host.activeTurn();
  if (
    active &&
    !observedUserStarts.has(active) &&
    host.inputTextByTurnId.get(active.turnId) === input &&
    active.submission?.state !== "pending" &&
    active.submission?.state !== "cancelled"
  ) {
    observedUserStarts.add(active);
    if (active.submission) active.submission.state = "consumed";
    return;
  }
  const index = host.queuedTurns.findIndex((turn) => {
    const submission = turn.submission;
    return (
      host.inputTextByTurnId.get(turn.turnId) === input &&
      (!submission || (submission.state !== "pending" && submission.state !== "cancelled"))
    );
  });
  if (index < 0) return;
  const next = host.queuedTurns[index]!;
  const guide = next.submission?.delivery === "steer";
  if (active) {
    if (guide) {
      host.closeStreamingRows("complete", active);
      host.suspendedTurns().push(active);
    } else {
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
  }
  host.queuedTurns.splice(index, 1);
  host.setActiveTurn(next);
  observedUserStarts.add(next);
  if (next.submission) next.submission.state = "consumed";
  const header = host.rowAt(next.headerRowId);
  if (header?.kind === "turnHeader") host.upsertRow({ ...header, startedAt: Date.now() });
  host.patchState(runningControlPatch());
  publishQueuedInputsOf(host);
}

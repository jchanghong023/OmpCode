import { useEffect, useState } from "react";
import { useV4Conversation } from "@/v4/V4ConversationContext.js";
import { useConversationProjection } from "@/v4/useConversationProjection.js";
import type { SessionLease } from "@/v4/sessionDataLayer.js";
import type { SubagentRow } from "@zcode/shared/zcode-protocol-v4";

/** 复用父会话的同一租约/投影；历史行不能证明现在存在可控制的子进程。 */
export function useOmpSubagentControlState(
  parentSessionId: string | undefined,
  childSessionId: string,
) {
  const { layer } = useV4Conversation();
  const [lease, setLease] = useState<SessionLease | null>(null);
  const projection = useConversationProjection(lease);
  useEffect(() => {
    if (!parentSessionId) return;
    const next = layer.acquire(parentSessionId);
    setLease(next);
    return () => next.release();
  }, [layer, parentSessionId]);
  const snapshot = lease?.sessionId === parentSessionId ? projection.snapshot : null;
  const runningSubagent = snapshot?.subagents?.running.find(
    (item) => item.childSessionId === childSessionId,
  );
  const running = runningSubagent !== undefined;
  const row = snapshot?.rows.window.findLast(
    (item) => item.kind === "subagent" && item.childSessionId === childSessionId,
  );
  const status: SubagentRow["status"] = running
    ? "running"
    : row?.kind === "subagent"
      ? row.status
      : "unknown";
  const model = runningSubagent?.model ?? (row?.kind === "subagent" ? row.model : undefined);
  return { status, model, controllable: running && projection.status === "live" };
}

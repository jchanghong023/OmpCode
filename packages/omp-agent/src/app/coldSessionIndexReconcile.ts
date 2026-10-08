// 冷会话差集算法：只读 SessionIndexTopics 的当前摘要，写入与发布仍回到同一 owner。
// 调用方只在完整扫描成功后调用；扫描失败不是“历史为空”，不能据此删除索引行。

import type { SessionSummary } from "@zcode/shared/zcode-protocol-v4";
import { deriveTitle } from "../domain/titleText.js";
import type { OmpStoreSessionSummary } from "./ports.js";

interface ColdSessionIndexReconcileInput {
  workspaceId: string;
  cold: readonly OmpStoreSessionSummary[];
  // 一次完整扫描的 ID 集合供所有 topic 复用，不建立另一份历史事实源。
  coldIds: ReadonlySet<string>;
  summaries: ReadonlyMap<string, SessionSummary>;
  hasLoadedSession(sessionId: string): boolean;
  upsert(summary: SessionSummary): void;
  remove(sessionId: string): void;
}

export function reconcileColdSessionIndex(input: ColdSessionIndexReconcileInput): void {
  for (const session of input.cold) {
    if (input.hasLoadedSession(session.sessionId)) continue;
    const existing = input.summaries.get(session.sessionId);
    const title = session.title ?? deriveTitle(session.firstUserText ?? "");
    const titleSource = session.title ? "custom" : "generated";
    if (
      existing &&
      existing.title === title &&
      existing.titleSource === titleSource &&
      existing.lastActivityAt === session.updatedAt &&
      existing.createdAt === session.createdAt
    )
      continue;
    // 冷改名不必先删除旧行；完整扫描成功后直接刷新事实，保留已有投影字段。
    const summary: SessionSummary = {
      ...existing,
      phase: existing?.phase ?? "completedSuccess",
      sessionEnded: existing?.sessionEnded ?? true,
      hasBackgroundWork: existing?.hasBackgroundWork ?? false,
      sessionId: session.sessionId,
      workspaceId: input.workspaceId,
      title,
      titleSource,
      lastActivityAt: session.updatedAt,
      createdAt: session.createdAt,
    };
    input.upsert(summary);
  }
  for (const sessionId of input.summaries.keys()) {
    if (
      !input.coldIds.has(sessionId) &&
      !input.hasLoadedSession(sessionId) &&
      !sessionId.startsWith("omp-session-")
    ) {
      input.remove(sessionId);
    }
  }
}

// Fork（omp-project-mode.md）：OMP 项目模式子代理目录与控制。
// ended 以 OMP 持久目录为准（含重启后的历史子代理）；控制走 control_subagent 业务入口。

import {
  buildOmpSubagentViewId,
  ompProjectSubagentSummarySchema,
} from "../domain/ompProjectFrames.js";
import type { OmpProjectGatewayPort } from "./ports.js";

export interface OmpProjectDirectoryDeps {
  project: OmpProjectGatewayPort | null | undefined;
  projectAvailable: () => Promise<boolean>;
  /** 父会话投影目录（running 与修订来源）。 */
  projectionDirectory: (sessionId: string) => Record<string, unknown> | null;
}

/**
 * 项目模式子代理目录：running 来自父会话投影；ended 以 OMP 持久目录为准。
 * OMP 分页无 total 字段，以「已见条数 + 是否还有下一页」近似，不伪造精确值。
 * endedLimit（协议 default 20/max 100，zcodeSessionSubagentsParamsSchema）透传为 OMP limit。
 */
export async function projectSubagentDirectory(
  deps: OmpProjectDirectoryDeps,
  sessionId: string,
  offset: number,
  limit = 20,
): Promise<Record<string, unknown> | null> {
  if (!deps.project || !(await deps.projectAvailable())) return null;
  const projectionDirectory = deps.projectionDirectory(sessionId) ?? {
    revision: 0,
    childSessionIds: [],
    running: [],
    ended: { total: 0, items: [] },
  };
  const outcome = await deps.project.sendProject({
    type: "get_subagents",
    sessionId,
    status: "finished",
    cursor: offset,
    limit,
  });
  if (!outcome.success) {
    return projectionDirectory;
  }
  const data = outcome.data as { items?: unknown[]; nextCursor?: string | number } | undefined;
  const items = (Array.isArray(data?.items) ? data!.items : []).flatMap((raw) => {
    const parsed = ompProjectSubagentSummarySchema.safeParse(raw);
    if (!parsed.success) return [];
    return [
      {
        childSessionId: buildOmpSubagentViewId(sessionId, parsed.data.subagentId),
        agentId: parsed.data.subagentId,
        subagentType: parsed.data.name ?? parsed.data.subagentId,
        title:
          parsed.data.description ?? parsed.data.task ?? parsed.data.name ?? parsed.data.subagentId,
        summary: parsed.data.task ?? "",
        status: projectStatusToDirectory(parsed.data.status),
        ...(parsed.data.lastUpdate
          ? { endedAt: Date.parse(parsed.data.lastUpdate) || undefined }
          : {}),
      },
    ];
  });
  // 修复（交叉复审）：OMP 响应带 nextCursor 时透传（权威分页游标）；缺失即无下一页，
  // 不得伪造游标（伪造会让 UI 以游标续拉同一页，形成无限请求循环）。
  const ompCursor = data?.nextCursor;
  const hasMore = ompCursor !== undefined && ompCursor !== null;
  return {
    ...(projectionDirectory as Record<string, unknown>),
    ended: {
      total: offset + items.length + (hasMore ? 1 : 0),
      items,
      ...(hasMore ? { nextCursor: String(ompCursor) } : {}),
    },
  };
}

/** 项目模式子代理控制（control_subagent）：send_message/stop 的业务入口。 */
export async function controlSubagent(
  deps: OmpProjectDirectoryDeps,
  sessionId: string,
  subagentId: string,
  action: "send_message" | "stop",
  message?: string,
): Promise<{ success: boolean; data?: unknown; error?: string }> {
  if (!deps.project || !(await deps.projectAvailable())) {
    return { success: false, error: "omp project mode unavailable" };
  }
  return deps.project.sendProject({
    type: "control_subagent",
    sessionId,
    subagentId,
    action,
    ...(action === "send_message" && message !== undefined ? { message } : {}),
  });
}

/**
 * OMP 项目目录状态 → legacy 目录状态词。
 * 修复（R1③ durable 终态映射，对齐 omp v18.4.8+fork.278 rpc-project-subagents.buildFinishedSubagentRow）：
 * parked=已完成驻留且 availableActions=PARKED_ACTIONS=["send_message"]（可 send_message 唤醒，
 * 注释「Parked rows can still receive IRC sends (the bus revives them)」），映射 lost 会让用户
 * 误判结果丢失且不再尝试唤醒 → success；interrupted=崩溃中断、无完成事实，按 cancelled
 * （与通道侧 ompProjectChannel.projectSubagentStatusToLegacy 一致，消除目录面/卡片面词汇不一致）。
 */
function projectStatusToDirectory(
  status: string | undefined,
): "success" | "failed" | "cancelled" | "lost" {
  switch (status) {
    case "completed":
    case "parked":
      return "success";
    case "failed":
      return "failed";
    case "aborted":
    case "interrupted":
      return "cancelled";
    default:
      // 目录只查 status:"finished"，本就不该有 live 词；未知词收敛到终态，绝不误标 running。
      return "lost";
  }
}

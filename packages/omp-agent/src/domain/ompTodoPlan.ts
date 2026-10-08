import type { ZCodePlanStep } from "@zcode/shared";
import type { ConversationRow, PlanState } from "@zcode/shared/zcode-protocol-v4";

/** omp todo 的权威 phases → GUI 清单投影；只消费工具结果，不猜测 op 输入。 */
export function ompTodoPlan(details: unknown): ZCodePlanStep[] | null {
  if (
    !details ||
    typeof details !== "object" ||
    !Array.isArray((details as { phases?: unknown }).phases)
  )
    return null;
  const phases = (details as { phases: unknown[] }).phases;
  const steps: ZCodePlanStep[] = [];
  for (const rawPhase of phases) {
    if (!rawPhase || typeof rawPhase !== "object") return null;
    const phase = rawPhase as { name?: unknown; tasks?: unknown };
    if (typeof phase.name !== "string" || !Array.isArray(phase.tasks)) return null;
    for (const rawTask of phase.tasks) {
      if (!rawTask || typeof rawTask !== "object") return null;
      const task = rawTask as { content?: unknown; status?: unknown };
      if (typeof task.content !== "string" || !task.content.trim()) return null;
      if (
        !["pending", "in_progress", "completed", "blocked", "abandoned"].includes(
          String(task.status),
        )
      )
        return null;
      const status: ZCodePlanStep["status"] =
        task.status === "in_progress"
          ? "in_progress"
          : task.status === "completed" || task.status === "abandoned"
            ? "completed"
            : "pending";
      steps.push({
        id: `${phase.name}\u0000${task.content}`,
        title:
          task.status === "blocked" || task.status === "abandoned"
            ? `${task.content} (${task.status})`
            : task.content,
        status,
      });
      if (steps.length > 200) return null;
    }
  }
  return steps;
}

/** 修复依据：独立待办面板消费 v4 plan，不能只把 OMP 清单留在工具输出中。 */
export function ompTodoState(row: ConversationRow): PlanState | null | undefined {
  if (row.kind !== "toolCall" || row.toolName !== "todo" || row.status !== "success")
    return undefined;
  const steps = row.output?.plan;
  if (!steps) return undefined;
  if (steps.length === 0) return null;
  return {
    items: steps.map((step) => ({
      id: step.id,
      content: step.title,
      status: step.status === "in_progress" ? "inProgress" : step.status,
    })),
    updatedAt: row.endedAt ?? row.createdAt,
  };
}

/** 冷恢复与记录替换取最后有效结果；失败结果不得清空已确认的清单。 */
export function ompTodoStateFromRows(rows: Iterable<ConversationRow>): PlanState | null {
  let plan: PlanState | null = null;
  let lastRowId = -1;
  for (const row of rows) {
    const next = ompTodoState(row);
    if (next === undefined || row.rowId <= lastRowId) continue;
    plan = next;
    lastRowId = row.rowId;
  }
  return plan;
}

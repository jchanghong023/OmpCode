import type { ZCodePlanStep } from "@zcode/shared";

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
  return steps.length > 0 ? steps : null;
}

import type { TaskUsageState } from "@/store/zcodeSessionStoreTypes.js";

interface TaskUsageKeyParams {
  workspacePath: string;
  workspaceIdentity?: string;
  taskId: string;
}

interface TaskContextUsageUpdateParams extends TaskUsageKeyParams {
  used: number;
  size: number;
}

interface BuildTaskContextUsageUpdateParams {
  currentUsage: TaskUsageState | null | undefined;
  incomingUsage: TaskUsageState;
  latestUserPrompt?: string | null;
}

const taskContextUsageUpdateKeys = new Set<string>();

function buildTaskUsageKey(params: TaskUsageKeyParams): string {
  const workspaceKey = params.workspaceIdentity?.trim() || params.workspacePath;
  return `${params.workspacePath}::${workspaceKey}::${params.taskId}`;
}

export function recordTaskContextUsageUpdate(params: TaskContextUsageUpdateParams) {
  if (!Number.isFinite(params.used) || params.used <= 0) {
    return;
  }
  if (!Number.isFinite(params.size) || params.size <= 0) {
    return;
  }
  taskContextUsageUpdateKeys.add(buildTaskUsageKey(params));
}

function isContextCompressionPrompt(prompt: string | null | undefined): boolean {
  const normalized = prompt?.trim() ?? "";
  return (
    normalized === "/compact" ||
    normalized.startsWith("/compact ") ||
    normalized === "/compress" ||
    normalized.startsWith("/compress ")
  );
}

export function buildTaskContextUsageFromUsageUpdate(
  params: BuildTaskContextUsageUpdateParams,
): TaskUsageState {
  const { currentUsage, incomingUsage, latestUserPrompt } = params;
  const usageWithRetainedBreakdown =
    !incomingUsage.breakdown &&
    currentUsage?.breakdown &&
    currentUsage.used === incomingUsage.used &&
    currentUsage.size === incomingUsage.size
      ? { ...incomingUsage, breakdown: currentUsage.breakdown }
      : incomingUsage;
  if (
    currentUsage &&
    Number.isFinite(currentUsage.used) &&
    currentUsage.used > 0 &&
    Number.isFinite(currentUsage.size) &&
    currentUsage.size > 0 &&
    (!Number.isFinite(incomingUsage.used) || incomingUsage.used <= 0) &&
    !isContextCompressionPrompt(latestUserPrompt)
  ) {
    // Bugfix: Agent 在普通工具调用期间会短暂发出 used=0 的 usage_update，
    // 这不是 context 真的被清空，而是上游 replay/子调用 usage 缺失造成的瞬时假值。
    // 非压缩轮次保留上一个正数，避免输入栏上下文占用闪一下后消失。
    return currentUsage;
  }

  return usageWithRetainedBreakdown;
}

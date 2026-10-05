// v4 usageStats 的空统计应答（omp 核不持有 ZCode 用量库；形状对齐 wire schema）。
// S5-6 依据：range 必须收敛到 shared 枚举（packages/shared/src/usage-stats.ts
// UsageStatsRange = "all"|"7d"|"30d"，zcode-protocol 请求 schema 亦按该枚举校验）；
// 非法/缺失入参回 "all"，不回透未收敛字符串。
import { APP_USAGE_RANGES, type UsageStatsRange } from "@zcode/shared";

function isUsageStatsRange(value: string): value is UsageStatsRange {
  return (APP_USAGE_RANGES as readonly string[]).includes(value);
}

export function buildUsageStatsResponse(params: unknown): Record<string, unknown> {
  const record =
    typeof params === "object" && params !== null && !Array.isArray(params)
      ? (params as Record<string, unknown>)
      : null;
  const range: UsageStatsRange =
    typeof record?.range === "string" && isUsageStatsRange(record.range) ? record.range : "all";
  return {
    range,
    generatedAt: Date.now(),
    timeZone: typeof record?.timeZone === "string" ? record.timeZone : "UTC",
    source: "agent-db",
    summary: {
      totalTokens: 0,
      inputTokens: 0,
      outputTokens: 0,
      reasoningTokens: 0,
      cacheCreationTokens: 0,
      cacheReadTokens: 0,
      cacheHitRate: 0,
      totalSessions: 0,
      totalTurns: 0,
      toolCallCount: 0,
      toolErrorRate: 0,
      modelErrorRate: 0,
      avgTimeToFirstTokenMs: null,
      avgTurnDurationMs: null,
      activeDays: 0,
      currentStreakDays: 0,
      longestSessionMs: 0,
      longestStreakDays: 0,
      peakDayTokens: 0,
      favoriteModel: null,
    },
    heatmap: { startDate: null, endDate: null, maxTokens: 0, weeks: [] },
    dailyModelUsage: [],
    models: [],
    tools: [],
  };
}

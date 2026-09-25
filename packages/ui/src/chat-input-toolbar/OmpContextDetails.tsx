import type { CSSProperties } from "react";
import { useZCodeIntl } from "@/i18n/IntlProvider.js";
import { formatCompactTokenNumber } from "@/lib/tokenNumberFormat.js";

export interface OmpContextEntry {
  label: string;
  tokens: number;
}

const LABEL_IDS: Record<string, string> = {
  "system prompt": "chat.contextUsage.omp.systemPrompt",
  "system tools": "chat.contextUsage.omp.systemTools",
  "system context": "chat.contextUsage.omp.systemContext",
  skills: "chat.contextUsage.omp.skills",
  messages: "chat.contextUsage.omp.messages",
  "mcp tools": "chat.contextUsage.omp.mcpTools",
  "memory files": "chat.contextUsage.omp.memoryFiles",
  "custom agents": "chat.contextUsage.omp.customAgents",
  free: "chat.contextUsage.omp.free",
  "free space": "chat.contextUsage.omp.free",
  "auto-compact buf": "chat.contextUsage.omp.autoCompactBuffer",
  "autocompact buffer": "chat.contextUsage.omp.autoCompactBuffer",
};
const RESERVED_LABELS = new Set(["free", "free space", "auto-compact buf", "autocompact buffer"]);
const TONES = [
  "var(--color-usage-chart-1)",
  "color-mix(in oklab, var(--color-usage-chart-1) 78%, var(--color-surface))",
  "color-mix(in oklab, var(--color-usage-chart-1) 58%, var(--color-surface))",
  "color-mix(in oklab, var(--color-usage-chart-1) 42%, var(--color-surface))",
  "color-mix(in oklab, var(--color-usage-chart-1) 28%, var(--color-surface))",
] as const;

function normalized(label: string): string {
  return label.trim().toLowerCase();
}

export function buildOmpUsageProgressSegments(entries: readonly OmpContextEntry[]) {
  const used = entries.filter(
    (entry) => !RESERVED_LABELS.has(normalized(entry.label)) && entry.tokens > 0,
  );
  const sum = used.reduce((total, entry) => total + entry.tokens, 0);
  return sum > 0
    ? used.map((entry, index) => ({
        id: `${normalized(entry.label)}-${index}`,
        percent: entry.tokens / sum,
        style: {
          backgroundColor: TONES[Math.min(index, TONES.length - 1)],
        } satisfies CSSProperties,
      }))
    : [];
}

export function OmpContextDetailsPanel({
  entries,
  maxTokens,
  locale,
}: {
  entries: readonly OmpContextEntry[];
  maxTokens: number;
  locale: string;
}) {
  const { intl } = useZCodeIntl();
  const percentFormatter = new Intl.NumberFormat(locale, {
    style: "percent",
    maximumFractionDigits: 1,
  });
  const used = entries.filter((entry) => !RESERVED_LABELS.has(normalized(entry.label)));
  const reserved = entries.filter((entry) => RESERVED_LABELS.has(normalized(entry.label)));
  const row = (entry: OmpContextEntry, index: number) => {
    const key = normalized(entry.label);
    const id = LABEL_IDS[key];
    const ratio = maxTokens > 0 ? entry.tokens / maxTokens : 0;
    const percentage = ratio > 0 && ratio < 0.001 ? "<0.1%" : percentFormatter.format(ratio);
    const tone =
      key === "free" || key === "free space"
        ? "var(--color-foreground-subtlest)"
        : key === "auto-compact buf" || key === "autocompact buffer"
          ? "var(--color-warning)"
          : TONES[Math.min(index, TONES.length - 1)];
    return (
      <div className="flex min-w-0 items-center gap-2 text-ui-sm" key={`${key}-${index}`}>
        <span
          aria-hidden="true"
          className="size-2 shrink-0 rounded-sm"
          style={{ backgroundColor: tone }}
        />
        <span className="min-w-0 truncate text-foreground-subtle" title={entry.label}>
          {id ? intl.formatMessage({ id }) : entry.label}
        </span>
        <span className="ml-auto shrink-0 font-mono tabular-nums text-foreground">
          {formatCompactTokenNumber(locale, entry.tokens)} · {percentage}
        </span>
      </div>
    );
  };
  return (
    <section
      aria-label={intl.formatMessage({ id: "chat.contextUsage.omp.estimated" })}
      className="space-y-2 border-t border-border pt-3"
    >
      <div className="text-ui-sm text-foreground-subtle">
        {intl.formatMessage({ id: "chat.contextUsage.omp.estimated" })}
      </div>
      <div className="space-y-1.5">{used.map(row)}</div>
      {reserved.length > 0 ? (
        <div className="space-y-1.5 border-t border-border pt-2">
          {reserved.map((entry, index) => row(entry, used.length + index))}
        </div>
      ) : null}
    </section>
  );
}

import { memo, useMemo, useRef } from "react";
import type { ZCodeAgentInteractionEvent } from "@zcode/shared";
import { useVirtualizer } from "@tanstack/react-virtual";
import { ArrowRightIcon, ChevronRightIcon } from "lucide-react";
import { cn } from "@/components/lib/utils.js";
import { useZCodeIntl } from "@/i18n/IntlProvider.js";
import type { IntlInstance } from "@/i18n/IntlProvider.js";
import { summarizeOmpInteractionContent } from "@/app-shell/ompInteractionContentSummary.js";

type SummaryField = ReturnType<typeof summarizeOmpInteractionContent>["fields"][number];

function summaryFieldValue(field: SummaryField, intl: IntlInstance): string {
  if (
    field.type === "status" &&
    [
      "running",
      "waiting",
      "blocked",
      "success",
      "completed",
      "failed",
      "cancelled",
      "aborted",
      "lost",
      "unknown",
    ].includes(field.value)
  ) {
    return intl.formatMessage({ id: `ompInteractions.status.${field.value}` });
  }
  if (field.type === "duration") {
    const match = /^(\d+(?:\.\d+)?)\s*(ms|s|m|h)$/u.exec(field.value);
    if (match) {
      const units: Record<string, string> = {
        ms: "milliseconds",
        s: "seconds",
        m: "minutes",
        h: "hours",
      };
      return intl.formatMessage(
        { id: `ompInteractions.summary.${units[match[2] ?? ""]}` },
        { value: match[1] ?? "" },
      );
    }
  }
  if (field.type === "reported_message_count")
    return intl.formatMessage(
      { id: "ompInteractions.summary.messageCount" },
      { count: field.value },
    );
  if (field.type === "structured_count")
    return intl.formatMessage(
      { id: "ompInteractions.summary.structuredCount" },
      { count: field.value },
    );
  return field.value;
}

function summaryFieldLabel(field: SummaryField, intl: IntlInstance): string {
  const keys: Partial<Record<SummaryField["type"], string>> = {
    result: "result",
    child_result: "childResult",
    reported_message_count: "reportedMessages",
  };
  const key = keys[field.type];
  return key ? intl.formatMessage({ id: `ompInteractions.summary.${key}` }) : "";
}

function interactionPreview(event: ZCodeAgentInteractionEvent, intl: IntlInstance): string {
  const content = summarizeOmpInteractionContent(event);
  const fields = content.fields.map((field) =>
    `${summaryFieldLabel(field, intl)} ${summaryFieldValue(field, intl)}`.trim(),
  );
  return (
    [...fields, content.summary].filter(Boolean).join(" · ") ||
    (content.structured
      ? intl.formatMessage({ id: "ompInteractions.summary.structuredResult" })
      : "")
  );
}

/** 默认只读精简字段；原文的字节内容仍由事件保留，展开后安全地按文本核对。 */
export const InteractionMessageContent = memo(function InteractionMessageContent({
  event,
}: {
  event: ZCodeAgentInteractionEvent;
}) {
  const { intl } = useZCodeIntl();
  const content = useMemo(() => summarizeOmpInteractionContent(event), [event.body, event.kind]);
  const headline = content.fields.filter(
    (field) => field.type === "status" || field.type === "duration",
  );
  const rows = content.fields.filter(
    (field) => field.type !== "status" && field.type !== "duration",
  );
  const showOriginal =
    content.structured ||
    content.truncated ||
    content.fields.some((field) => field.truncated) ||
    content.body !== content.summary ||
    Boolean(event.delivery || event.replyTo || event.error);
  return (
    <div className="mt-3 space-y-3 text-ui-base">
      <div data-testid="omp-agent-interaction-summary" className="space-y-2">
        {headline.length ? (
          <p className="font-medium">
            {headline.map((field) => summaryFieldValue(field, intl)).join(" · ")}
          </p>
        ) : null}
        {rows.length ? (
          <dl className="space-y-1.5">
            {rows.map((field, index) => (
              <div
                key={`${field.type}:${index}`}
                className="flex flex-wrap items-baseline gap-x-3 gap-y-1"
              >
                {summaryFieldLabel(field, intl) ? (
                  <dt className="shrink-0 text-ui-sm text-foreground-subtle">
                    {summaryFieldLabel(field, intl)}
                  </dt>
                ) : null}
                <dd className="min-w-0 whitespace-pre-wrap break-words [overflow-wrap:anywhere]">
                  {summaryFieldValue(field, intl)}
                </dd>
              </div>
            ))}
          </dl>
        ) : null}
        {content.summary ? (
          <p className="whitespace-pre-wrap break-words leading-relaxed [overflow-wrap:anywhere]">
            {content.summary}
          </p>
        ) : !content.fields.length && content.structured ? (
          <p className="text-ui-sm text-foreground-subtle">
            {intl.formatMessage({ id: "ompInteractions.summary.structuredResult" })}
          </p>
        ) : null}
      </div>
      {showOriginal ? (
        <details
          key={event.eventId}
          data-testid="omp-agent-interaction-raw"
          className="group/raw text-ui-sm"
        >
          <summary
            data-testid="omp-agent-interaction-raw-toggle"
            className="flex cursor-pointer list-none items-center gap-1 text-foreground-subtle outline-none hover:text-foreground focus-visible:ring-2 focus-visible:ring-input-border-focused [&::-webkit-details-marker]:hidden"
          >
            <ChevronRightIcon
              className="size-3.5 transition-transform group-open/raw:rotate-90 motion-reduce:transition-none"
              aria-hidden
            />
            {intl.formatMessage({ id: "ompInteractions.viewOriginal" })}
          </summary>
          <pre
            data-testid="omp-agent-interaction-original-body"
            className="mt-2 max-h-72 overflow-y-auto whitespace-pre-wrap break-words rounded-lg border border-border bg-surface p-3 font-mono text-ui-sm leading-relaxed text-foreground-subtle [overflow-wrap:anywhere]"
          >
            {content.body}
          </pre>
          {event.delivery || event.replyTo ? (
            <p className="mt-2 flex flex-wrap gap-3 break-all text-ui-xs text-foreground-subtle">
              {event.delivery ? (
                <span>
                  {intl.formatMessage({ id: `ompInteractions.delivery.${event.delivery}` })}
                </span>
              ) : null}
              {event.replyTo ? (
                <span>
                  {intl.formatMessage({ id: "ompInteractions.replyTo" }, { id: event.replyTo })}
                </span>
              ) : null}
            </p>
          ) : null}
          {event.error ? (
            <p className="mt-2 whitespace-pre-wrap break-words text-ui-sm text-destructive">
              {event.error}
            </p>
          ) : null}
        </details>
      ) : null}
    </div>
  );
});

export function InteractionTime({ event }: { event: ZCodeAgentInteractionEvent }) {
  const { intl, locale } = useZCodeIntl();
  if (event.timestamp === undefined || event.timeBasis === "unknown") {
    return (
      <span className="text-ui-sm text-foreground-subtlest">
        {intl.formatMessage({ id: "ompInteractions.unknownTime" })}
      </span>
    );
  }
  const date = new Date(event.timestamp);
  return (
    <span className="flex shrink-0 items-center gap-1.5 text-ui-sm text-foreground-subtle">
      <span className="text-ui-xs">
        {intl.formatMessage({
          id:
            event.timeBasis === "sent"
              ? "ompInteractions.sentTime"
              : "ompInteractions.recordedTime",
        })}
      </span>
      <time
        dateTime={date.toISOString()}
        title={date.toLocaleString(locale)}
        className="tabular-nums"
      >
        {date.toLocaleTimeString(locale, {
          hour: "2-digit",
          minute: "2-digit",
          second: "2-digit",
          hour12: false,
        })}
      </time>
    </span>
  );
}

export function InteractionRoute({ from, to }: { from: string; to: string }) {
  return (
    <span className="flex min-w-0 items-center gap-1.5 font-medium">
      <span className="truncate" title={from}>
        {from}
      </span>
      <ArrowRightIcon className="size-3.5 shrink-0 text-brand" aria-hidden />
      <span className="truncate" title={to}>
        {to}
      </span>
    </span>
  );
}

export const InteractionHistory = memo(function InteractionHistory({
  events,
  selectedId,
  labels,
  onSelect,
}: {
  events: readonly ZCodeAgentInteractionEvent[];
  selectedId?: string;
  labels: ReadonlyMap<string, string>;
  onSelect: (id: string) => void;
}) {
  const { intl } = useZCodeIntl();
  const scrollRef = useRef<HTMLDivElement>(null);
  const virtualizer = useVirtualizer({
    count: events.length,
    getScrollElement: () => scrollRef.current,
    estimateSize: () => 68,
    getItemKey: (index) => events[index]?.eventId ?? index,
    overscan: 5,
    initialRect: { width: 600, height: 272 },
  });
  return (
    <div
      ref={scrollRef}
      role="list"
      aria-label={intl.formatMessage({ id: "ompInteractions.selectMessage" })}
      className="max-h-80 overflow-y-auto overscroll-contain rounded-lg border border-border"
      style={{ height: Math.min(320, events.length * 68) }}
    >
      <div className="relative w-full" style={{ height: virtualizer.getTotalSize() }}>
        {virtualizer.getVirtualItems().map((item) => {
          const event = events[item.index];
          if (!event) return null;
          return (
            <div
              key={item.key}
              ref={virtualizer.measureElement}
              data-index={item.index}
              role="listitem"
              className="absolute inset-x-0 top-0 px-1 py-0.5"
              style={{ transform: `translateY(${item.start}px)` }}
            >
              <button
                type="button"
                data-testid="omp-agent-interaction-message"
                data-message-id={event.eventId}
                data-from={event.fromAgentId}
                data-to={event.toAgentId}
                data-timestamp={event.timestamp}
                data-time-basis={event.timeBasis}
                data-kind={event.kind}
                data-source={event.source}
                aria-pressed={event.eventId === selectedId}
                className={cn(
                  "flex w-full min-w-0 flex-col gap-1 rounded-md px-3 py-2 text-left text-ui-base transition-colors hover:bg-surface-hover focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-input-border-focused",
                  event.eventId === selectedId
                    ? "bg-selected text-foreground"
                    : "text-foreground-subtle",
                )}
                onClick={() => onSelect(event.eventId)}
              >
                <span className="flex w-full min-w-0 items-center justify-between gap-3">
                  <InteractionRoute
                    from={labels.get(event.fromAgentId) ?? event.fromAgentId}
                    to={labels.get(event.toAgentId) ?? event.toAgentId}
                  />
                  <InteractionTime event={event} />
                </span>
                <span className="flex w-full min-w-0 items-center gap-2 text-ui-sm text-foreground-subtle">
                  <span className="shrink-0 text-ui-xs text-foreground-subtlest">
                    {intl.formatMessage({ id: `ompInteractions.kind.${event.kind}` })}
                  </span>
                  <span className="truncate">{interactionPreview(event, intl)}</span>
                </span>
              </button>
            </div>
          );
        })}
      </div>
    </div>
  );
});

import { memo, useDeferredValue, useMemo, useState } from "react";
import type {
  ZCodeAgentInteractionEvent,
  ZCodeSessionAgentInteractionsResult,
} from "@zcode/shared";
import { GitBranchIcon, HistoryIcon, RefreshCwIcon, SearchIcon } from "lucide-react";
import { OmpAgentInteractionGraph } from "@/app-shell/OmpAgentInteractionGraph.js";
import { OmpInteractionHeroBackground } from "@/app-shell/OmpInteractionHeroBackground.js";
import {
  InteractionHistory,
  InteractionMessageContent,
  InteractionRoute,
  InteractionTime,
} from "@/app-shell/OmpInteractionEventPresentation.js";
import {
  buildOmpInteractionGraph,
  filterOmpInteractionEvents,
  resolveOmpInteractionSelection,
} from "@/app-shell/ompAgentInteractionViewModel.js";
import { Button } from "@/components/ui/button.js";
import { Input } from "@/components/ui/input.js";
import { useZCodeIntl } from "@/i18n/IntlProvider.js";
import { ThemeHeroVisual } from "@/openWorkspacePageThemeHero.js";

const EMPTY_EVENTS: readonly ZCodeAgentInteractionEvent[] = [];
const EMPTY_AGENTS: ZCodeSessionAgentInteractionsResult["agents"] = [];

export const OmpAgentInteractionsView = memo(function OmpAgentInteractionsView({
  result,
  loading,
  error,
  active = true,
  onRefresh,
  onLoadMore,
  loadingMore = false,
}: {
  result: ZCodeSessionAgentInteractionsResult | null;
  loading: boolean;
  error: string | null;
  active?: boolean;
  onRefresh: () => void;
  onLoadMore?: () => void;
  loadingMore?: boolean;
}) {
  const { intl } = useZCodeIntl();
  const [selectedId, setSelectedId] = useState<string | null>(null);
  const [query, setQuery] = useState("");
  const [agentId, setAgentId] = useState("");
  const deferredQuery = useDeferredValue(query);
  const events = result?.events ?? EMPTY_EVENTS;
  const agents = result?.agents ?? EMPTY_AGENTS;
  const model = useMemo(() => buildOmpInteractionGraph(agents, events), [agents, events]);
  const labels = useMemo(
    () =>
      new Map(
        model.nodes.map(({ agent }) => [
          agent.id,
          agent.id === "main"
            ? intl.formatMessage({ id: "ompInteractions.mainAgent" })
            : agent.label,
        ]),
      ),
    [model, intl],
  );
  const filtered = useMemo(
    () => filterOmpInteractionEvents(events, agents, deferredQuery, agentId),
    [events, agents, deferredQuery, agentId],
  );
  const selected = resolveOmpInteractionSelection(filtered, selectedId);
  const pulseKey = `${selected?.eventId ?? ""}:${events.at(-1)?.eventId ?? ""}`;
  if (!active) return null;
  return (
    <div
      data-testid="omp-agent-interactions-view"
      data-root-session-id={result?.rootSessionId}
      className="flex h-full min-h-0 flex-col overflow-y-auto bg-background text-foreground"
    >
      <ThemeHeroVisual className="shrink-0" contentClassName="relative pb-4">
        <OmpInteractionHeroBackground active={active} pulseKey={pulseKey} />
        <div className="relative z-10 flex flex-wrap items-start justify-between gap-3 px-4 pt-5">
          <div className="min-w-0">
            <h2 className="flex items-center gap-2 text-ui-base font-medium">
              <GitBranchIcon className="size-4 text-brand" aria-hidden />
              {intl.formatMessage({ id: "ompInteractions.title" })}
            </h2>
            <p className="mt-1 text-ui-sm text-foreground-subtle">
              {intl.formatMessage({ id: "ompInteractions.description" })}
            </p>
          </div>
          <Button
            variant="ghost"
            size="icon"
            onClick={onRefresh}
            disabled={loading}
            aria-label={intl.formatMessage({ id: "ompInteractions.refresh" })}
            title={intl.formatMessage({ id: "ompInteractions.refresh" })}
          >
            <RefreshCwIcon className="size-3.5" aria-hidden />
          </Button>
        </div>
        <div className="relative z-10 mt-3 flex flex-wrap items-center gap-3 px-4 text-ui-xs text-foreground-subtle">
          <span>
            {intl.formatMessage(
              { id: "ompInteractions.agentCount" },
              { count: model.nodes.length },
            )}
          </span>
          <span>
            {intl.formatMessage(
              { id: "ompInteractions.messageCount" },
              { count: result?.totalEvents ?? 0 },
            )}
          </span>
        </div>
        {model.nodes.length ? (
          <OmpAgentInteractionGraph model={model} selected={selected} active={active} />
        ) : null}
        {selected ? (
          <section
            data-testid="omp-agent-interaction-detail"
            data-message-id={selected.eventId}
            data-from={selected.fromAgentId}
            data-to={selected.toAgentId}
            data-timestamp={selected.timestamp}
            data-time-basis={selected.timeBasis}
            data-kind={selected.kind}
            data-source={selected.source}
            aria-label={intl.formatMessage({ id: "ompInteractions.selectedMessage" })}
            className="relative z-10 mx-4 rounded-xl border border-card-border bg-card/95 p-4 shadow-sm"
          >
            <div className="flex flex-wrap items-center justify-between gap-x-3 gap-y-2 text-ui-base">
              <InteractionRoute
                from={labels.get(selected.fromAgentId) ?? selected.fromAgentId}
                to={labels.get(selected.toAgentId) ?? selected.toAgentId}
              />
              <InteractionTime event={selected} />
            </div>
            <div className="mt-2 flex flex-wrap gap-x-3 gap-y-1 text-ui-xs text-foreground-subtle">
              <span>{intl.formatMessage({ id: `ompInteractions.kind.${selected.kind}` })}</span>
              {selected.delivery === "failed" ? (
                <span className="text-destructive">
                  {intl.formatMessage({ id: `ompInteractions.delivery.${selected.delivery}` })}
                </span>
              ) : null}
            </div>
            <InteractionMessageContent event={selected} />
          </section>
        ) : null}
      </ThemeHeroVisual>
      <div className="space-y-3 px-4 py-4">
        {result?.coverage.status === "partial" ? (
          <div
            role="status"
            data-testid="omp-agent-interactions-coverage"
            className="rounded-xl border border-warning/20 bg-warning/5 px-3 py-2 text-ui-sm text-foreground-subtle"
          >
            <p className="font-medium text-foreground">
              {intl.formatMessage({ id: "ompInteractions.coveragePartial" })}
            </p>
            {result.coverage.issues.map((issue) => (
              <p key={issue} className="mt-1">
                {intl.formatMessage({ id: `ompInteractions.coverage.${issue}` })}
              </p>
            ))}
          </div>
        ) : null}
        {error ? (
          <div
            role="alert"
            className="flex flex-wrap items-center justify-between gap-2 rounded-xl border border-destructive/20 px-3 py-2 text-ui-sm"
          >
            <span>{intl.formatMessage({ id: "ompInteractions.error" })}</span>
            <Button variant="outline" size="sm" onClick={onRefresh}>
              {intl.formatMessage({ id: "ompInteractions.retry" })}
            </Button>
          </div>
        ) : null}
        <div className="flex flex-wrap items-center justify-between gap-2">
          <h3 className="flex items-center gap-2 text-ui-base font-medium">
            <HistoryIcon className="size-3.5 text-foreground-subtle" aria-hidden />
            {intl.formatMessage({ id: "ompInteractions.history" })}
          </h3>
          {result ? (
            <span className="text-ui-xs text-foreground-subtlest">
              {intl.formatMessage(
                { id: "ompInteractions.recordsRemaining" },
                { loaded: events.length, count: result.totalEvents },
              )}
            </span>
          ) : null}
        </div>
        {events.length ? (
          <div className="flex flex-wrap items-center gap-2">
            <div className="relative min-w-0 flex-1 basis-40">
              <SearchIcon
                className="pointer-events-none absolute left-2 top-1/2 size-3.5 -translate-y-1/2 text-foreground-subtlest"
                aria-hidden
              />
              <Input
                data-testid="omp-agent-interactions-search"
                value={query}
                onChange={(event) => setQuery(event.target.value)}
                className="pl-7"
                placeholder={intl.formatMessage({ id: "ompInteractions.search" })}
                aria-label={intl.formatMessage({ id: "ompInteractions.search" })}
              />
            </div>
            <select
              value={agentId}
              onChange={(event) => setAgentId(event.target.value)}
              aria-label={intl.formatMessage({ id: "ompInteractions.allAgents" })}
              className="h-7 max-w-full rounded-lg border border-input-border bg-input px-2 text-ui-sm text-foreground outline-none focus-visible:border-input-border-focused"
            >
              <option value="">{intl.formatMessage({ id: "ompInteractions.allAgents" })}</option>
              {model.nodes.map(({ agent }) => (
                <option key={agent.id} value={agent.id}>
                  {labels.get(agent.id)}
                </option>
              ))}
            </select>
          </div>
        ) : null}
        {loading && !result ? (
          <p role="status" className="py-6 text-center text-ui-sm text-foreground-subtle">
            {intl.formatMessage({ id: "ompInteractions.loading" })}
          </p>
        ) : events.length === 0 && !error ? (
          <div className="py-6 text-center">
            <p className="text-ui-base">{intl.formatMessage({ id: "ompInteractions.empty" })}</p>
            <p className="mt-1 text-ui-sm text-foreground-subtle">
              {intl.formatMessage({ id: "ompInteractions.emptyDescription" })}
            </p>
          </div>
        ) : filtered.length ? (
          <InteractionHistory
            key={JSON.stringify([deferredQuery, agentId])}
            events={filtered}
            selectedId={selected?.eventId}
            labels={labels}
            onSelect={setSelectedId}
          />
        ) : events.length ? (
          <p className="py-6 text-center text-ui-sm text-foreground-subtle">
            {intl.formatMessage({ id: "ompInteractions.noMatches" })}
          </p>
        ) : null}
        {result?.nextCursor && onLoadMore ? (
          <Button
            variant="outline"
            className="w-full"
            onClick={onLoadMore}
            disabled={loadingMore || loading}
          >
            {intl.formatMessage({
              id: loadingMore ? "ompInteractions.loading" : "ompInteractions.loadMore",
            })}
          </Button>
        ) : null}
      </div>
    </div>
  );
});

import { memo, useEffect, useId, useMemo, useRef, useState } from "react";
import type { ZCodeAgentInteractionEvent } from "@zcode/shared";
import { BotIcon, OrbitIcon } from "lucide-react";
import { cn } from "@/components/lib/utils.js";
import { useZCodeIntl } from "@/i18n/IntlProvider.js";
import {
  buildOmpInteractionGraph,
  type OmpInteractionGraphModel,
} from "@/app-shell/ompAgentInteractionViewModel.js";

function MessageSignal({ path, eventId }: { path: string; eventId: string }) {
  const previous = useRef(eventId);
  const [visible, setVisible] = useState(false);
  useEffect(() => {
    const changed = previous.current !== eventId;
    previous.current = eventId;
    const reduced = window.matchMedia("(prefers-reduced-motion: reduce)");
    if (!changed || reduced.matches || document.hidden) return;
    setVisible(true);
    const stop = () => setVisible(false);
    const timer = window.setTimeout(stop, 720);
    document.addEventListener("visibilitychange", stop);
    reduced.addEventListener("change", stop);
    return () => {
      window.clearTimeout(timer);
      document.removeEventListener("visibilitychange", stop);
      reduced.removeEventListener("change", stop);
    };
  }, [eventId]);
  return visible ? (
    <circle
      key={eventId}
      r="4"
      fill="var(--color-brand)"
      style={{ filter: "drop-shadow(0 0 5px var(--color-brand))" }}
      aria-hidden="true"
    >
      <animateMotion dur="0.7s" repeatCount="1" path={path} />
    </circle>
  ) : null;
}

export const OmpAgentInteractionGraph = memo(function OmpAgentInteractionGraph({
  model: sourceModel,
  selected,
  active,
}: {
  model: OmpInteractionGraphModel;
  selected: ZCodeAgentInteractionEvent | null;
  active: boolean;
}) {
  const { intl } = useZCodeIntl();
  const id = useId();
  const scrollRef = useRef<HTMLDivElement>(null);
  const [viewportWidth, setViewportWidth] = useState(0);
  const compact = sourceModel.nodes.length <= 6;
  const model = useMemo(
    () =>
      compact && viewportWidth
        ? buildOmpInteractionGraph(
            sourceModel.nodes.map((node) => node.agent),
            sourceModel.routes.flatMap((route) => route.events),
            { viewportWidth },
          )
        : sourceModel,
    [compact, viewportWidth, sourceModel],
  );
  useEffect(() => {
    const element = scrollRef.current;
    if (!active || !element) return;
    const resize = new ResizeObserver(([entry]) => {
      if (entry) setViewportWidth(Math.round(entry.contentRect.width));
    });
    resize.observe(element);
    return () => resize.disconnect();
  }, [active]);
  useEffect(() => {
    if (!active) return;
    const element = scrollRef.current;
    if (!element) return;
    // 常见小型协作始终保留整图概览，不因选中深层消息滚走主智能体。
    if (compact) {
      element.scrollLeft = 0;
      element.scrollTop = 0;
      return;
    }
    if (!selected) return;
    const from = model.nodes.find((node) => node.agent.id === selected.fromAgentId);
    const to = model.nodes.find((node) => node.agent.id === selected.toAgentId);
    if (!from || !to) return;
    element.scrollLeft = Math.max(0, (from.x + to.x - element.clientWidth) / 2);
    element.scrollTop = Math.max(0, (from.y + to.y - element.clientHeight) / 2);
  }, [active, compact, selected?.eventId, model.width, model.height]);
  if (!active) return null;
  const activeRoute = model.routes.find((route) =>
    route.events.some((event) => event.eventId === selected?.eventId),
  );
  // 选中的方向最后绘制，避免其他真实通信线盖住当前箭头。
  const routes = model.routes.filter((route) => route !== activeRoute);
  if (activeRoute) routes.push(activeRoute);
  return (
    <div
      ref={scrollRef}
      data-testid="omp-agent-interaction-graph"
      className={cn("relative w-full overflow-auto overscroll-contain", !compact && "max-h-80")}
      tabIndex={0}
      role="region"
      aria-label={intl.formatMessage({ id: "ompInteractions.graphLabel" })}
    >
      <div className="relative mx-auto" style={{ width: model.width, height: model.height }}>
        <svg
          className="pointer-events-none absolute inset-0 h-full w-full"
          viewBox={`0 0 ${model.width} ${model.height}`}
          aria-hidden="true"
        >
          <defs>
            <marker
              id={`${id}-arrow`}
              markerWidth="7"
              markerHeight="7"
              refX="6"
              refY="3.5"
              orient="auto"
            >
              <path d="M 0 0 L 7 3.5 L 0 7 Z" fill="var(--color-foreground-subtle)" />
            </marker>
            <marker
              id={`${id}-selected`}
              markerWidth="7"
              markerHeight="7"
              refX="6"
              refY="3.5"
              orient="auto"
            >
              <path d="M 0 0 L 7 3.5 L 0 7 Z" fill="var(--color-brand)" />
            </marker>
          </defs>
          {model.hierarchy.map((relation) => (
            <path
              key={JSON.stringify([relation.fromAgentId, relation.toAgentId])}
              data-edge-type="hierarchy"
              d={relation.path}
              fill="none"
              stroke="var(--color-foreground-subtlest)"
              strokeOpacity="0.22"
              strokeDasharray="3 6"
            />
          ))}
          {routes.map((route) => {
            const isSelected = route === activeRoute;
            const event = isSelected ? selected : route.events.at(-1);
            if (!event) return null;
            return (
              <path
                key={JSON.stringify([route.fromAgentId, route.toAgentId])}
                data-testid="omp-agent-interaction-edge"
                data-edge-type="message"
                data-message-id={event.eventId}
                data-message-ids={JSON.stringify(route.events.map((item) => item.eventId))}
                data-from={route.fromAgentId}
                data-to={route.toAgentId}
                data-selected={isSelected}
                d={route.path}
                fill="none"
                stroke={isSelected ? "var(--color-brand)" : "var(--color-foreground-subtle)"}
                strokeWidth={isSelected ? 2.5 : 1.2}
                strokeOpacity={isSelected ? 1 : 0.4}
                markerEnd={`url(#${id}-${isSelected ? "selected" : "arrow"})`}
                style={
                  isSelected ? { filter: "drop-shadow(0 0 4px var(--color-brand))" } : undefined
                }
              />
            );
          })}
          {activeRoute && selected ? (
            <MessageSignal path={activeRoute.path} eventId={selected.eventId} />
          ) : null}
        </svg>
        {model.nodes.map(({ agent, x, y }) => {
          const isSelected = agent.id === selected?.fromAgentId || agent.id === selected?.toAgentId;
          const label =
            agent.id === "main"
              ? intl.formatMessage({ id: "ompInteractions.mainAgent" })
              : agent.label;
          const statusKey =
            agent.status &&
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
            ].includes(agent.status)
              ? `ompInteractions.status.${agent.status}`
              : null;
          return (
            <div
              key={agent.id}
              data-testid="omp-agent-interaction-node"
              data-agent-id={agent.id}
              data-label={agent.label}
              data-parent-agent-id={agent.parentAgentId}
              data-selected={isSelected}
              title={agent.label}
              className={cn(
                "absolute flex flex-col justify-center rounded-xl border bg-card/95 px-3 text-ui-base text-foreground shadow-sm transition-colors motion-reduce:transition-none",
                isSelected ? "border-brand ring-2 ring-brand/10" : "border-card-border",
              )}
              style={{
                left: x - model.nodeWidth / 2,
                top: y - model.nodeHeight / 2,
                width: model.nodeWidth,
                height: model.nodeHeight,
                ...(isSelected
                  ? {
                      boxShadow: "0 0 24px color-mix(in srgb, var(--color-brand) 14%, transparent)",
                    }
                  : {}),
              }}
            >
              <span className="flex min-w-0 items-center gap-2 font-medium">
                {agent.id === "main" ? (
                  <OrbitIcon className="size-4 shrink-0 text-brand" aria-hidden />
                ) : (
                  <BotIcon className="size-4 shrink-0 text-brand" aria-hidden />
                )}
                <span className="truncate">{label}</span>
              </span>
              <span className="mt-1 truncate pl-6 text-ui-sm text-foreground-subtle">
                {agent.known === false
                  ? intl.formatMessage({ id: "ompInteractions.unknownAgent" })
                  : statusKey
                    ? intl.formatMessage({ id: statusKey })
                    : agent.status || agent.id}
              </span>
            </div>
          );
        })}
      </div>
    </div>
  );
});

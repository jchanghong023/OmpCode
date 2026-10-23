import "./team-run.css";
import { useMemo, useState, type ReactNode } from "react";
import { ArrowRight, Bot, Clock3, FileText, Square, X } from "lucide-react";
import type { OmpTeamRun } from "@zcode/shared";
import { Button } from "@/components/ui/button.js";
import { useZCodeIntl } from "@/i18n/index.js";
import { WorkflowCardHeader } from "@/components/workflow-timeline/WorkflowCardChrome.js";
import { WorkflowTimeline } from "@/components/workflow-timeline/WorkflowTimeline.js";
import type { WorkflowTimelineModel } from "@/components/workflow-timeline/timeline-model.js";

/** Native observations are mapped to presentation only, never to workflow execution state. */
function teamTimeline(run: OmpTeamRun): WorkflowTimelineModel {
  const stations = run.nodes.map((node) => {
    const status =
      node.status === "running"
        ? ("running" as const)
        : node.status === "completed"
          ? ("done" as const)
          : node.status === "failed" || node.status === "errored"
            ? ("failed" as const)
            : ("pending" as const);
    return {
      id: node.id,
      naming: { id: node.id, name: node.stage ?? node.role },
      pills: [
        {
          key: node.id,
          lane: { id: node.id, name: node.label, laneClass: "agent" as const },
          laneClass: "agent" as const,
          status,
          stepIds: [node.id],
        },
      ],
      status,
      visited: true,
      rounds: node.round ?? 1,
      onLoop: false,
      track: 0,
    };
  });
  const indexes = new Map(stations.map((station, index) => [station.id, index]));
  const arcs: WorkflowTimelineModel["arcs"] = [];
  const rails: WorkflowTimelineModel["rails"] = [];
  for (const edge of run.edges) {
    const from = indexes.get(edge.source);
    const to = indexes.get(edge.target);
    if (from === undefined || to === undefined) continue;
    const ink = stations[to]?.status === "running" ? "march" : "strong";
    if (to === from + 1) rails.push({ from, to, ink });
    else {
      arcs.push({ from, to, lane: arcs.length, air: 0, ink });
      if (to <= from) {
        stations[from]!.onLoop = true;
        stations[to]!.onLoop = true;
      }
    }
  }
  const runningIndex = stations.findLastIndex((station) => station.status === "running");
  return {
    stations,
    rails,
    arcs,
    bands: [],
    runningIndex: runningIndex < 0 ? undefined : runningIndex,
    live: true,
  };
}

export function TeamChatCard({
  run,
  connected,
  busy,
  error,
  onOpenDetails,
  onStop,
}: {
  run: OmpTeamRun;
  connected: boolean;
  busy: boolean;
  error?: string | null;
  onOpenDetails: () => void;
  onStop?: () => void;
}) {
  const { locale } = useZCodeIntl();
  const zh = locale.startsWith("zh");
  const model = useMemo(() => teamTimeline(run), [run]);
  const active = connected && run.source === "native-live" && run.status === "running";
  const labels = {
    running: zh ? "运行中" : "Running",
    completed: zh ? "已完成" : "Completed",
    failed: zh ? "失败" : "Failed",
    cancelled: zh ? "已取消" : "Cancelled",
    unavailable: zh ? "不可用" : "Unavailable",
  };
  return (
    <article
      data-testid="omp-team-chat-card"
      data-job-id={run.jobId}
      data-status={run.status}
      className="grid min-w-0 gap-3 overflow-hidden rounded-lg border border-border bg-card p-3"
    >
      <WorkflowCardHeader
        kind="Team"
        name={run.label}
        expanded
        live={active}
        status={
          <span
            data-testid="omp-team-stage"
            data-stage={run.stage}
            className={`text-ui-caption ${statusColor(run.status)}`}
          >
            {labels[run.status]}
            {run.stage ? ` · ${run.stage}` : ""}
          </span>
        }
        onOpenDetails={onOpenDetails}
        trailing={
          onStop && run.status === "running" ? (
            <Button
              data-testid="omp-team-stop"
              size="sm"
              variant="ghost"
              disabled={!active || busy}
              onClick={onStop}
            >
              <Square className="size-3 fill-current" />
              {zh ? "取消运行" : "Cancel run"}
            </Button>
          ) : undefined
        }
      />
      <WorkflowTimeline model={model} onSelectStation={onOpenDetails} onOpenPill={onOpenDetails} />
      {run.nodes.length === 0 && (
        <p className="text-ui-caption text-foreground-subtle">
          {zh ? "等待原生 Agent 调用观测" : "Waiting for native Agent observations"}
        </p>
      )}
      {!connected && (
        <p role="status" className="text-ui-caption text-foreground-subtle">
          {zh
            ? "连接已中断；保留最后观测，恢复后重新读取原生状态。"
            : "Disconnected; retaining the last observation until native state is available."}
        </p>
      )}
      {run.unavailable.length > 0 && (
        <ul
          data-testid="omp-team-unavailable"
          className="grid gap-1 text-ui-caption text-foreground-subtle"
        >
          {run.unavailable.map((reason, index) => (
            <li key={index}>{reason}</li>
          ))}
        </ul>
      )}
      {(error || run.error) && (
        <p role="alert" className="break-words text-ui-caption text-destructive">
          {error ?? run.error}
        </p>
      )}
      {(run.report !== undefined || run.result !== undefined) && (
        <section
          data-testid="omp-team-result"
          className="grid min-w-0 gap-3 border-t border-border pt-3"
        >
          <h3 className="text-ui-base font-medium">{zh ? "最终方案" : "Final proposal"}</h3>
          {run.report !== undefined && (
            <ObservationContent
              value={run.report}
              rawLabel={zh ? "查看原始观测" : "View raw observation"}
            />
          )}
          {run.result !== undefined && (
            <ObservationContent
              value={run.result}
              rawLabel={zh ? "查看原始观测" : "View raw observation"}
            />
          )}
        </section>
      )}
    </article>
  );
}

function record(value: unknown): Record<string, unknown> | undefined {
  return value !== null && typeof value === "object" && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : undefined;
}

function ObservationBody({ value }: { value: unknown }): ReactNode {
  if (Array.isArray(value)) {
    return value.length ? (
      <ul className="grid min-w-0 list-disc gap-2 pl-4">
        {value.map((item, index) => (
          <li key={index} className="min-w-0">
            <ObservationBody value={item} />
          </li>
        ))}
      </ul>
    ) : (
      <span>[]</span>
    );
  }
  const item = record(value);
  if (item) {
    // 原生 yield 的正文位于结构化字段中；不能只取 text/content 而把 data 藏进原始观测。
    const fields = Object.entries(item);
    return fields.length ? (
      <dl className="grid min-w-0 gap-2">
        {fields.map(([key, field]) => (
          <div key={key} className="grid min-w-0 gap-1">
            <dt className="break-words text-ui-xs font-medium text-foreground-subtle">{key}</dt>
            <dd className="min-w-0">
              <ObservationBody value={field} />
            </dd>
          </div>
        ))}
      </dl>
    ) : (
      <span>{"{}"}</span>
    );
  }
  if (value === undefined) return null;
  return <p className="whitespace-pre-wrap break-words">{String(value)}</p>;
}

function statusColor(status: string): string {
  if (status === "running") return "text-warning";
  if (status === "completed") return "text-success";
  if (status === "failed" || status === "errored") return "text-destructive";
  return "text-foreground-subtle";
}

function ObservationContent({ value, rawLabel }: { value: unknown; rawLabel: string }) {
  const structured = typeof value !== "string";
  return (
    <div className="grid min-w-0 gap-2">
      <div className="max-h-80 min-w-0 overflow-auto text-ui-caption leading-relaxed">
        <ObservationBody value={value} />
      </div>
      {structured && (
        <details className="min-w-0 text-ui-caption text-foreground-subtle">
          <summary className="cursor-pointer py-1 hover:text-foreground">{rawLabel}</summary>
          <pre className="mt-2 max-h-80 overflow-auto whitespace-pre-wrap break-all rounded-md bg-surface p-3 text-ui-caption">
            {JSON.stringify(value, null, 2)}
          </pre>
        </details>
      )}
    </div>
  );
}

export function TeamRunView({
  run,
  connected,
  busy,
  onStop,
}: {
  run: OmpTeamRun;
  connected: boolean;
  busy: boolean;
  onStop: () => void;
}) {
  const { locale } = useZCodeIntl();
  const zh = locale.startsWith("zh");
  const [nodeId, setNodeId] = useState<string | null>(null);
  const selected = run.nodes.find((node) => node.id === nodeId);
  const active = connected && run.source === "native-live" && run.status === "running";
  const rawLabel = zh ? "查看原始观测" : "View raw observation";
  const statusLabels: Record<string, string> = {
    running: zh ? "运行中" : "Running",
    completed: zh ? "已完成" : "Completed",
    failed: zh ? "失败" : "Failed",
    cancelled: zh ? "已取消" : "Cancelled",
    unavailable: zh ? "不可用" : "Unavailable",
  };
  return (
    <article
      data-testid="omp-team-run"
      data-job-id={run.jobId}
      data-status={run.status}
      className="min-w-0 overflow-hidden rounded-lg border border-border bg-card"
    >
      <header className="grid gap-2 border-b border-border px-4 py-3">
        <div className="flex min-w-0 items-center gap-2">
          <Bot className="size-4 shrink-0 text-foreground-subtle" />
          <h2
            title={run.label}
            className="min-w-0 flex-1 truncate font-mono text-ui-base font-medium"
          >
            {run.label}
          </h2>
          <Button
            data-testid="omp-team-stop"
            size="sm"
            variant="outline"
            disabled={!active || busy}
            onClick={onStop}
          >
            <Square className="size-3 fill-current" />
            {zh ? "取消运行" : "Cancel run"}
          </Button>
        </div>
        <div className="flex min-w-0 flex-wrap items-center gap-x-3 gap-y-1 text-ui-caption text-foreground-subtle">
          <span
            data-testid="omp-team-stage"
            data-stage={run.stage}
            className={`inline-flex items-center gap-1.5 ${statusColor(run.status)}`}
          >
            <span aria-hidden="true" className="size-2 shrink-0 rounded-full bg-current" />
            {statusLabels[run.status] ?? run.status}
            {run.stage ? ` · ${run.stage}` : ""}
          </span>
          <span>
            {run.source === "native-live"
              ? zh
                ? "实时观测"
                : "Live observation"
              : zh
                ? "历史记录"
                : "Journal"}
          </span>
          <span>
            {run.nodes.length} {zh ? "次调用" : "invocations"} · {run.edges.length}{" "}
            {zh ? "条关系" : "relationships"}
          </span>
        </div>
      </header>
      {!connected && (
        <p
          role="status"
          className="border-b border-border px-4 py-2 text-ui-caption text-foreground-subtle"
        >
          {zh
            ? "连接已中断；保留最后观测，恢复后重新读取原生状态。"
            : "Disconnected; showing the last observation until native state can be read again."}
        </p>
      )}
      <div
        className={`grid min-w-0 ${selected ? "lg:grid-cols-[minmax(0,1fr)_minmax(16rem,0.8fr)]" : ""}`}
      >
        <div className="grid min-w-0 content-start gap-5 p-4">
          <section
            aria-label={zh ? "Agent 调用图" : "Agent invocation graph"}
            data-testid="omp-team-graph"
            className="grid min-w-0 gap-3"
          >
            <h3 className="text-ui-caption font-medium text-foreground-subtle">
              {zh ? "Agent 调用" : "Agent invocations"}
            </h3>
            <div className="grid min-w-0 gap-2 sm:grid-cols-2">
              {run.nodes.map((node) => (
                <button
                  key={node.id}
                  type="button"
                  data-testid="omp-team-node"
                  data-node-id={node.id}
                  data-model={node.model}
                  data-role={node.role}
                  data-stage={node.stage}
                  data-running={active && node.status === "running"}
                  aria-pressed={nodeId === node.id}
                  onClick={() => setNodeId(node.id)}
                  className={`omp-team-invocation group grid min-w-0 gap-2 rounded-lg border p-3 text-left outline-none transition-colors focus-visible:ring-2 focus-visible:ring-ring ${nodeId === node.id ? "border-border-hover bg-card-selected" : "border-border bg-background hover:bg-surface"}`}
                >
                  <div className="flex min-w-0 items-center gap-2">
                    <Bot className="size-3.5 shrink-0 text-foreground-subtle" />
                    <strong
                      className="min-w-0 flex-1 truncate text-ui-base font-medium"
                      title={node.label}
                    >
                      {node.label}
                    </strong>
                    <span
                      className={`inline-flex shrink-0 items-center gap-1.5 text-ui-xs ${statusColor(node.status)}`}
                    >
                      <span
                        aria-hidden="true"
                        className="omp-team-node-lamp size-1.5 rounded-full bg-current"
                      />
                      {statusLabels[node.status] ?? node.status}
                    </span>
                  </div>
                  <p
                    className="truncate text-ui-caption text-foreground-subtle"
                    title={[node.role, node.stage, node.model].filter(Boolean).join(" · ")}
                  >
                    {[node.role, node.stage, node.model].filter(Boolean).join(" · ")}
                  </p>
                  <div className="flex min-w-0 items-center justify-between gap-2 text-ui-xs text-foreground-subtlest">
                    <span title={node.id} className="min-w-0 truncate font-mono">
                      {node.id}
                    </span>
                    <span className="shrink-0">
                      {node.tools.length} {zh ? "工具" : "tools"} · {node.messages.length}{" "}
                      {zh ? "消息" : "messages"}
                    </span>
                  </div>
                </button>
              ))}
            </div>
            {run.nodes.length === 0 && (
              <p className="py-3 text-ui-caption text-foreground-subtle">
                {zh
                  ? "尚无可用的 Agent 调用观测。"
                  : "No Agent invocation observations are available."}
              </p>
            )}
            {run.edges.length > 0 && (
              <h3 className="mt-1 text-ui-caption font-medium text-foreground-subtle">
                {zh ? "已观测交互" : "Observed relationships"}
              </h3>
            )}
            <ul
              aria-label={zh ? "真实有向交互关系" : "Observed directed relationships"}
              className="grid min-w-0 divide-y divide-border"
            >
              {run.edges.map((edge, index) => (
                <li
                  key={`${edge.source}:${edge.target}:${index}`}
                  data-testid="omp-team-edge"
                  data-source={edge.source}
                  data-target={edge.target}
                  data-kind={edge.kind}
                  className="min-w-0 py-2 text-ui-caption"
                >
                  <div className="flex min-w-0 flex-wrap items-center gap-2">
                    <span className="min-w-0 break-words">
                      {run.nodes.find((node) => node.id === edge.source)?.label ?? edge.source}
                    </span>
                    <svg
                      aria-hidden="true"
                      viewBox="0 0 40 12"
                      className="h-3 w-10 shrink-0 text-foreground-subtle"
                    >
                      <path
                        className="omp-team-flow"
                        data-active={
                          active &&
                          run.nodes.some(
                            (node) => node.id === edge.target && node.status === "running",
                          )
                        }
                        d="M0 6H34"
                        fill="none"
                        stroke="currentColor"
                        strokeWidth="1.5"
                      />
                      <path
                        d="M32 2L38 6L32 10"
                        fill="none"
                        stroke="currentColor"
                        strokeWidth="1.5"
                      />
                    </svg>
                    <span className="min-w-0 break-words">
                      {run.nodes.find((node) => node.id === edge.target)?.label ?? edge.target}
                    </span>
                    <span className="rounded bg-surface px-1.5 py-0.5 text-ui-xs text-foreground-subtle">
                      {edge.kind}
                    </span>
                  </div>
                  <details className="mt-1 text-foreground-subtle">
                    <summary className="cursor-pointer hover:text-foreground">
                      {zh ? "关系证据" : "Relationship evidence"}
                    </summary>
                    <p className="mt-1 whitespace-pre-wrap break-words leading-relaxed">
                      {edge.evidence}
                    </p>
                  </details>
                </li>
              ))}
            </ul>
          </section>
          <section className="grid min-w-0 gap-3">
            <h3 className="flex items-center gap-2 text-ui-caption font-medium text-foreground-subtle">
              <Clock3 className="size-3.5" />
              {zh ? "调用时间线" : "Invocation timeline"}
            </h3>
            <ol
              data-testid="omp-team-timeline"
              className="ml-1 grid min-w-0 border-l border-border"
            >
              {run.timeline.map((event) => (
                <li
                  key={event.sequence}
                  className="relative min-w-0 pb-3 pl-4 text-ui-caption last:pb-0"
                >
                  <span
                    aria-hidden="true"
                    className="absolute -left-1 top-1.5 size-2 rounded-full border border-border bg-card"
                  />
                  <details>
                    <summary className="cursor-pointer break-words text-foreground-subtle hover:text-foreground">
                      <span className="mr-2 font-mono text-ui-xs">
                        {new Date(event.timestamp).toLocaleTimeString(locale)}
                      </span>
                      <span className="text-foreground">{event.kind}</span>
                      {event.nodeId && (
                        <span className="ml-2 break-all">
                          {run.nodes.find((node) => node.id === event.nodeId)?.label ??
                            event.nodeId}
                        </span>
                      )}
                      <span className="ml-2 text-ui-xs text-foreground-subtlest">
                        #{event.sequence}
                      </span>
                    </summary>
                    <div className="mt-2">
                      <ObservationContent value={event.data} rawLabel={rawLabel} />
                    </div>
                  </details>
                </li>
              ))}
            </ol>
            {run.timeline.length === 0 && (
              <p className="text-ui-caption text-foreground-subtle">
                {zh ? "暂无可用时间线记录。" : "No timeline records are available."}
              </p>
            )}
          </section>
        </div>
        {selected && (
          <section
            data-testid="omp-team-node-detail"
            className="grid min-w-0 content-start gap-4 border-t border-border bg-background p-4 lg:border-l lg:border-t-0"
          >
            <div className="flex min-w-0 items-start gap-2">
              <div className="min-w-0 flex-1">
                <h3 className="break-words text-ui-base font-medium">{selected.label}</h3>
                <p className="mt-1 break-all font-mono text-ui-xs text-foreground-subtlest">
                  {selected.id}
                </p>
              </div>
              <Button
                size="icon-sm"
                variant="ghost"
                aria-label={zh ? "关闭调用详情" : "Close invocation details"}
                onClick={() => setNodeId(null)}
              >
                <X className="size-3.5" />
              </Button>
            </div>
            <p className="break-words text-ui-caption text-foreground-subtle">
              {zh ? "只读调用详情" : "Read-only invocation detail"} ·{" "}
              {[selected.stage, selected.model].filter(Boolean).join(" · ")}
            </p>
            {selected.error && (
              <p role="alert" className="break-words text-ui-caption text-destructive">
                {selected.error}
              </p>
            )}
            {selected.output !== undefined && (
              <div className="grid min-w-0 gap-2">
                <h4 className="flex items-center gap-2 text-ui-caption font-medium">
                  <FileText className="size-3.5" />
                  {zh ? "输出" : "Output"}
                </h4>
                <ObservationContent value={selected.output} rawLabel={rawLabel} />
              </div>
            )}
            <div className="grid min-w-0 gap-2">
              <h4 className="text-ui-caption font-medium">
                {zh ? "工具调用" : "Tool calls"}{" "}
                <span className="text-foreground-subtlest">{selected.tools.length}</span>
              </h4>
              <div className="flex min-w-0 flex-wrap gap-1.5">
                {selected.tools.map((tool, index) => {
                  const item = record(tool);
                  const name =
                    typeof item?.name === "string"
                      ? item.name
                      : typeof item?.toolName === "string"
                        ? item.toolName
                        : `${zh ? "工具" : "Tool"} ${index + 1}`;
                  return (
                    <details
                      key={index}
                      className="max-w-full rounded-md border border-border bg-card px-2 py-1 text-ui-caption"
                    >
                      <summary className="cursor-pointer break-words">{name}</summary>
                      <div className="mt-2">
                        <ObservationContent value={tool} rawLabel={rawLabel} />
                      </div>
                    </details>
                  );
                })}
              </div>
            </div>
            <div className="grid min-w-0 gap-2">
              <h4 className="text-ui-caption font-medium">
                {zh ? "消息" : "Messages"}{" "}
                <span className="text-foreground-subtlest">{selected.messages.length}</span>
              </h4>
              <div className="grid min-w-0 divide-y divide-border">
                {selected.messages.map((message, index) => {
                  const item = record(message);
                  return (
                    <div key={index} className="grid min-w-0 gap-1.5 py-2">
                      <p className="flex items-center gap-1.5 text-ui-xs text-foreground-subtle">
                        <ArrowRight className="size-3" />
                        {typeof item?.role === "string"
                          ? item.role
                          : `${zh ? "消息" : "Message"} ${index + 1}`}
                      </p>
                      <ObservationContent value={message} rawLabel={rawLabel} />
                    </div>
                  );
                })}
              </div>
            </div>
          </section>
        )}
      </div>
      {run.unavailable.length > 0 && (
        <section
          role="status"
          data-testid="omp-team-unavailable"
          className="border-t border-border px-4 py-3 text-ui-caption text-foreground-subtle"
        >
          <h3 className="mb-1 font-medium">{zh ? "原生观测边界" : "Native observation limits"}</h3>
          <ul className="grid gap-1">
            {run.unavailable.map((reason, i) => (
              <li key={i} className="break-words">
                {reason}
              </li>
            ))}
          </ul>
        </section>
      )}
      {run.error && (
        <p
          role="alert"
          className="break-words border-t border-border px-4 py-3 text-ui-caption text-destructive"
        >
          {run.error}
        </p>
      )}
      {(run.result !== undefined || run.report !== undefined) && (
        <details data-testid="omp-team-result" className="min-w-0 border-t border-border px-4 py-3">
          <summary className="cursor-pointer text-ui-base font-medium">
            {zh ? "原生结果" : "Native result"}
          </summary>
          <div className="mt-3 grid min-w-0 gap-4">
            {run.report !== undefined && (
              <div className="grid min-w-0 gap-2">
                <h4 className="text-ui-caption font-medium text-foreground-subtle">
                  {zh ? "报告" : "Report"}
                </h4>
                <ObservationContent value={run.report} rawLabel={rawLabel} />
              </div>
            )}
            {run.result !== undefined && (
              <div className="grid min-w-0 gap-2">
                <h4 className="text-ui-caption font-medium text-foreground-subtle">
                  {zh ? "结果" : "Result"}
                </h4>
                <ObservationContent value={run.result} rawLabel={rawLabel} />
              </div>
            )}
          </div>
        </details>
      )}
    </article>
  );
}

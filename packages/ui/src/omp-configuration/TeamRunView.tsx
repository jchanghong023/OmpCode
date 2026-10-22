import "./team-run.css";
import { useState } from "react";
import type { OmpTeamRun } from "@zcode/shared";
import { Button } from "@/components/ui/button.js";
import { useZCodeIntl } from "@/i18n/index.js";

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
  return (
    <article
      data-testid="omp-team-run"
      data-job-id={run.jobId}
      data-status={run.status}
      className="grid min-w-0 gap-3 rounded border border-border p-3"
    >
      <header className="flex flex-wrap items-center gap-2">
        <h2 className="text-ui-lg font-medium">{run.label}</h2>
        <span data-testid="omp-team-stage" className="text-ui-caption">
          {run.stage} · {run.status}
        </span>
        <span className="text-ui-caption text-foreground-subtle">{run.source}</span>
        <Button
          data-testid="omp-team-stop"
          variant="outline"
          disabled={!active || busy}
          onClick={onStop}
        >
          {zh ? "取消运行" : "Cancel run"}
        </Button>
      </header>
      {!connected && (
        <p role="status">
          {zh
            ? "连接已中断；保留最后观测，恢复后重新读取原生状态。"
            : "Disconnected; showing the last observation until native state can be read again."}
        </p>
      )}
      <section
        aria-label={zh ? "Agent 调用图" : "Agent invocation graph"}
        data-testid="omp-team-graph"
        className="grid gap-2"
      >
        <div className="flex flex-wrap gap-2">
          {run.nodes.map((node) => (
            <button
              key={node.id}
              type="button"
              data-testid="omp-team-node"
              data-node-id={node.id}
              data-model={node.model}
              aria-pressed={nodeId === node.id}
              onClick={() => setNodeId(node.id)}
              className={`min-w-0 rounded border border-border bg-surface p-2 text-left text-ui-base ${active && node.status === "running" ? "motion-safe:animate-pulse" : ""}`}
            >
              <strong>{node.label}</strong>
              <p className="text-ui-caption">
                {node.role} · {node.status}
              </p>
              <p className="break-all text-ui-caption text-foreground-subtle">
                {node.id} · {node.model}
              </p>
            </button>
          ))}
        </div>
        <ul
          aria-label={zh ? "真实有向交互关系" : "Observed directed relationships"}
          className="grid gap-1"
        >
          {run.edges.map((edge, index) => (
            <li
              key={`${edge.source}:${edge.target}:${index}`}
              data-testid="omp-team-edge"
              data-source={edge.source}
              data-target={edge.target}
              className="break-all rounded bg-surface p-2 text-ui-caption"
            >
              <span>{run.nodes.find((node) => node.id === edge.source)?.label ?? edge.source}</span>
              <svg
                aria-hidden="true"
                viewBox="0 0 80 12"
                className="mx-2 inline-block h-3 w-20 text-brand"
              >
                <path
                  className="omp-team-flow"
                  data-active={active}
                  d="M0 6H74"
                  fill="none"
                  stroke="currentColor"
                  strokeWidth="2"
                />
                <path d="M72 1L79 6L72 11" fill="none" stroke="currentColor" strokeWidth="2" />
              </svg>
              <span>{run.nodes.find((node) => node.id === edge.target)?.label ?? edge.target}</span>{" "}
              · {edge.kind}
              <details>
                <summary>{zh ? "关系证据" : "Relationship evidence"}</summary>
                {edge.evidence}
              </details>
            </li>
          ))}
        </ul>
      </section>
      {selected && (
        <section
          data-testid="omp-team-node-detail"
          className="min-w-0 rounded border border-border p-3"
        >
          <h3 className="text-ui-base font-medium">
            {selected.label} · {selected.id}
          </h3>
          <p>
            {zh ? "只读调用详情" : "Read-only invocation detail"} · {selected.stage} ·{" "}
            {selected.model}
          </p>
          {selected.error && <p role="alert">{selected.error}</p>}
          <pre className="max-h-96 overflow-auto whitespace-pre-wrap break-all text-ui-caption">
            {JSON.stringify(
              { output: selected.output, tools: selected.tools, messages: selected.messages },
              null,
              2,
            )}
          </pre>
        </section>
      )}
      <section>
        <h3 className="text-ui-base font-medium">{zh ? "调用时间线" : "Invocation timeline"}</h3>
        <ol data-testid="omp-team-timeline" className="grid gap-1 border-l border-border pl-3">
          {run.timeline.map((event) => (
            <li key={event.sequence} className="text-ui-caption">
              <details>
                <summary>
                  {event.sequence} · {new Date(event.timestamp).toLocaleTimeString(locale)} ·{" "}
                  {event.kind} {event.nodeId}
                </summary>
                <pre className="overflow-auto whitespace-pre-wrap break-all">
                  {JSON.stringify(event.data, null, 2)}
                </pre>
              </details>
            </li>
          ))}
        </ol>
      </section>
      {run.unavailable.length > 0 && (
        <section role="status" data-testid="omp-team-unavailable">
          <h3>{zh ? "原生观测边界" : "Native observation limits"}</h3>
          <ul>
            {run.unavailable.map((reason, i) => (
              <li key={i}>{reason}</li>
            ))}
          </ul>
        </section>
      )}
      {run.error && <p role="alert">{run.error}</p>}
      {(run.result !== undefined || run.report !== undefined) && (
        <details data-testid="omp-team-result">
          <summary>{zh ? "原生结果" : "Native result"}</summary>
          <pre className="overflow-auto whitespace-pre-wrap break-all text-ui-caption">
            {JSON.stringify({ result: run.result, report: run.report }, null, 2)}
          </pre>
        </details>
      )}
    </article>
  );
}

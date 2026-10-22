import { useEffect, useState } from "react";
import type { RepoStatus, RepoQuery } from "@zcode/shared/omp-indexes";
import { Button } from "@/components/ui/button.js";
import { useOmpIndexes } from "./useOmpIndexes.js";
import type { IndexPageProps } from "./contract.js";
import {
  IndexConfirmation,
  IndexPageFrame,
  indexInputClass,
  useIndexMessage,
} from "./IndexPageControls.js";

type Mutation = "init" | "update" | "rebuild" | "remove";
type Search = {
  action: "text" | "symbol";
  query: string;
  path?: string;
  category?: "source" | "test" | "config" | "other";
  limit: number;
};
export function RepoPage(props: IndexPageProps) {
  const api = useOmpIndexes("repo", props);
  const m = useIndexMessage();
  const [status, setStatus] = useState<RepoStatus | null>(null);
  const [result, setResult] = useState<RepoQuery | null>(null);
  const [query, setQuery] = useState("");
  const [path, setPath] = useState("");
  const [mode, setMode] = useState<"text" | "symbol">("text");
  const [category, setCategory] = useState("");
  const [limit, setLimit] = useState(20);
  const [submitted, setSubmitted] = useState<Search | null>(null);
  const [confirmation, setConfirmation] = useState<{ action: Mutation; root: string } | null>(null);
  const refresh = async () => {
    const value = await api.run<RepoStatus>({ action: "status" });
    if (value && "exists" in value) setStatus(value);
  };
  useEffect(() => {
    setStatus(null);
    setResult(null);
    setSubmitted(null);
    setConfirmation(null);
    if (api.ready)
      void api.run<RepoStatus>({ action: "status" }).then((value) => {
        if (value && "exists" in value) setStatus(value);
      });
  }, [props.workspacePath, props.workspaceIdentity, props.remoteSessionId, api.ready, api.run]);
  const confirm = async () => {
    if (!confirmation) return;
    const command = confirmation;
    setConfirmation(null);
    const value = await api.run({ action: command.action, confirmedRoot: command.root });
    if (!value) return;
    if ("exists" in value) setStatus(value);
    else if ("removed" in value) await refresh();
    setResult(null);
    setSubmitted(null);
  };
  const search = async (next: boolean) => {
    const fields: Search =
      next && submitted
        ? submitted
        : {
            action: mode,
            query: query.trim(),
            limit,
            ...(path.trim() ? { path: path.trim() } : {}),
            ...(category ? { category: category as Search["category"] } : {}),
          };
    const value = await api.run<RepoQuery>({
      ...fields,
      ...(next && result?.cursor ? { cursor: result.cursor } : {}),
    });
    if (!value || !("hits" in value)) return;
    setSubmitted(fields);
    setStatus(value.coverage);
    setResult((previous) =>
      next && previous ? { ...value, hits: [...previous.hits, ...value.hits] } : value,
    );
  };
  const disabled = api.busy || !api.ready;
  return (
    <IndexPageFrame
      title="Repo"
      workspacePath={props.workspacePath}
      remote={api.remote}
      busy={api.busy}
      error={api.error ?? (!api.ready ? m("notReady") : null)}
      progress={api.progress}
      onCancel={() => void api.cancel()}
    >
      <section className="space-y-3" aria-label={m("status")}>
        <div className="flex flex-wrap items-center gap-2">
          <h2 className="mr-auto text-ui-lg font-medium">{m("status")}</h2>
          <Button
            variant="outline"
            disabled={disabled}
            onClick={() => void refresh()}
            data-testid="omp-repo-refresh"
          >
            {m("refresh")}
          </Button>
          {(["init", "update", "rebuild", "remove"] as const).map((action) => (
            <Button
              key={action}
              variant="outline"
              disabled={disabled || !status || (action !== "init" && !status.exists)}
              onClick={() => {
                if (status) setConfirmation({ action, root: status.root });
              }}
              data-testid={`omp-repo-${action}`}
            >
              {m(action)}
            </Button>
          ))}
        </div>
        {status ? (
          <div
            className="space-y-2 rounded-md border border-border p-3"
            data-testid="omp-repo-status"
            data-generation={status.generation ?? ""}
            data-exists={status.exists}
          >
            <p className="break-all" data-testid="omp-repo-root">
              {m("root")}: {status.root}
            </p>
            <p>
              {status.exists ? m("indexed") : m("missing")} · {status.fileCount} {m("files")} ·{" "}
              {status.symbolCount} {m("symbols")}
            </p>
            <p className="break-all text-ui-caption">
              {m("generation")}: {status.generation ?? "—"} · {m("lastCheck")}:{" "}
              {status.lastFullCheck === null
                ? "—"
                : new Date(status.lastFullCheck).toLocaleString()}
            </p>
            <p>
              {m("failures")}: {status.failureCount} · {m("pending")}: {status.pendingCount} ·{" "}
              {m("uncertainties")}: {status.uncertainCount}
            </p>
            {status.incomplete || status.needsReconcile || status.unchecked ? (
              <p role="status">{m("incomplete")}</p>
            ) : null}
            <ul className="text-ui-caption">
              {status.failures.map((failure, position) => (
                <li key={position} className="break-all">
                  {failure.path} · {failure.kind}: {failure.message}
                </li>
              ))}
              {status.pendingPaths.map((item) => (
                <li key={item} className="break-all">
                  {m("pending")}: {item}
                </li>
              ))}
              {status.uncertainReasons.map((item, position) => (
                <li key={position}>{item}</li>
              ))}
            </ul>
            {status.failuresTruncated || status.pendingTruncated || status.uncertaintyTruncated ? (
              <p>{m("truncated")}</p>
            ) : null}
            {status.exclusions.length ? (
              <details>
                <summary>{m("exclusions")}</summary>
                <ul>
                  {status.exclusions.map((item) => (
                    <li key={item} className="break-all">
                      {item}
                    </li>
                  ))}
                </ul>
              </details>
            ) : null}
          </div>
        ) : null}
      </section>
      <section className="space-y-3" aria-label={m("query")}>
        <h2 className="text-ui-lg font-medium">{m("query")}</h2>
        <form
          className="flex flex-wrap items-end gap-2"
          onSubmit={(event) => {
            event.preventDefault();
            void search(false);
          }}
        >
          <label className="flex min-w-48 flex-1 flex-col gap-1">
            {m("query")}
            <input
              className={indexInputClass}
              value={query}
              onChange={(event) => setQuery(event.target.value)}
              required
              disabled={disabled}
              data-testid="omp-repo-query"
            />
          </label>
          <label className="flex flex-col gap-1">
            {m("mode")}
            <select
              className={indexInputClass}
              value={mode}
              onChange={(event) => setMode(event.target.value as "text" | "symbol")}
              disabled={disabled}
              data-testid="omp-repo-mode"
            >
              <option value="text">{m("text")}</option>
              <option value="symbol">{m("symbols")}</option>
            </select>
          </label>
          <label className="flex flex-col gap-1">
            {m("path")}
            <input
              className={indexInputClass}
              value={path}
              onChange={(event) => setPath(event.target.value)}
              disabled={disabled}
              data-testid="omp-repo-path"
            />
          </label>
          <label className="flex flex-col gap-1">
            {m("category")}
            <select
              className={indexInputClass}
              value={category}
              onChange={(event) => setCategory(event.target.value)}
              disabled={disabled}
            >
              <option value="">{m("all")}</option>
              {["source", "test", "config", "other"].map((item) => (
                <option key={item} value={item}>
                  {item}
                </option>
              ))}
            </select>
          </label>
          <label className="flex flex-col gap-1">
            {m("pageSize")}
            <input
              className={`${indexInputClass} w-20`}
              type="number"
              min={1}
              max={50}
              value={limit}
              onChange={(event) => setLimit(Number(event.target.value))}
              disabled={disabled}
            />
          </label>
          <Button type="submit" disabled={disabled || !query.trim()} data-testid="omp-repo-search">
            {m("search")}
          </Button>
        </form>
        {result ? (
          <div className="space-y-3" data-testid="omp-repo-results">
            <p role="status">
              {result.status === "missing" ? m("missing") : `${result.hits.length} ${m("matches")}`}{" "}
              · {m("generation")}: {result.generation ?? "—"}
            </p>
            {result.warnings.map((warning, position) => (
              <p key={position} role="status">
                {warning}
              </p>
            ))}
            {result.hits.map((hit, position) => (
              <article
                key={`${hit.path}:${hit.startLine}:${position}`}
                className="space-y-2 rounded-md border border-border p-3"
              >
                <p className="break-all text-ui-caption text-foreground-subtle">
                  {hit.path}:{hit.startLine}–{hit.endLine} · {hit.category}
                </p>
                {"snippet" in hit ? (
                  <pre className="whitespace-pre-wrap break-words text-ui-base">{hit.snippet}</pre>
                ) : (
                  <>
                    <h3 className="text-ui-lg font-medium">{hit.qualname || hit.name}</h3>
                    <p>{hit.kind}</p>
                    <pre className="whitespace-pre-wrap break-words text-ui-base">
                      {hit.signature}
                    </pre>
                  </>
                )}
              </article>
            ))}
            {result.cursor ? (
              <Button
                variant="outline"
                disabled={disabled}
                onClick={() => void search(true)}
                data-testid="omp-repo-next"
              >
                {m("next")}
              </Button>
            ) : null}
            {result.truncated ? <p>{m("truncated")}</p> : null}
          </div>
        ) : null}
      </section>
      <IndexConfirmation
        open={Boolean(confirmation)}
        title={m(confirmation?.action ?? "init")}
        onClose={() => setConfirmation(null)}
        onConfirm={() => void confirm()}
      >
        <p>{m("confirmRoot")}</p>
        <p data-testid="omp-repo-confirm-root">{confirmation?.root}</p>
      </IndexConfirmation>
    </IndexPageFrame>
  );
}

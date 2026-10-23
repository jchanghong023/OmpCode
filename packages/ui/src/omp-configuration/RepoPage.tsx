import { useEffect, useState } from "react";
import { Code2, Database, FileCode2, RefreshCw, Search as SearchIcon } from "lucide-react";
import { SettingsSearchInput } from "@/settings/SettingsSearchInput.js";
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
      <section className="min-w-0 space-y-3" aria-label={m("status")}>
        <div className="flex flex-wrap items-center gap-2">
          <h2 className="mr-auto flex items-center gap-2 text-ui-base font-medium">
            <Database className="size-4 text-foreground-subtle" aria-hidden="true" />
            {m("status")}
          </h2>
          <Button
            variant="outline"
            disabled={disabled}
            onClick={() => void refresh()}
            data-testid="omp-repo-refresh"
          >
            <RefreshCw aria-hidden="true" />
            {m("refresh")}
          </Button>
          {(["init", "update", "rebuild", "remove"] as const).map((action) => (
            <Button
              key={action}
              variant="outline"
              className={
                action === "remove" || action === "rebuild" ? "text-destructive" : undefined
              }
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
            className="min-w-0 space-y-3 rounded-lg bg-surface p-4"
            data-testid="omp-repo-status"
            data-generation={status.generation ?? ""}
            data-exists={status.exists}
          >
            <div className="flex min-w-0 flex-wrap items-start justify-between gap-3">
              <div className="min-w-0 flex-1 basis-48">
                <p className="mb-1 text-ui-caption text-foreground-subtle">{m("root")}</p>
                <p
                  className="truncate font-mono text-ui-caption"
                  title={status.root}
                  data-testid="omp-repo-root"
                >
                  {status.root}
                </p>
              </div>
              <span
                className={`rounded-md px-2 py-1 text-ui-caption font-medium ${status.exists ? "bg-card text-foreground" : "bg-warning-surface text-warning-surface-foreground"}`}
              >
                {status.exists ? m("indexed") : m("missing")}
              </span>
            </div>
            <div className="flex flex-wrap gap-x-5 gap-y-2 border-y border-border py-3 text-ui-caption text-foreground-subtle">
              <span>
                <strong className="mr-1 text-ui-lg font-semibold tabular-nums text-foreground">
                  {status.fileCount}
                </strong>
                {m("files")}
              </span>
              <span>
                <strong className="mr-1 text-ui-lg font-semibold tabular-nums text-foreground">
                  {status.symbolCount}
                </strong>
                {m("symbols")}
              </span>
              <span>
                {m("failures")}: {status.failureCount}
              </span>
              <span>
                {m("pending")}: {status.pendingCount}
              </span>
              <span>
                {m("uncertainties")}: {status.uncertainCount}
              </span>
            </div>
            <div className="flex min-w-0 flex-wrap gap-x-5 gap-y-1 text-ui-caption text-foreground-subtle">
              <p className="min-w-0 break-all">
                {m("generation")}: <code>{status.generation ?? "—"}</code>
              </p>
              <p>
                {m("lastCheck")}:{" "}
                {status.lastFullCheck === null
                  ? "—"
                  : new Date(status.lastFullCheck).toLocaleString()}
              </p>
            </div>
            {status.incomplete || status.needsReconcile || status.unchecked ? (
              <p
                role="status"
                className="rounded-md bg-warning-surface px-3 py-2 text-ui-caption text-warning-surface-foreground"
              >
                {m("incomplete")}
              </p>
            ) : null}
            <ul className="space-y-1 text-ui-caption leading-relaxed text-foreground-subtle">
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
                <summary className="cursor-pointer text-ui-caption text-foreground-subtle">
                  {m("exclusions")}
                </summary>
                <ul className="mt-2 space-y-1 text-ui-caption text-foreground-subtle">
                  {status.exclusions.map((item) => (
                    <li key={item} className="break-all">
                      {item}
                    </li>
                  ))}
                </ul>
              </details>
            ) : null}
          </div>
        ) : (
          <div className="rounded-lg bg-surface p-4 text-ui-caption text-foreground-subtle">
            {m("status")} · —
          </div>
        )}
      </section>
      <section className="min-w-0 space-y-4 border-t border-border pt-5" aria-label={m("query")}>
        <h2 className="text-ui-lg font-semibold">{m("query")}</h2>
        <form
          className="grid min-w-0 grid-cols-2 items-end gap-3 rounded-lg bg-surface p-3 sm:grid-cols-4"
          onSubmit={(event) => {
            event.preventDefault();
            void search(false);
          }}
        >
          <label className="col-span-2 flex min-w-0 flex-col gap-1.5 text-ui-caption text-foreground-subtle sm:col-span-3">
            {m("query")}
            <SettingsSearchInput
              containerClassName="min-w-0"
              value={query}
              onChange={(event) => setQuery(event.target.value)}
              required
              disabled={disabled}
              data-testid="omp-repo-query"
            />
          </label>
          <label className="flex min-w-0 flex-col gap-1.5 text-ui-caption text-foreground-subtle">
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
          <label className="flex min-w-0 flex-col gap-1.5 text-ui-caption text-foreground-subtle">
            {m("path")}
            <input
              className={indexInputClass}
              value={path}
              onChange={(event) => setPath(event.target.value)}
              disabled={disabled}
              data-testid="omp-repo-path"
            />
          </label>
          <label className="flex min-w-0 flex-col gap-1.5 text-ui-caption text-foreground-subtle">
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
          <label className="flex min-w-0 flex-col gap-1.5 text-ui-caption text-foreground-subtle">
            {m("pageSize")}
            <input
              className={indexInputClass}
              type="number"
              min={1}
              max={50}
              value={limit}
              onChange={(event) => setLimit(Number(event.target.value))}
              disabled={disabled}
            />
          </label>
          <Button
            type="submit"
            className="col-start-2 row-start-2 h-9 sm:col-start-4 sm:row-start-1"
            disabled={disabled || !query.trim()}
            data-testid="omp-repo-search"
          >
            <SearchIcon aria-hidden="true" />
            {m("search")}
          </Button>
        </form>
        {result ? (
          <div className="space-y-3" data-testid="omp-repo-results">
            <p role="status" className="break-words text-ui-caption text-foreground-subtle">
              {result.status === "missing" ? m("missing") : `${result.hits.length} ${m("matches")}`}{" "}
              · {m("generation")}: {result.generation ?? "—"}
            </p>
            {result.warnings.map((warning, position) => (
              <p
                key={position}
                role="status"
                className="rounded-lg bg-warning-surface px-3 py-2 text-ui-caption text-warning-surface-foreground"
              >
                {warning}
              </p>
            ))}
            {result.hits.map((hit, position) => (
              <article
                key={`${hit.path}:${hit.startLine}:${position}`}
                className="min-w-0 space-y-3 rounded-lg border border-border bg-card p-4"
              >
                <p className="flex min-w-0 items-start gap-2 break-all font-mono text-ui-caption leading-relaxed text-foreground-subtle">
                  <FileCode2 className="mt-0.5 size-4 shrink-0" aria-hidden="true" />
                  <span>
                    {hit.path}:{hit.startLine}–{hit.endLine} · {hit.category}
                  </span>
                </p>
                {"snippet" in hit ? (
                  <pre className="whitespace-pre-wrap break-words rounded-md bg-surface p-3 text-ui-base leading-relaxed [overflow-wrap:anywhere]">
                    {hit.snippet}
                  </pre>
                ) : (
                  <>
                    <h3 className="flex min-w-0 items-start gap-2 text-ui-base font-semibold [overflow-wrap:anywhere]">
                      <Code2
                        className="mt-0.5 size-4 shrink-0 text-foreground-subtle"
                        aria-hidden="true"
                      />
                      {hit.qualname || hit.name}
                    </h3>
                    <p className="text-ui-caption text-foreground-subtle">{hit.kind}</p>
                    <pre className="whitespace-pre-wrap break-words rounded-md bg-surface p-3 text-ui-base leading-relaxed [overflow-wrap:anywhere]">
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
        ) : (
          <div className="flex min-h-40 flex-col items-center justify-center gap-3 rounded-lg border border-dashed border-border px-4 py-8 text-center text-ui-caption text-foreground-subtle">
            <SearchIcon className="size-6" aria-hidden="true" />
            <p>
              {m("text")} · {m("symbols")}
            </p>
          </div>
        )}
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

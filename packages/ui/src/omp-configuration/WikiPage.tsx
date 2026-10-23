import { useEffect, useState } from "react";
import {
  BookOpen,
  FileText,
  FolderOpen,
  Plus,
  RefreshCw,
  Search as SearchIcon,
  Trash2,
} from "lucide-react";
import { SettingsSearchInput } from "@/settings/SettingsSearchInput.js";
import type { WikiList, WikiQuery } from "@zcode/shared/omp-indexes";
import { Button } from "@/components/ui/button.js";
import { useOmpIndexes } from "./useOmpIndexes.js";
import type { IndexPageProps } from "./contract.js";
import {
  IndexConfirmation,
  IndexPageFrame,
  indexInputClass,
  useIndexMessage,
} from "./IndexPageControls.js";

type Search = {
  action: "search" | "grep";
  query: string;
  index?: string;
  limit: number;
  characterBudget: number;
  case?: boolean;
};
export function WikiPage(props: IndexPageProps) {
  const api = useOmpIndexes("wiki", props);
  const m = useIndexMessage();
  const [indexes, setIndexes] = useState<WikiList["indexes"]>([]);
  const [directory, setDirectory] = useState("");
  const [name, setName] = useState("");
  const [index, setIndex] = useState("");
  const [query, setQuery] = useState("");
  const [mode, setMode] = useState<"search" | "grep">("search");
  const [caseSensitive, setCaseSensitive] = useState(false);
  const [limit, setLimit] = useState(20);
  const [result, setResult] = useState<WikiQuery | null>(null);
  const [submitted, setSubmitted] = useState<Search | null>(null);
  const [confirmation, setConfirmation] = useState<
    { action: "init"; name: string; directory: string } | { action: "remove"; name: string } | null
  >(null);
  const refresh = async () => {
    const value = await api.run<WikiList>({ action: "list" });
    if (value && "indexes" in value) setIndexes(value.indexes);
  };
  useEffect(() => {
    setIndexes([]);
    setResult(null);
    setSubmitted(null);
    setConfirmation(null);
    setIndex("");
    if (api.ready)
      void api.run<WikiList>({ action: "list" }).then((value) => {
        if (value && "indexes" in value) setIndexes(value.indexes);
      });
  }, [props.workspacePath, props.workspaceIdentity, props.remoteSessionId, api.ready, api.run]);
  const search = async (next: boolean) => {
    const fields: Search =
      next && submitted
        ? submitted
        : {
            action: mode,
            // 原生 grep 将首尾空格视为正则的一部分；只有默认技术检索沿用 trim 语义。
            query: mode === "grep" ? query : query.trim(),
            ...(index ? { index } : {}),
            limit,
            characterBudget: 1000000,
            ...(mode === "grep" ? { case: caseSensitive } : {}),
          };
    const value = await api.run<WikiQuery>({
      ...fields,
      ...(next && result?.cursor ? { cursor: result.cursor } : {}),
    });
    if (!value || !("sections" in value)) return;
    setSubmitted(fields);
    setResult((previous) =>
      next && previous ? { ...value, sections: [...previous.sections, ...value.sections] } : value,
    );
  };
  const confirm = async () => {
    if (!confirmation) return;
    const command = confirmation;
    setConfirmation(null);
    const value = await api.run(
      command.action === "init" ? { ...command, confirmedDirectory: command.directory } : command,
    );
    if (value) {
      setResult(null);
      setSubmitted(null);
      if (command.action === "init") {
        setName("");
        setDirectory("");
      } else setIndex((previous) => (previous === command.name ? "" : previous));
      await refresh();
    }
  };
  const disabled = api.busy || !api.ready;
  return (
    <IndexPageFrame
      title="Wiki"
      workspacePath={props.workspacePath}
      remote={api.remote}
      busy={api.busy}
      error={api.error ?? (!api.ready ? m("notReady") : null)}
      progress={api.progress}
      onCancel={() => void api.cancel()}
    >
      <section className="min-w-0 space-y-3" aria-label={m("indexes")}>
        <div className="flex items-center justify-between gap-3">
          <h2 className="flex items-center gap-2 text-ui-base font-medium">
            {m("indexes")}{" "}
            <span className="text-ui-sm font-normal text-foreground-subtle">{indexes.length}</span>
          </h2>
          <Button
            variant="outline"
            disabled={disabled}
            onClick={() => void refresh()}
            data-testid="omp-wiki-refresh"
          >
            <RefreshCw aria-hidden="true" />
            {m("refresh")}
          </Button>
        </div>
        <div className="grid min-w-0 gap-4 lg:grid-cols-[minmax(0,1fr)_minmax(0,20rem)]">
          <form
            className="order-2 grid min-w-0 content-start gap-3 rounded-lg border border-border p-3 lg:order-2"
            onSubmit={(event) => {
              event.preventDefault();
              setConfirmation({ action: "init", name: name.trim(), directory: directory.trim() });
            }}
          >
            <label className="flex min-w-0 flex-col gap-1.5 text-ui-caption text-foreground-subtle">
              {m("directory")}
              <input
                className={indexInputClass}
                aria-label={m("directory")}
                placeholder={m("directory")}
                value={directory}
                onChange={(event) => setDirectory(event.target.value)}
                required
                disabled={disabled}
                data-testid="omp-wiki-directory"
              />
            </label>
            <label className="flex min-w-0 flex-col gap-1.5 text-ui-caption text-foreground-subtle">
              {m("name")}
              <input
                className={indexInputClass}
                aria-label={m("name")}
                placeholder={m("name")}
                value={name}
                onChange={(event) => setName(event.target.value)}
                required
                disabled={disabled}
                data-testid="omp-wiki-name"
              />
            </label>
            <Button
              type="submit"
              variant="outline"
              className="justify-self-start"
              disabled={disabled || !name.trim() || !directory.trim()}
              data-testid="omp-wiki-init"
            >
              <Plus aria-hidden="true" />
              {m("add")}
            </Button>
            <p className="text-ui-caption leading-relaxed text-foreground-subtle">
              {m("directoryHint")}
            </p>
          </form>
          <ul
            className="order-1 min-w-0 divide-y divide-border overflow-hidden rounded-lg bg-surface lg:order-1"
            data-testid="omp-wiki-indexes"
          >
            {indexes.map((item) => (
              <li
                key={item.id}
                className="flex min-w-0 items-start justify-between gap-3 p-3"
                data-index-name={item.name}
              >
                <div className="min-w-0">
                  <strong className="flex items-center gap-2 break-all text-ui-base font-medium">
                    <BookOpen
                      className="size-4 shrink-0 text-foreground-subtle"
                      aria-hidden="true"
                    />
                    {item.name}
                  </strong>
                  <p
                    className="mt-1 truncate font-mono text-ui-caption text-foreground-subtle"
                    title={item.rootPath}
                  >
                    {item.rootPath}
                  </p>
                  <p className="mt-1 text-ui-caption text-foreground-subtle">
                    {item.documentCount} {m("documents")} · {item.sectionCount} {m("sections")}
                  </p>
                </div>
                <Button
                  variant="ghost"
                  className="text-destructive"
                  disabled={disabled}
                  onClick={() => setConfirmation({ action: "remove", name: item.name })}
                  aria-label={`${m("remove")} ${item.name}`}
                >
                  <Trash2 aria-hidden="true" />
                  {m("remove")}
                </Button>
              </li>
            ))}
            {!indexes.length && !api.busy ? (
              <li className="flex min-h-28 flex-col items-center justify-center gap-2 p-4 text-ui-caption text-foreground-subtle">
                <FolderOpen className="size-6" aria-hidden="true" />
                {m("empty")}
              </li>
            ) : null}
          </ul>
        </div>
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
              required
              value={query}
              onChange={(event) => setQuery(event.target.value)}
              disabled={disabled}
              data-testid="omp-wiki-query"
            />
          </label>
          <label className="flex min-w-0 flex-col gap-1.5 text-ui-caption text-foreground-subtle">
            {m("mode")}
            <select
              className={indexInputClass}
              value={mode}
              onChange={(event) => setMode(event.target.value as "search" | "grep")}
              disabled={disabled}
            >
              <option value="search">{m("technicalSearch")}</option>
              <option value="grep">Grep / Regex</option>
            </select>
          </label>
          <label className="flex min-w-0 flex-col gap-1.5 text-ui-caption text-foreground-subtle">
            {m("index")}
            <select
              className={indexInputClass}
              value={index}
              onChange={(event) => setIndex(event.target.value)}
              disabled={disabled}
            >
              <option value="">{m("all")}</option>
              {indexes.map((item) => (
                <option key={item.id} value={item.name}>
                  {item.name}
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
              max={200}
              value={limit}
              onChange={(event) => setLimit(Number(event.target.value))}
              disabled={disabled}
            />
          </label>
          {mode === "grep" ? (
            <label className="flex min-h-8 items-center gap-2 text-ui-caption text-foreground-subtle">
              <input
                type="checkbox"
                checked={caseSensitive}
                onChange={(event) => setCaseSensitive(event.target.checked)}
                disabled={disabled}
              />
              {m("caseSensitive")}
            </label>
          ) : null}
          <Button
            type="submit"
            disabled={disabled || !(mode === "grep" ? query : query.trim())}
            className="col-start-2 row-start-2 h-9 sm:col-start-4 sm:row-start-1"
            data-testid="omp-wiki-search"
          >
            <SearchIcon aria-hidden="true" />
            {m("search")}
          </Button>
        </form>
        {result ? (
          <div className="space-y-3" data-testid="omp-wiki-results">
            <p role="status" className="text-ui-caption text-foreground-subtle">
              {result.total} {m("matches")} · {result.exactNameMatches} {m("exactMatches")}
              {result.technicalName ? ` · ${result.technicalName}` : ""}
            </p>
            {result.sections.map((section, position) => (
              <article
                key={`${section.sectionId}:${position}`}
                className="min-w-0 space-y-3 rounded-lg border border-border bg-card p-4"
              >
                <h3 className="flex min-w-0 items-start gap-2 text-ui-base font-semibold [overflow-wrap:anywhere]">
                  <FileText
                    className="mt-0.5 size-4 shrink-0 text-foreground-subtle"
                    aria-hidden="true"
                  />
                  {section.headingPath || section.path}
                </h3>
                <p className="break-all font-mono text-ui-caption leading-relaxed text-foreground-subtle">
                  {m("source")}: {section.index} · {section.path}:{section.lineStart}–
                  {section.lineEnd} · {section.matchKind} · {section.shape}
                </p>
                <pre
                  className="whitespace-pre-wrap break-words rounded-md bg-surface p-3 font-sans text-ui-base leading-relaxed [overflow-wrap:anywhere]"
                  data-testid="omp-wiki-section-body"
                >
                  {section.text}
                </pre>
              </article>
            ))}
            {result.hasMore && result.cursor ? (
              <Button
                variant="outline"
                disabled={disabled}
                onClick={() => void search(true)}
                data-testid="omp-wiki-next"
              >
                {m("next")}
              </Button>
            ) : null}
          </div>
        ) : (
          <div className="flex min-h-40 flex-col items-center justify-center gap-3 rounded-lg border border-dashed border-border px-4 py-8 text-center text-ui-caption text-foreground-subtle">
            <SearchIcon className="size-6" aria-hidden="true" />
            <p>{m("technicalSearch")} · Grep / Regex</p>
          </div>
        )}
      </section>
      <IndexConfirmation
        open={Boolean(confirmation)}
        title={m(confirmation?.action === "remove" ? "remove" : "add")}
        onClose={() => setConfirmation(null)}
        onConfirm={() => void confirm()}
      >
        <p>{confirmation?.name}</p>
        {confirmation?.action === "init" ? (
          <p data-testid="omp-wiki-confirm-directory">{confirmation.directory}</p>
        ) : null}
      </IndexConfirmation>
    </IndexPageFrame>
  );
}

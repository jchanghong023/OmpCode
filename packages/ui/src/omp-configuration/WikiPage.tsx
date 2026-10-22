import { useEffect, useState } from "react";
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
            query: query.trim(),
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
      <section className="space-y-3" aria-label={m("indexes")}>
        <div className="flex items-center justify-between gap-3">
          <h2 className="text-ui-lg font-medium">{m("indexes")}</h2>
          <Button
            variant="outline"
            disabled={disabled}
            onClick={() => void refresh()}
            data-testid="omp-wiki-refresh"
          >
            {m("refresh")}
          </Button>
        </div>
        <form
          className="grid gap-2 md:grid-cols-[1fr_1fr_auto]"
          onSubmit={(event) => {
            event.preventDefault();
            setConfirmation({ action: "init", name: name.trim(), directory: directory.trim() });
          }}
        >
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
          <Button
            type="submit"
            disabled={disabled || !name.trim() || !directory.trim()}
            data-testid="omp-wiki-init"
          >
            {m("add")}
          </Button>
        </form>
        <p className="text-ui-caption text-foreground-subtle">{m("directoryHint")}</p>
        <ul
          className="divide-y divide-border rounded-md border border-border"
          data-testid="omp-wiki-indexes"
        >
          {indexes.map((item) => (
            <li
              key={item.id}
              className="flex items-center justify-between gap-3 p-3"
              data-index-name={item.name}
            >
              <div className="min-w-0">
                <strong>{item.name}</strong>
                <p className="break-all text-ui-caption">{item.rootPath}</p>
                <p className="text-ui-caption text-foreground-subtle">
                  {item.documentCount} {m("documents")} · {item.sectionCount} {m("sections")}
                </p>
              </div>
              <Button
                variant="outline"
                disabled={disabled}
                onClick={() => setConfirmation({ action: "remove", name: item.name })}
                aria-label={`${m("remove")} ${item.name}`}
              >
                {m("remove")}
              </Button>
            </li>
          ))}
        </ul>
        {!indexes.length && !api.busy ? <p>{m("empty")}</p> : null}
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
              required
              value={query}
              onChange={(event) => setQuery(event.target.value)}
              disabled={disabled}
              data-testid="omp-wiki-query"
            />
          </label>
          <label className="flex flex-col gap-1">
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
          <label className="flex flex-col gap-1">
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
          <label className="flex flex-col gap-1">
            {m("pageSize")}
            <input
              className={`${indexInputClass} w-20`}
              type="number"
              min={1}
              max={200}
              value={limit}
              onChange={(event) => setLimit(Number(event.target.value))}
              disabled={disabled}
            />
          </label>
          {mode === "grep" ? (
            <label className="flex items-center gap-2">
              <input
                type="checkbox"
                checked={caseSensitive}
                onChange={(event) => setCaseSensitive(event.target.checked)}
                disabled={disabled}
              />
              {m("caseSensitive")}
            </label>
          ) : null}
          <Button type="submit" disabled={disabled || !query.trim()} data-testid="omp-wiki-search">
            {m("search")}
          </Button>
        </form>
        {result ? (
          <div className="space-y-3" data-testid="omp-wiki-results">
            <p role="status">
              {result.total} {m("matches")} · {result.exactNameMatches} {m("exactMatches")}
              {result.technicalName ? ` · ${result.technicalName}` : ""}
            </p>
            {result.sections.map((section, position) => (
              <article
                key={`${section.sectionId}:${position}`}
                className="space-y-2 rounded-md border border-border p-3"
              >
                <h3 className="text-ui-lg font-medium">{section.headingPath || section.path}</h3>
                <p className="break-all text-ui-caption text-foreground-subtle">
                  {m("source")}: {section.index} · {section.path}:{section.lineStart}–
                  {section.lineEnd} · {section.matchKind} · {section.shape}
                </p>
                <pre
                  className="whitespace-pre-wrap break-words text-ui-base"
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
        ) : null}
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

import { useId, useState } from "react";
import { Button } from "@/components/ui/button.js";
import { Textarea } from "@/components/ui/textarea.js";
import { useZCodeIntl } from "@/i18n/IntlProvider.js";
import { logger } from "@/logger.js";
import type { OmpNativeToolsPanelProps } from "./OmpNativeToolsDialog.js";
import {
  buildOmpRepoSearchRequest,
  getOmpProjectIndexDashboardCommand,
} from "./ompProjectIndexCommands.js";

const DASHBOARDS = [
  {
    dashboard: "wiki",
    titleId: "ompProjectIndex.wiki.title",
    descriptionId: "ompProjectIndex.wiki.description",
    buttonId: "ompProjectIndex.openWiki",
  },
  {
    dashboard: "repo",
    titleId: "ompProjectIndex.repo.title",
    descriptionId: "ompProjectIndex.repo.description",
    buttonId: "ompProjectIndex.openRepo",
  },
] as const;

type SubmissionFeedback =
  | "ompProjectIndex.executionBlocked"
  | "ompProjectIndex.confirmationRequired"
  | "ompProjectIndex.executionFailed"
  | null;

export function OmpProjectIndexPanel({ commands, disabled, onExecute }: OmpNativeToolsPanelProps) {
  const { intl } = useZCodeIntl();
  const panelId = useId();
  const [query, setQuery] = useState("");
  const [feedback, setFeedback] = useState<SubmissionFeedback>(null);
  const repoCommand = getOmpProjectIndexDashboardCommand(commands, "repo");
  const searchRequest = buildOmpRepoSearchRequest(query);

  async function execute(text: string) {
    if (disabled) return;
    setFeedback(null);
    try {
      // admission、scope fence 与同步防重入均由壳的唯一提交入口负责。
      // sent 只是请求接纳；原生命令/模型结果不得在此伪造成索引成功状态。
      const outcome = await onExecute(text);
      if (outcome === "blocked") setFeedback("ompProjectIndex.executionBlocked");
      if (outcome === "confirmationRequired") {
        setFeedback("ompProjectIndex.confirmationRequired");
      }
    } catch (error) {
      logger.warn("[omp-project-index] 原生索引请求提交失败", { error });
      setFeedback("ompProjectIndex.executionFailed");
    }
  }

  return (
    <div className="min-w-0 space-y-4 text-ui-base text-foreground">
      <header className="space-y-1">
        <h3 className="text-ui-lg font-medium">
          {intl.formatMessage({ id: "ompProjectIndex.title" })}
        </h3>
        <p className="text-ui-caption text-foreground-subtle">
          {intl.formatMessage({ id: "ompProjectIndex.description" })}
        </p>
        <p className="text-ui-caption text-foreground-subtle">
          {intl.formatMessage({ id: "ompProjectIndex.catalogNotice" })}
        </p>
      </header>

      {disabled ? (
        <p
          role="status"
          className="rounded-md border border-border p-3 text-ui-caption text-foreground-subtle"
        >
          {intl.formatMessage({ id: "ompProjectIndex.executionUnavailable" })}
        </p>
      ) : null}
      {feedback ? (
        <p
          role="alert"
          className="rounded-md border border-border p-3 text-ui-caption text-destructive"
        >
          {intl.formatMessage({ id: feedback })}
        </p>
      ) : null}

      <p className="text-ui-caption text-foreground-subtle">
        {intl.formatMessage({ id: "ompProjectIndex.dashboardNotice" })}
      </p>
      <div className="grid min-w-0 gap-3 md:grid-cols-2">
        {DASHBOARDS.map(({ dashboard, titleId, descriptionId, buttonId }) => {
          const command = getOmpProjectIndexDashboardCommand(commands, dashboard);
          return (
            <article
              key={dashboard}
              aria-labelledby={`${panelId}-${dashboard}`}
              className="flex min-w-0 flex-col gap-3 rounded-md border border-border bg-card p-3"
            >
              <h4 id={`${panelId}-${dashboard}`} className="text-ui-base font-medium">
                {intl.formatMessage({ id: titleId })}
              </h4>
              <p className="text-ui-caption text-foreground-subtle">
                {intl.formatMessage({ id: descriptionId })}
              </p>
              <p className="text-ui-caption text-foreground-subtle">
                {intl.formatMessage({
                  id: command ? "ompProjectIndex.available" : "ompProjectIndex.unavailable",
                })}
              </p>
              <div className="mt-auto space-y-2">
                <p className="text-ui-caption text-foreground-subtle">
                  {intl.formatMessage({ id: "ompProjectIndex.preview" })}
                </p>
                <pre className="whitespace-pre-wrap break-words rounded-md border border-border bg-background p-2 font-mono text-ui-caption">
                  {`/${dashboard}`}
                </pre>
                <Button
                  type="button"
                  variant="outline"
                  className="h-auto min-h-7 w-full whitespace-normal py-1.5"
                  disabled={disabled || command === null}
                  onClick={() => {
                    if (command !== null) void execute(command);
                  }}
                >
                  {intl.formatMessage({ id: buttonId })}
                </Button>
              </div>
            </article>
          );
        })}
      </div>

      <form
        aria-labelledby={`${panelId}-search-title`}
        className="min-w-0 space-y-3 rounded-md border border-border bg-card p-3"
        onSubmit={(event) => {
          event.preventDefault();
          // 缺少 repo 目录能力时没有普通 prompt 回落；查询是单独、显式的模型路径。
          if (disabled || repoCommand === null || searchRequest === null) return;
          void execute(searchRequest);
        }}
      >
        <h4 id={`${panelId}-search-title`} className="text-ui-base font-medium">
          {intl.formatMessage({ id: "ompProjectIndex.search.title" })}
        </h4>
        <p id={`${panelId}-search-description`} className="text-ui-caption text-foreground-subtle">
          {intl.formatMessage({ id: "ompProjectIndex.search.description" })}
        </p>
        <p id={`${panelId}-search-readonly`} className="text-ui-caption text-foreground-subtle">
          {intl.formatMessage({ id: "ompProjectIndex.search.readOnly" })}
        </p>
        {repoCommand === null ? (
          <p role="status" className="text-ui-caption text-foreground-subtle">
            {intl.formatMessage({ id: "ompProjectIndex.unavailable" })}
          </p>
        ) : null}
        <div className="space-y-1.5">
          <label htmlFor={`${panelId}-query`} className="block text-ui-caption font-medium">
            {intl.formatMessage({ id: "ompProjectIndex.search.query" })}
          </label>
          <Textarea
            id={`${panelId}-query`}
            value={query}
            onChange={(event) => {
              setQuery(event.target.value);
              setFeedback(null);
            }}
            disabled={disabled || repoCommand === null}
            placeholder={intl.formatMessage({ id: "ompProjectIndex.search.placeholder" })}
            aria-describedby={`${panelId}-search-description ${panelId}-search-readonly ${panelId}-query-validation`}
            aria-invalid={query.length > 0 && searchRequest === null}
            className="max-h-48 overflow-y-auto"
          />
          <p id={`${panelId}-query-validation`} className="text-ui-caption text-foreground-subtle">
            {searchRequest === null
              ? intl.formatMessage({ id: "ompProjectIndex.search.empty" })
              : null}
          </p>
        </div>
        <div className="min-w-0 space-y-1.5">
          <p className="text-ui-caption text-foreground-subtle">
            {intl.formatMessage({ id: "ompProjectIndex.preview" })}
          </p>
          <pre className="whitespace-pre-wrap break-words rounded-md border border-border bg-background p-2 font-mono text-ui-caption">
            {searchRequest ?? intl.formatMessage({ id: "ompProjectIndex.search.previewEmpty" })}
          </pre>
        </div>
        <Button
          type="submit"
          className="h-auto min-h-7 w-full whitespace-normal py-1.5 sm:w-auto"
          disabled={disabled || repoCommand === null || searchRequest === null}
        >
          {intl.formatMessage({ id: "ompProjectIndex.search.submit" })}
        </Button>
      </form>
    </div>
  );
}

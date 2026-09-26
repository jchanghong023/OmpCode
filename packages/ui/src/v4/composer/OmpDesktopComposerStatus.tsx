import { useEffect, useRef, useState } from "react";
import { GitBranchIcon, ListFilterIcon, ListTodoIcon, RotateCcwIcon } from "lucide-react";
import type { GitRepositorySummary } from "@zcode/shared";
import { Button } from "@/components/ui/button.js";
import { useZCodeIntl } from "@/i18n/IntlProvider.js";

interface OmpDesktopComposerStatusProps {
  scopeKey: string;
  gitSummary?: GitRepositorySummary | null;
  gitDirtyFileCount?: number;
  sessionId: string | null;
  autoCompactionEnabled?: boolean;
  planModelActive: boolean;
  planModelAvailable: boolean;
  onTogglePlanModel: () => Promise<{ success: boolean; error?: string }>;
  onCompact?: () => void;
  onSetAutoCompaction?: (enabled: boolean) => Promise<{ success: boolean; error?: string }>;
  onOpenGitReview?: () => void;
}

/** 仅桌面窗口展示；所有数值都从现有 Composer、会话投影和 Git owner 读取。 */
export function OmpDesktopComposerStatus({
  scopeKey,
  gitSummary,
  gitDirtyFileCount,
  sessionId,
  autoCompactionEnabled,
  planModelActive,
  planModelAvailable,
  onTogglePlanModel,
  onCompact,
  onSetAutoCompaction,
  onOpenGitReview,
}: OmpDesktopComposerStatusProps) {
  const { intl } = useZCodeIntl();
  const [busyAction, setBusyAction] = useState<"plan" | "auto" | null>(null);
  const [error, setError] = useState<string | null>(null);
  const scopeRef = useRef(scopeKey);
  scopeRef.current = scopeKey;
  useEffect(() => {
    setBusyAction(null);
    setError(null);
  }, [scopeKey]);
  const branch = gitSummary?.isRepository ? gitSummary.branchName : null;
  const planLabel = intl.formatMessage({
    id: planModelActive ? "chat.ompStatus.exitPlanModel" : "chat.ompStatus.usePlanModel",
  });
  const compactLabel = intl.formatMessage({ id: "chat.ompStatus.compact" });
  const autoLabel = intl.formatMessage({ id: "chat.ompStatus.autoCompact" });
  const autoStateLabel =
    autoCompactionEnabled === undefined
      ? "…"
      : intl.formatMessage({
          id: autoCompactionEnabled ? "chat.ompStatus.enabled" : "chat.ompStatus.disabled",
        });

  const runPlanToggle = async () => {
    const requestScope = scopeKey;
    setBusyAction("plan");
    setError(null);
    const result = await onTogglePlanModel();
    if (scopeRef.current !== requestScope) return;
    setBusyAction(null);
    if (
      !result.success &&
      result.error !== "session_changed" &&
      result.error !== "selection_changed"
    ) {
      setError(
        result.error === "plan_role_missing"
          ? intl.formatMessage({ id: "chat.ompStatus.planMissing" })
          : intl.formatMessage({ id: "chat.ompStatus.planFailed" }),
      );
    }
  };
  const runAutoToggle = async () => {
    if (autoCompactionEnabled === undefined || !onSetAutoCompaction) return;
    const requestScope = scopeKey;
    setBusyAction("auto");
    setError(null);
    const result = await onSetAutoCompaction(!autoCompactionEnabled);
    if (scopeRef.current !== requestScope) return;
    setBusyAction(null);
    if (!result.success) setError(intl.formatMessage({ id: "chat.ompStatus.autoFailed" }));
  };

  return (
    <div
      className="hidden shrink-0 items-center gap-0.5 text-ui-sm text-foreground-subtle md:flex"
      data-testid="omp-desktop-composer-status"
    >
      <Button
        type="button"
        variant="ghost"
        size="sm"
        className="h-7 gap-1 px-1.5 text-ui-sm"
        aria-label={planLabel}
        aria-pressed={planModelActive}
        disabled={!planModelAvailable || busyAction !== null}
        onClick={() => void runPlanToggle()}
        title={planLabel}
      >
        <ListTodoIcon className="size-4 shrink-0" />
        <span className="hidden @min-[600px]/composer:inline">
          {intl.formatMessage({
            id: planModelActive
              ? "chat.ompStatus.exitPlanModelShort"
              : "chat.ompStatus.planModelShort",
          })}
        </span>
      </Button>
      {branch ? (
        <Button
          type="button"
          variant="ghost"
          size="sm"
          className="h-7 max-w-32 gap-1 px-1.5 text-ui-sm"
          onClick={onOpenGitReview}
          disabled={!onOpenGitReview}
          title={`${branch}${gitDirtyFileCount ? ` *${gitDirtyFileCount}` : ""}`}
          aria-label={`${branch}${gitDirtyFileCount ? ` *${gitDirtyFileCount}` : ""}`}
        >
          <GitBranchIcon className="size-4 shrink-0" />
          <span className="max-w-14 truncate @min-[900px]/composer:max-w-24">{branch}</span>
          {gitDirtyFileCount ? <span className="tabular-nums">{gitDirtyFileCount}</span> : null}
        </Button>
      ) : null}
      {sessionId ? (
        <>
          <Button
            type="button"
            variant="ghost"
            size="sm"
            className="size-7 p-0"
            disabled={!onCompact}
            onClick={onCompact}
            aria-label={compactLabel}
            title={compactLabel}
          >
            <RotateCcwIcon className="size-4" />
          </Button>
          <Button
            type="button"
            variant="ghost"
            size="sm"
            className={
              autoCompactionEnabled ? "size-7 p-0 text-success hover:text-success" : "size-7 p-0"
            }
            aria-pressed={autoCompactionEnabled === true}
            aria-label={`${autoLabel}: ${autoStateLabel}`}
            disabled={
              autoCompactionEnabled === undefined || !onSetAutoCompaction || busyAction !== null
            }
            onClick={() => void runAutoToggle()}
            title={`${autoLabel}: ${autoStateLabel}`}
          >
            <ListFilterIcon className="size-4" />
          </Button>
        </>
      ) : null}
      {error ? (
        <span role="alert" className="px-1.5 text-warning" title={error}>
          {error}
        </span>
      ) : null}
    </div>
  );
}

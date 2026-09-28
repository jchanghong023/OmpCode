import { useEffect, useRef, useState } from "react";
import { GitBranchIcon, ListTodoIcon } from "lucide-react";
import type { GitRepositorySummary } from "@zcode/shared";
import { Button } from "@/components/ui/button.js";
import { useZCodeIntl } from "@/i18n/IntlProvider.js";

interface OmpDesktopComposerStatusProps {
  scopeKey: string;
  gitSummary?: GitRepositorySummary | null;
  gitDirtyFileCount?: number;
  planModelActive: boolean;
  planModelAvailable: boolean;
  onTogglePlanModel: () => Promise<{ success: boolean; error?: string }>;
  onOpenGitReview?: () => void;
}

/** 仅桌面窗口展示；所有数值都从现有 Composer、会话投影和 Git owner 读取。 */
export function OmpDesktopComposerStatus({
  scopeKey,
  gitSummary,
  gitDirtyFileCount,
  planModelActive,
  planModelAvailable,
  onTogglePlanModel,
  onOpenGitReview,
}: OmpDesktopComposerStatusProps) {
  const { intl } = useZCodeIntl();
  const [busyAction, setBusyAction] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const scopeRef = useRef(scopeKey);
  scopeRef.current = scopeKey;
  useEffect(() => {
    setBusyAction(false);
    setError(null);
  }, [scopeKey]);
  const branch = gitSummary?.isRepository ? gitSummary.branchName : null;
  const planLabel = intl.formatMessage({
    id: planModelActive ? "chat.ompStatus.exitPlanModel" : "chat.ompStatus.usePlanModel",
  });
  const runPlanToggle = async () => {
    const requestScope = scopeKey;
    setBusyAction(true);
    setError(null);
    const result = await onTogglePlanModel();
    if (scopeRef.current !== requestScope) return;
    setBusyAction(false);
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
        disabled={!planModelAvailable || busyAction}
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
      {error ? (
        <span role="alert" className="px-1.5 text-warning" title={error}>
          {error}
        </span>
      ) : null}
    </div>
  );
}

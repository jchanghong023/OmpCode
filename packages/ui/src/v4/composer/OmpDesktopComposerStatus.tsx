import { GitBranchIcon } from "lucide-react";
import type { GitRepositorySummary } from "@zcode/shared";
import { Button } from "@/components/ui/button.js";

interface OmpDesktopComposerStatusProps {
  gitSummary?: GitRepositorySummary | null;
  gitDirtyFileCount?: number;
  onOpenGitReview?: () => void;
}

/** 仅桌面窗口展示；所有数值都从现有 Composer、会话投影和 Git owner 读取。 */
export function OmpDesktopComposerStatus({
  gitSummary,
  gitDirtyFileCount,
  onOpenGitReview,
}: OmpDesktopComposerStatusProps) {
  const branch = gitSummary?.isRepository ? gitSummary.branchName : null;
  if (!branch) return null;
  return (
    <div
      className="hidden shrink-0 items-center gap-0.5 text-ui-sm text-foreground-subtle md:flex"
      data-testid="omp-desktop-composer-status"
    >
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
    </div>
  );
}

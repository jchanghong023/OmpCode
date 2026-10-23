import type { ReactNode } from "react";
import { AlertCircle, BookOpen, Code2, LoaderCircle, Monitor, Server } from "lucide-react";
import { useZCodeIntl } from "@/i18n/IntlProvider.js";
import { Button } from "@/components/ui/button.js";
import {
  Dialog,
  DialogContent,
  DialogHeader,
  DialogTitle,
  DialogFooter,
} from "@/components/ui/dialog.js";
import type { IndexProgress } from "@zcode/shared/omp-indexes";

export function useIndexMessage() {
  const { intl } = useZCodeIntl();
  return (key: string) => intl.formatMessage({ id: `omp.indexes.${key}` });
}
export const indexInputClass =
  "h-8 w-full min-w-0 rounded-md border border-input-border bg-input px-2.5 text-ui-base text-foreground outline-none transition-colors placeholder:text-foreground-subtlest hover:border-input-border-hover focus-visible:border-input-border-focused focus-visible:bg-input-focused disabled:cursor-not-allowed disabled:opacity-50";
export function IndexPageFrame({
  title,
  workspacePath,
  remote,
  busy,
  error,
  progress,
  onCancel,
  children,
}: {
  title: string;
  workspacePath: string;
  remote: boolean;
  busy: boolean;
  error: string | null;
  progress: IndexProgress["progress"] | null;
  onCancel: () => void;
  children: ReactNode;
}) {
  const m = useIndexMessage();
  const Icon = title === "Wiki" ? BookOpen : Code2;
  const ScopeIcon = remote ? Server : Monitor;
  const completed = progress
    ? "completed" in progress
      ? progress.completed
      : progress.processed
    : 0;
  const percentage =
    progress && progress.total > 0
      ? Math.min(100, Math.round((completed / progress.total) * 100))
      : null;
  const currentPath = progress
    ? "currentPath" in progress
      ? progress.currentPath
      : "path" in progress
        ? progress.path
        : null
    : null;
  return (
    <main
      className="h-full min-h-0 min-w-0 overflow-y-auto bg-background text-ui-base text-foreground"
      data-testid={`omp-${title.toLowerCase()}-page`}
    >
      <div className="mx-auto flex w-full max-w-6xl flex-col gap-5 px-4 py-6 sm:px-6 lg:px-8">
        <header className="flex items-center gap-3">
          <Icon className="size-5 shrink-0 text-foreground-subtle" aria-hidden="true" />
          <div className="min-w-0">
            <h1 className="text-ui-xl font-semibold tracking-tight">{title}</h1>
            <p className="text-ui-caption text-foreground-subtle">
              {title === "Wiki" ? m("technicalSearch") : `${m("text")} · ${m("symbols")}`}
            </p>
          </div>
        </header>
        <div className="flex min-w-0 flex-wrap items-center gap-x-3 gap-y-1 rounded-lg border border-border bg-surface px-3 py-2">
          <ScopeIcon className="size-3.5 shrink-0 text-foreground-subtle" aria-hidden="true" />
          <span className="text-ui-caption text-foreground-subtle">
            {m(remote ? "remoteScope" : "localScope")}
          </span>
          <code
            className="min-w-0 flex-1 basis-48 truncate text-ui-caption"
            title={workspacePath}
            data-testid="omp-index-workspace"
          >
            {workspacePath || m("noWorkspace")}
          </code>
        </div>
        {error ? (
          <div
            role="alert"
            className="flex items-start gap-2 rounded-lg bg-destructive-surface p-3 text-ui-caption text-destructive-surface-foreground"
          >
            <AlertCircle className="mt-0.5 size-4 shrink-0" aria-hidden="true" />
            <p className="min-w-0 break-words">{error}</p>
          </div>
        ) : null}
        {busy ? (
          <div role="status" className="space-y-2 rounded-lg border border-border bg-card p-3">
            <div className="flex items-center gap-2">
              <LoaderCircle
                className="size-4 shrink-0 motion-safe:animate-spin text-foreground-subtle"
                aria-hidden="true"
              />
              <span className="min-w-0 flex-1 text-ui-caption font-medium">
                {progress ? progress.phase : m("working")}
              </span>
              {progress ? (
                <span className="text-ui-caption tabular-nums text-foreground-subtle">
                  {completed}/{progress.total}
                  {percentage !== null ? ` · ${percentage}%` : ""}
                </span>
              ) : null}
              <Button variant="outline" size="sm" onClick={onCancel} data-testid="omp-index-cancel">
                {m("cancel")}
              </Button>
            </div>
            {percentage !== null ? (
              <div className="h-1 overflow-hidden rounded-full bg-surface">
                <div
                  className="h-full rounded-full bg-primary"
                  style={{ width: `${percentage}%` }}
                />
              </div>
            ) : null}
            {currentPath ? (
              <code
                className="block truncate text-ui-caption text-foreground-subtle"
                title={currentPath}
              >
                {currentPath}
              </code>
            ) : null}
          </div>
        ) : null}
        {children}
      </div>
    </main>
  );
}
export function IndexConfirmation({
  open,
  title,
  children,
  onConfirm,
  onClose,
}: {
  open: boolean;
  title: string;
  children: ReactNode;
  onConfirm: () => void;
  onClose: () => void;
}) {
  const m = useIndexMessage();
  return (
    <Dialog
      open={open}
      onOpenChange={(value) => {
        if (!value) onClose();
      }}
    >
      <DialogContent>
        <DialogHeader>
          <DialogTitle>{title}</DialogTitle>
        </DialogHeader>
        <div className="space-y-3 break-all text-ui-base">
          {children}
          <p>{m("sourcesUnchanged")}</p>
        </div>
        <DialogFooter>
          <Button variant="outline" onClick={onClose}>
            {m("cancel")}
          </Button>
          <Button onClick={onConfirm} data-testid="omp-index-confirm">
            {m("confirm")}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}

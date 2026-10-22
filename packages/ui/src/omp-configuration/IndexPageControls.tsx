import type { ReactNode } from "react";
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
  "min-w-0 rounded-md border border-input-border bg-input px-3 py-2 text-ui-base text-foreground";
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
  return (
    <main
      className="h-full min-h-0 overflow-y-auto bg-background text-ui-base text-foreground"
      data-testid={`omp-${title.toLowerCase()}-page`}
    >
      <div className="mx-auto flex max-w-5xl flex-col gap-4 p-4 md:p-6">
        <h1 className="text-ui-xl font-semibold">{title}</h1>
        <p className="text-ui-caption text-foreground-subtle">
          {m(remote ? "remoteScope" : "localScope")}
        </p>
        <code className="break-all text-ui-caption" data-testid="omp-index-workspace">
          {workspacePath || m("noWorkspace")}
        </code>
        {error ? (
          <p role="alert" className="rounded-md border border-border p-3">
            {error}
          </p>
        ) : null}
        {busy ? (
          <div role="status" className="flex flex-wrap items-center gap-3">
            <span>
              {progress
                ? `${progress.phase} · ${"completed" in progress ? progress.completed : progress.processed}/${progress.total} · ${"currentPath" in progress ? (progress.currentPath ?? "") : "path" in progress ? (progress.path ?? "") : ""}`
                : m("working")}
            </span>
            <Button variant="outline" onClick={onCancel} data-testid="omp-index-cancel">
              {m("cancel")}
            </Button>
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

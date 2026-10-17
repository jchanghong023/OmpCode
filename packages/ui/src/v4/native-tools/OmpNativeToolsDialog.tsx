import type { ZCodeSlashCommand } from "@zcode/shared";
import { useZCodeIntl } from "@/i18n/IntlProvider.js";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog.js";
import { Tabs, TabsContent, TabsList, TabsTrigger } from "@/components/ui/tabs.js";
import { OmpProjectIndexPanel } from "./OmpProjectIndexPanel.js";
import { OmpOrchestrationPanel } from "./OmpOrchestrationPanel.js";

export interface OmpNativeToolsPanelProps {
  commands: readonly ZCodeSlashCommand[];
  disabled: boolean;
  onExecute: (text: string) => Promise<"sent" | "blocked" | "confirmationRequired">;
}

interface OmpNativeToolsDialogProps extends OmpNativeToolsPanelProps {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  workspacePath: string;
  workspaceIdentity?: string;
  sessionId: string | null;
  disabledReason?: string | null;
}

export function OmpNativeToolsDialog({
  open,
  onOpenChange,
  workspacePath,
  workspaceIdentity,
  sessionId,
  commands,
  disabled,
  disabledReason,
  onExecute,
}: OmpNativeToolsDialogProps) {
  const { intl } = useZCodeIntl();
  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="flex max-h-[85dvh] flex-col overflow-hidden sm:max-w-3xl">
        <DialogHeader>
          <DialogTitle>{intl.formatMessage({ id: "ompNativeTools.title" })}</DialogTitle>
          <DialogDescription>
            {intl.formatMessage({ id: "ompNativeTools.description" })}
          </DialogDescription>
        </DialogHeader>
        <div className="min-h-0 overflow-y-auto space-y-4">
          <dl className="space-y-1 rounded-md border border-border bg-surface p-3 text-ui-sm">
            <div className="flex min-w-0 gap-2">
              <dt className="shrink-0 text-foreground-subtle">
                {intl.formatMessage({ id: "ompNativeTools.workspace" })}
              </dt>
              <dd className="min-w-0 break-all" title={workspaceIdentity}>
                {workspacePath}
              </dd>
            </div>
            <div className="flex min-w-0 gap-2">
              <dt className="shrink-0 text-foreground-subtle">
                {intl.formatMessage({ id: "ompNativeTools.session" })}
              </dt>
              <dd className="min-w-0 break-all">
                {sessionId ?? intl.formatMessage({ id: "ompNativeTools.draft" })}
              </dd>
            </div>
          </dl>
          <p className="text-ui-sm text-foreground-subtle">
            {intl.formatMessage({ id: "ompNativeTools.catalogScope" })}
          </p>
          {disabledReason ? (
            <p
              role="status"
              className="rounded-md border border-border bg-surface p-3 text-ui-sm text-foreground-subtle"
            >
              {intl.formatMessage({ id: disabledReason })}
            </p>
          ) : null}
          <Tabs defaultValue="projectIndex" className="gap-4">
            <TabsList
              className="max-w-full"
              aria-label={intl.formatMessage({ id: "ompNativeTools.title" })}
            >
              <TabsTrigger value="projectIndex">
                {intl.formatMessage({ id: "ompNativeTools.projectIndex" })}
              </TabsTrigger>
              <TabsTrigger value="orchestration">
                {intl.formatMessage({ id: "ompNativeTools.orchestration" })}
              </TabsTrigger>
            </TabsList>
            <TabsContent value="projectIndex">
              <OmpProjectIndexPanel commands={commands} disabled={disabled} onExecute={onExecute} />
            </TabsContent>
            <TabsContent value="orchestration">
              <OmpOrchestrationPanel
                commands={commands}
                disabled={disabled}
                onExecute={onExecute}
              />
            </TabsContent>
          </Tabs>
        </div>
      </DialogContent>
    </Dialog>
  );
}

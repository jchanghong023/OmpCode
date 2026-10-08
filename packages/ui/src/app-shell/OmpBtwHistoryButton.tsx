import { useContext, useState } from "react";
import { Button } from "@/components/ui/button.js";
import { V4ConversationContext } from "@/v4/V4ConversationContext.js";
import { createCommandEnvelope } from "@/v4/commandFactory.js";
import { openSavedSidePane } from "@/lib/OmpBtwPaneRuntime.js";
import type { SelectionSideChatPaneTab } from "@/lib/workspaceSidePane.js";
import { useZCodeIntl } from "@/i18n/IntlProvider.js";
import { Spinner } from "@/components/ui/spinner.js";

export function OmpBtwHistoryButton({ tab }: { tab: SelectionSideChatPaneTab }) {
  const { intl } = useZCodeIntl();
  const context = useContext(V4ConversationContext);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const openHistory = async () => {
    if (!context || loading) return;
    setLoading(true);
    setError(null);
    try {
      const ack = await context.sendCommand(
        createCommandEnvelope({
          type: "createSelectionSideSession",
          sessionId: tab.parentSessionId,
          payload: { restoreSaved: true },
        }),
      );
      if (
        (ack.status !== "accepted" && ack.status !== "duplicate") ||
        ack.result?.type !== "createSelectionSideSession"
      )
        throw new Error(ack.message ?? ack.reasonCode ?? "无法读取辅助对话历史");
      for (const childSessionId of ack.result.sideSessionIds ?? [ack.result.sessionId]) {
        openSavedSidePane({
          workspacePath: tab.workspacePath,
          workspaceIdentity: tab.workspaceIdentity,
          remoteSessionId: tab.remoteSessionId,
          parentSessionId: tab.parentSessionId,
          liveParentSessionId: tab.liveParentSessionId,
          childSessionId,
        });
      }
    } catch (failure) {
      setError(failure instanceof Error ? failure.message : String(failure));
    } finally {
      setLoading(false);
    }
  };
  return (
    <div className="flex flex-wrap items-center gap-2 border-b border-border px-3 py-1 text-ui-caption text-foreground-subtle">
      <span>{intl.formatMessage({ id: "chat.selections.sideCapabilities" })}</span>
      <Button
        variant="ghost"
        size="sm"
        disabled={loading || !context}
        aria-busy={loading}
        onClick={() => void openHistory()}
        data-testid="omp-btw-history"
      >
        {loading ? <Spinner className="size-3" /> : null}
        {intl.formatMessage({ id: "chat.selections.sideHistory" })}
      </Button>
      {error ? (
        <span role="alert" className="text-destructive">
          {error}
        </span>
      ) : null}
    </div>
  );
}

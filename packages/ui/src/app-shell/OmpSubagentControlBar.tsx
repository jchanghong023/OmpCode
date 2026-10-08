import { memo, useCallback, useMemo, useRef, useState } from "react";
import { SendIcon, SquareIcon } from "lucide-react";
import { Button } from "@/components/ui/button.js";
import { useWorkspaceServicesResolution } from "@/hooks/useWorkspaceServices.js";
import { useZCodeIntl } from "@/i18n/IntlProvider.js";
import { parseOmpSubagentViewIdOf } from "@/lib/ompSubagentViewId.js";

/**
 * Fork（omp-project-mode.md）：子代理只读详情顶部的显式控制条（Z15）。
 * 控制走 `session/controlSubagent` 业务入口（send_message/stop），返回状态如实呈现；
 * 只读详情本身保持观察无副作用。
 */
export const OmpSubagentControlBar = memo(function OmpSubagentControlBar({
  workspacePath,
  workspaceIdentity,
  remoteSessionId,
  childSessionId,
}: {
  workspacePath: string;
  workspaceIdentity?: string;
  remoteSessionId?: string;
  childSessionId: string;
}) {
  const { intl } = useZCodeIntl();
  const resolution = useWorkspaceServicesResolution(
    workspacePath,
    remoteSessionId,
    workspaceIdentity,
  );
  const [message, setMessage] = useState("");
  const [status, setStatus] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const controlInFlight = useRef(false);
  const target = useMemo(() => parseOmpSubagentViewIdOf(childSessionId), [childSessionId]);

  const send = useCallback(
    async (action: "send_message" | "stop") => {
      // Enter 不经过禁用按钮；用同步闩阻止同一条消息被重复提交。
      if (!target || !resolution.rpcReady || controlInFlight.current) return;
      if (action === "send_message" && !message.trim()) return;
      controlInFlight.current = true;
      setBusy(true);
      setStatus(null);
      try {
        const result = await resolution.services.zcodeAgentService.controlSubagent({
          workspacePath,
          ...(workspaceIdentity ? { workspaceIdentity } : {}),
          ...(remoteSessionId ? { remoteSessionId } : {}),
          sessionId: target.parentSessionId,
          subagentId: target.subagentId,
          action,
          ...(action === "send_message" ? { message: message.trim() } : {}),
        });
        setStatus(
          `${intl.formatMessage({ id: "ompSubagentControl.status" })}: ${result.status}${result.detail ? ` — ${result.detail}` : ""}`,
        );
        if (action === "send_message") setMessage("");
      } catch (error) {
        setStatus(
          `${intl.formatMessage({ id: "ompSubagentControl.failed" })}: ${error instanceof Error ? error.message : String(error)}`,
        );
      } finally {
        controlInFlight.current = false;
        setBusy(false);
      }
    },
    [intl, message, remoteSessionId, resolution, target, workspaceIdentity, workspacePath],
  );

  if (!target) {
    return null;
  }

  return (
    <div className="border-b border-border bg-surface px-3 py-2">
      <div className="flex items-center gap-2">
        <input
          disabled={busy || !resolution.rpcReady}
          className="min-w-0 flex-1 rounded-md border border-input-border bg-background px-2 py-1 text-ui-sm text-foreground placeholder:text-foreground-subtlest focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-input-border-focused"
          placeholder={intl.formatMessage({ id: "ompSubagentControl.sendPlaceholder" })}
          value={message}
          onChange={(event) => setMessage(event.target.value)}
          onKeyDown={(event) => {
            if (event.key === "Enter" && !event.nativeEvent.isComposing) {
              event.preventDefault();
              void send("send_message");
            }
          }}
        />
        <Button
          type="button"
          variant="ghost"
          size="sm"
          disabled={busy || !resolution.rpcReady || !message.trim()}
          onClick={() => void send("send_message")}
        >
          <SendIcon aria-hidden className="size-3.5" />
          {intl.formatMessage({ id: "ompSubagentControl.send" })}
        </Button>
        <Button
          type="button"
          variant="ghost"
          size="sm"
          disabled={busy || !resolution.rpcReady}
          onClick={() => void send("stop")}
        >
          <SquareIcon aria-hidden className="size-3 fill-current" />
          {intl.formatMessage({ id: "ompSubagentControl.stop" })}
        </Button>
      </div>
      {status ? (
        <p className="mt-1 truncate text-ui-sm text-foreground-subtlest">{status}</p>
      ) : null}
    </div>
  );
});

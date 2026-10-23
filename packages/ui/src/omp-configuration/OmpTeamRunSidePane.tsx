import { memo, useMemo } from "react";
import { useZCodeAgentService } from "@/hooks/useZCodeAgentService.js";
import { useZCodeIntl } from "@/i18n/index.js";
import type { OmpTeamRunSidePaneTab } from "@/lib/workspaceSidePane.js";
import { TeamRunView } from "./TeamRunView.js";
import { useTeamRuns } from "./useTeamRuns.js";

function OmpTeamRunDetails({ tab }: { tab: OmpTeamRunSidePaneTab }) {
  const { locale } = useZCodeIntl();
  const zh = locale.startsWith("zh");
  const service = useZCodeAgentService(
    tab.workspacePath,
    tab.remoteSessionId,
    tab.workspaceIdentity,
  );
  const target = useMemo(
    () => ({
      workspacePath: tab.workspacePath,
      ...(tab.workspaceIdentity ? { workspaceIdentity: tab.workspaceIdentity } : {}),
      sessionId: tab.parentSessionId,
    }),
    [tab.workspacePath, tab.workspaceIdentity, tab.parentSessionId],
  );
  const { runs, error, connected, busy, stop } = useTeamRuns(service, target);
  const run = runs.find((candidate) => candidate.jobId === tab.jobId);
  // 原生 capability guard 明确拒绝时展示不支持；不能另起 Agent 代替观察已有 Team。
  const unsupported = error === "Native OMP Team observation is unavailable";
  return (
    <section
      data-testid="omp-team-details"
      data-team-job-id={tab.jobId}
      data-parent-session-id={tab.parentSessionId}
      className="h-full min-h-0 overflow-y-auto bg-background p-3 text-ui-base"
    >
      {error && (
        <p
          role="alert"
          data-testid={unsupported ? "omp-team-details-unsupported" : "omp-team-details-error"}
          className="mb-3 break-words text-destructive"
        >
          {unsupported
            ? zh
              ? "当前运行时不支持原生 Team 观察。"
              : "This runtime does not support native Team observation."
            : error}
        </p>
      )}
      {run ? (
        <TeamRunView
          run={run}
          connected={connected}
          busy={busy}
          onStop={() => {
            void stop(tab.jobId);
          }}
        />
      ) : !error ? (
        <p role="status" className="text-foreground-subtle">
          {connected
            ? zh
              ? "该 Team 的原生历史暂不可用。"
              : "Native history for this Team is currently unavailable."
            : zh
              ? "正在读取 Team…"
              : "Loading Team…"}
        </p>
      ) : null}
    </section>
  );
}

export const OmpTeamRunSidePane = memo(function OmpTeamRunSidePane({
  tab,
}: {
  tab: OmpTeamRunSidePaneTab;
}) {
  // scope 改变时销毁旧观察投影，防止 effect 重置前的一帧显示另一条会话的数据。
  return (
    <OmpTeamRunDetails key={JSON.stringify([tab.id, tab.remoteSessionId ?? null])} tab={tab} />
  );
});

import { useEffect, useMemo, useRef, useState } from "react";
import { resolveWorkspaceKey, type OmpProfileState } from "@zcode/shared";
import { Button } from "@/components/ui/button.js";
import { useZCodeIntl } from "@/i18n/index.js";
import { useZCodeAgentService } from "@/hooks/useZCodeAgentService.js";
import { createCommandEnvelope } from "@/v4/commandFactory.js";
import { OmpConfigurationPanel } from "./OmpConfigurationPanel.js";
import { useTeamRuns } from "./useTeamRuns.js";
import { TeamRunView } from "./TeamRunView.js";
import type { OmpProfileService } from "./contract.js";

/** Host owns profile preference and native active identity; the view owns only an unsaved choice. */
export function OmpWorkspaceProfiles({
  service,
  workspacePath,
  workspaceIdentity,
}: {
  service: OmpProfileService;
  workspacePath: string;
  workspaceIdentity?: string;
}) {
  const { locale, intl } = useZCodeIntl();
  const zh = locale.startsWith("zh");
  const target = useMemo(
    () => ({ workspacePath, workspaceIdentity }),
    [workspacePath, workspaceIdentity],
  );
  const [state, setState] = useState<OmpProfileState | null>(null);
  const [choice, setChoice] = useState("");
  const [newName, setNewName] = useState("");
  const [error, setError] = useState<string | null>(null);
  const [saving, setSaving] = useState(false);
  const generation = useRef(0);
  const readSequence = useRef(0);
  const refresh = async () => {
    const epoch = generation.current;
    const sequence = ++readSequence.current;
    try {
      const result = await service.getOmpProfiles(target);
      if (epoch !== generation.current || sequence !== readSequence.current) return;
      setState(result);
      setError(null);
      setChoice(result.selectedProfile ?? "");
    } catch (reason) {
      if (epoch !== generation.current || sequence !== readSequence.current) return;
      setState(null);
      setError(reason instanceof Error ? reason.message : String(reason));
    }
  };
  useEffect(() => {
    generation.current++;
    setState(null);
    setError(null);
    setChoice("");
    setNewName("");
    setSaving(false);
    void refresh();
    const key = resolveWorkspaceKey(target);
    const restarted = service.onAgentRuntimeRestarted((event) => {
      if (event.workspaceKey !== key) return;
      generation.current++;
      setSaving(false);
      setState(null);
      setNewName("");
      void refresh();
    });
    const lifecycle = service.onAgentRuntimeLifecycle?.((event) => {
      if (event.workspaceKey !== key) return;
      generation.current++;
      setSaving(false);
      setState(null);
      setNewName("");
      if (event.state === "available") void refresh();
      else setError(intl.formatMessage({ id: "omp.profiles.disconnected" }));
    });
    const focus = () => {
      void refresh();
    };
    window.addEventListener("focus", focus);
    return () => {
      generation.current++;
      restarted.dispose();
      lifecycle?.dispose();
      window.removeEventListener("focus", focus);
    };
  }, [service, target]);
  const save = async () => {
    if (!state || saving || !state.supported || state.pending) return;
    const epoch = generation.current;
    readSequence.current++;
    setSaving(true);
    setError(null);
    try {
      const result = await service.selectOmpProfile({
        ...target,
        profile: newName.trim() || choice || null,
        expectedRuntimeIdentity: state.runtimeIdentity,
        apply: "next-start",
      });
      if (epoch !== generation.current) return;
      setState(result);
      setChoice(result.selectedProfile ?? "");
      setNewName("");
    } catch (reason) {
      if (epoch === generation.current)
        setError(reason instanceof Error ? reason.message : String(reason));
    } finally {
      if (epoch === generation.current) setSaving(false);
    }
  };
  const disabled = !state?.supported || state.pending || saving;
  const profileLabel = (value: string | null) => value ?? (zh ? "默认 profile" : "Default profile");
  return (
    <section
      data-testid="omp-workspace-profiles"
      className="grid gap-2 rounded border border-border p-3"
    >
      <h2 className="font-medium">{intl.formatMessage({ id: "omp.profiles.title" })}</h2>
      <p data-testid="omp-profile-target" className="break-all">
        {zh ? "执行端" : "Execution target"}: {workspaceIdentity ?? workspacePath}
      </p>
      <p
        data-testid="omp-profile-state"
        data-runtime-identity={state?.runtimeIdentity ?? ""}
        data-active-profile={state ? (state.activeProfile ?? "default") : ""}
        data-selected-profile={state ? (state.selectedProfile ?? "default") : ""}
      >
        {zh ? "运行中" : "Active"}: {state ? profileLabel(state.activeProfile) : "—"} ·{" "}
        {zh ? "已保存" : "Selected"}: {state ? profileLabel(state.selectedProfile) : "—"} ·{" "}
        {zh ? "待应用" : "Pending"}:{" "}
        {String(Boolean(state && (state.pending || state.selectedProfile !== state.activeProfile)))}
      </p>
      {state && (state.pending || state.selectedProfile !== state.activeProfile) && (
        <p role="status" data-testid="omp-profile-restart-required">
          {intl.formatMessage({ id: "omp.configuration.profileRestartRequired" })}
        </p>
      )}
      <label>
        {zh ? "已有目录" : "Existing profile directories"}
        <select
          data-testid="omp-profile-select"
          className="ml-2 rounded border border-border bg-background p-1"
          disabled={disabled}
          value={choice}
          onChange={(event) => {
            setChoice(event.target.value);
            setNewName("");
          }}
        >
          <option value="">{profileLabel(null)}</option>
          {state?.profiles
            .filter((profile) => profile.name !== null)
            .map((profile) => (
              <option key={profile.name} value={profile.name!}>
                {profile.name}
              </option>
            ))}
          {state?.selectedProfile &&
            !state.profiles.some((profile) => profile.name === state.selectedProfile) && (
              <option value={state.selectedProfile}>{state.selectedProfile}</option>
            )}
        </select>
      </label>
      <label>
        {zh ? "新 profile 名称（执行端验证）" : "New profile name (validated by execution target)"}
        <input
          data-testid="omp-profile-new-name"
          className="ml-2 rounded border border-border bg-background p-1"
          disabled={disabled}
          value={newName}
          onChange={(event) => setNewName(event.target.value)}
        />
      </label>
      <div className="flex flex-wrap gap-2">
        <Button
          data-testid="omp-profile-save-next"
          disabled={disabled}
          onClick={() => {
            void save();
          }}
        >
          {intl.formatMessage({ id: "omp.profiles.saveNext" })}
        </Button>
        <Button
          variant="outline"
          data-testid="omp-profile-refresh"
          disabled={saving}
          onClick={() => {
            void refresh();
          }}
        >
          {zh ? "重新读取" : "Reload"}
        </Button>
      </div>
      <p className="text-ui-caption">
        {zh
          ? "保存 profile 选择仅在完整退出并重启应用后生效，不会热切换或停止现有任务。"
          : "Saved profile selections take effect only after fully exiting and restarting the app. Saving never hot-switches or stops existing work."}
      </p>
      {state?.reason && <p role="status">{state.reason}</p>}
      {state?.blockers.map((blocker, index) => (
        <p role="status" key={index}>
          {blocker.code}: {blocker.message}
        </p>
      ))}
      {error && (
        <p data-testid="omp-profile-error" role="alert">
          {error}
        </p>
      )}
    </section>
  );
}

export interface TeamPageProps {
  workspacePath: string;
  workspaceIdentity?: string;
  sessionId?: string;
  remoteSessionId?: string;
}
/** Routes through the current workspace Host; never creates a replacement Team runtime. */
export function TeamPage(props: TeamPageProps) {
  const { locale } = useZCodeIntl();
  const zh = locale.startsWith("zh");
  const service = useZCodeAgentService(
    props.workspacePath,
    props.remoteSessionId,
    props.workspaceIdentity,
  );
  const [historySession, setHistorySession] = useState("");
  const sessionId = props.sessionId ?? historySession.trim();
  const target = useMemo(
    () => ({
      workspacePath: props.workspacePath,
      ...(props.workspaceIdentity ? { workspaceIdentity: props.workspaceIdentity } : {}),
      sessionId,
    }),
    [props.workspacePath, props.workspaceIdentity, sessionId],
  );
  const { runs, error, connected, busy, refresh, stop } = useTeamRuns(service, target);
  const [configure, setConfigure] = useState(false);
  const [task, setTask] = useState("");
  const [sending, setSending] = useState(false);
  const [sendError, setSendError] = useState<string | null>(null);
  const start = async () => {
    if (!props.sessionId || !task.trim() || sending) return;
    setSending(true);
    setSendError(null);
    try {
      const ack = await service.sendConversationCommandV4({
        ...target,
        envelope: createCommandEnvelope({
          type: "sendText",
          sessionId: props.sessionId,
          payload: { text: `/team Read-only investigation. Do not modify files.\n${task.trim()}` },
        }),
      });
      if (ack.status !== "accepted") throw new Error(JSON.stringify(ack));
      setTask("");
      await refresh();
    } catch (reason) {
      setSendError(reason instanceof Error ? reason.message : String(reason));
    } finally {
      setSending(false);
    }
  };
  return (
    <main
      data-testid="omp-team-page"
      className="h-full min-w-0 overflow-auto bg-background p-4 text-ui-base text-foreground"
    >
      <div className="mx-auto grid max-w-6xl gap-4">
        <header className="flex flex-wrap items-center gap-2">
          <h1 className="mr-auto text-ui-xl font-medium">Team</h1>
          <Button
            variant="outline"
            data-testid="omp-team-configure"
            disabled={!props.sessionId}
            onClick={() => setConfigure(true)}
          >
            {zh ? "Team 专用设置" : "Team settings"}
          </Button>
          <Button
            variant="outline"
            data-testid="omp-team-refresh"
            disabled={!sessionId}
            onClick={() => {
              void refresh();
            }}
          >
            {zh ? "刷新" : "Refresh"}
          </Button>
        </header>
        <OmpWorkspaceProfiles
          key={resolveWorkspaceKey(props)}
          service={service}
          workspacePath={props.workspacePath}
          workspaceIdentity={props.workspaceIdentity}
        />
        {!props.sessionId && (
          <label className="grid gap-1">
            {zh ? "历史会话 ID（只读）" : "Historical session ID (read-only)"}
            <input
              data-testid="omp-team-history-session"
              value={historySession}
              onChange={(event) => setHistorySession(event.target.value)}
              className="rounded border border-input-border bg-input px-2 py-1 text-ui-base"
            />
          </label>
        )}
        <p className="text-ui-caption text-foreground-subtle">
          {zh
            ? "原生 Team 负责执行、模型和成员策略；此页只呈现真实观测。缺失历史不会生成演示节点或推测关系。"
            : "Native Team owns execution, models and membership. This page shows observed facts only; absent history never produces demo nodes or inferred relationships."}
        </p>
        <section className="grid gap-2 rounded border border-border p-3">
          <label htmlFor="omp-team-task">
            {zh ? "只读调查目标" : "Read-only investigation goal"}
          </label>
          <textarea
            id="omp-team-task"
            data-testid="omp-team-task"
            disabled={!props.sessionId || !connected}
            value={task}
            onChange={(event) => setTask(event.target.value)}
            className="min-h-20 rounded border border-input-border bg-input p-2 text-ui-base"
          />
          <Button
            data-testid="omp-team-start"
            disabled={!props.sessionId || !connected || sending || !task.trim()}
            onClick={() => {
              void start();
            }}
          >
            {zh ? "通过 /team 启动" : "Start via /team"}
          </Button>
          {!props.sessionId && (
            <p role="status">
              {zh
                ? "请先选择真实会话以配置和启动 Team；历史读取不会启动会话。"
                : "Select a real session to configure and start Team; historical reads do not activate a session."}
            </p>
          )}
          {props.sessionId && !connected && (
            <p role="status">
              {zh
                ? "原生 Team 能力尚不可用或连接中断；启动控件保留但不可操作。具体原因见下方。"
                : "Native Team capability is unavailable or disconnected. Start controls remain visible but disabled; see the reason below."}
            </p>
          )}
        </section>
        <section
          data-testid="omp-team-stages"
          aria-label={zh ? "原生 Team 阶段" : "Native Team stages"}
          className="grid gap-2 rounded border border-border p-3"
        >
          <h2 className="text-ui-base font-medium">
            {zh ? "原生阶段（非执行状态）" : "Native stages (not execution status)"}
          </h2>
          <ol className="grid gap-2 sm:grid-cols-5">
            {(zh
              ? ["独立提案", "需求对齐", "交叉审查", "修订与复核", "综合报告"]
              : ["Proposals", "Alignment", "Review", "Revision / recheck", "Synthesis"]
            ).map((label) => (
              <li key={label} className="rounded border border-border p-2 text-ui-caption">
                {label}
              </li>
            ))}
          </ol>
          {runs.length === 0 && (
            <p role="status" className="text-ui-caption text-foreground-subtle">
              {zh
                ? "暂无原生阶段观测；保留阶段视图，不推测运行进度。"
                : "No native stage observation is available. The stage view remains visible without inventing execution progress."}
            </p>
          )}
        </section>
        {(error || sendError) && (
          <p role="alert" className="break-all text-destructive">
            {error ?? sendError}
          </p>
        )}
        {connected && runs.length === 0 && (
          <p data-testid="omp-team-empty">
            {zh ? "该会话暂无原生 Team 运行。" : "No native Team runs in this session."}
          </p>
        )}
        {runs.map((run) => (
          <TeamRunView
            key={run.jobId}
            run={run}
            connected={connected}
            busy={busy}
            onStop={() => {
              void stop(run.jobId);
            }}
          />
        ))}
        {configure && props.sessionId && (
          <OmpConfigurationPanel
            {...target}
            service={service}
            onClose={() => setConfigure(false)}
          />
        )}
      </div>
    </main>
  );
}

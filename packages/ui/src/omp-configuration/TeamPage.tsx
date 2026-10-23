import { useEffect, useMemo, useRef, useState } from "react";
import { resolveWorkspaceKey, type OmpProfileState } from "@zcode/shared";
import { Users } from "lucide-react";
import { Button } from "@/components/ui/button.js";
import { useZCodeIntl } from "@/i18n/index.js";
import { useZCodeAgentService } from "@/hooks/useZCodeAgentService.js";
import { OmpConfigurationPanel } from "./OmpConfigurationPanel.js";
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
    if (!state || saving || !state.supported) return;
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
  // 待重启只禁止向旧 profile 写角色，不锁定下次启动选择；用户仍可改选或撤销，
  // 实际运行域继续由 Host/native 事实决定，不能因已有 pending 而禁用选择器。
  const disabled = !state?.supported || saving;
  const profileLabel = (value: string | null) => value ?? (zh ? "默认 profile" : "Default profile");
  return (
    <section
      data-testid="omp-workspace-profiles"
      className="grid w-full min-w-0 max-w-full grid-cols-[minmax(0,1fr)] gap-4 rounded-lg border border-border bg-card p-4"
    >
      <div className="flex min-w-0 flex-wrap items-start justify-between gap-3">
        <div className="min-w-0 max-w-full flex-1">
          <h2 className="text-ui-base font-semibold">
            {intl.formatMessage({ id: "omp.profiles.title" })}
          </h2>
          <p
            data-testid="omp-profile-target"
            title={workspaceIdentity ?? workspacePath}
            className="mt-1 truncate text-ui-caption text-foreground-subtle"
          >
            {zh ? "执行端" : "Execution target"} · {workspaceIdentity ?? workspacePath}
          </p>
        </div>
        <div
          data-testid="omp-profile-state"
          data-runtime-identity={state?.runtimeIdentity ?? ""}
          data-active-profile={state ? (state.activeProfile ?? "default") : ""}
          data-selected-profile={state ? (state.selectedProfile ?? "default") : ""}
          className="flex min-w-0 max-w-full flex-wrap gap-2 text-ui-caption"
        >
          <span className="max-w-full break-all rounded bg-surface px-2 py-1">
            {zh ? "运行中" : "Active"} · {state ? profileLabel(state.activeProfile) : "—"}
          </span>
          <span className="max-w-full break-all rounded bg-surface px-2 py-1">
            {zh ? "已保存" : "Selected"} · {state ? profileLabel(state.selectedProfile) : "—"}
          </span>
        </div>
      </div>
      {state && (state.pending || state.selectedProfile !== state.activeProfile) && (
        <p
          role="status"
          data-testid="omp-profile-restart-required"
          className="rounded bg-warning-surface px-3 py-2 text-ui-caption text-warning-surface-foreground"
        >
          {intl.formatMessage({ id: "omp.configuration.profileRestartRequired" })}
        </p>
      )}
      <div className="grid min-w-0 grid-cols-[minmax(0,1fr)] items-end gap-3 md:grid-cols-2">
        <label className="grid min-w-0 grid-cols-[minmax(0,1fr)] gap-1.5 text-ui-caption text-foreground-subtle">
          {zh ? "已有目录" : "Existing profile directories"}
          <select
            data-testid="omp-profile-select"
            className="h-9 w-full min-w-0 rounded-md border border-input-border bg-input px-3 text-ui-base text-foreground outline-none focus:border-input-border-focused focus:ring-1 focus:ring-input-border-focused disabled:opacity-50"
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
        <label className="grid min-w-0 grid-cols-[minmax(0,1fr)] gap-1.5 text-ui-caption text-foreground-subtle">
          {zh
            ? "新 profile 名称（执行端验证）"
            : "New profile name (validated by execution target)"}
          <input
            data-testid="omp-profile-new-name"
            className="h-9 w-full min-w-0 rounded-md border border-input-border bg-input px-3 text-ui-base text-foreground outline-none focus:border-input-border-focused focus:ring-1 focus:ring-input-border-focused disabled:opacity-50"
            disabled={disabled}
            value={newName}
            onChange={(event) => setNewName(event.target.value)}
          />
        </label>
      </div>
      <div className="flex flex-wrap items-center gap-2">
        <Button
          size="sm"
          variant="outline"
          data-testid="omp-profile-save-next"
          disabled={disabled}
          onClick={() => {
            void save();
          }}
        >
          {intl.formatMessage({ id: "omp.profiles.saveNext" })}
        </Button>
        <Button
          size="sm"
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
      <p className="text-ui-caption leading-relaxed text-foreground-subtle">
        {zh
          ? "保存 profile 选择仅在完整退出并重启应用后生效，不会热切换或停止现有任务。"
          : "Saved profile selections take effect only after fully exiting and restarting the app. Saving never hot-switches or stops existing work."}
      </p>
      {state?.reason && (
        <p role="status" className="text-ui-caption text-foreground-subtle">
          {state.reason}
        </p>
      )}
      {state?.blockers.map((blocker, index) => (
        <p role="status" key={index} className="break-words text-ui-caption text-warning">
          {blocker.code}: {blocker.message}
        </p>
      ))}
      {error && (
        <p
          data-testid="omp-profile-error"
          role="alert"
          className="break-words text-ui-caption text-destructive"
        >
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
/** Settings are global to the execution profile; discussion stays in its existing chat. */
export function TeamPage(props: TeamPageProps) {
  const { locale } = useZCodeIntl();
  const zh = locale.startsWith("zh");
  const service = useZCodeAgentService(
    props.workspacePath,
    props.remoteSessionId,
    props.workspaceIdentity,
  );
  return (
    <main
      data-testid="omp-team-page"
      className="h-full min-w-0 overflow-auto bg-background text-ui-base text-foreground"
    >
      <div className="mx-auto grid w-full max-w-4xl gap-4 px-4 py-6 lg:px-8">
        <header className="flex flex-wrap items-center gap-2">
          <div className="mr-auto flex min-w-0 items-center gap-3">
            <Users className="size-4 shrink-0 text-foreground-subtle" />
            <div className="min-w-0">
              <h1 className="text-ui-xl font-semibold">{zh ? "Team 设置" : "Team settings"}</h1>
              <p className="mt-1 text-ui-caption text-foreground-subtle">
                {zh
                  ? "设置全局共用的成员模型与顺序。在聊天中输入 /team 发起讨论。"
                  : "Set shared member models and their order. Start discussions with /team in chat."}
              </p>
            </div>
          </div>
        </header>
        <OmpConfigurationPanel
          workspacePath={props.workspacePath}
          workspaceIdentity={props.workspaceIdentity}
          service={service}
          mode="team-only"
        />
      </div>
    </main>
  );
}

import { useEffect, useLayoutEffect, useMemo, useRef, useState, useSyncExternalStore } from "react";
import type { OmpModelRef } from "@zcode/shared";
import { ArrowDown, ArrowUp, Search } from "lucide-react";
import { resolveWorkspaceKey } from "@zcode/shared";
import { Button } from "@/components/ui/button.js";
import { Input } from "@/components/ui/input.js";
import { useZCodeIntl } from "@/i18n/index.js";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog.js";
import type { OmpConfigurationPanelProps } from "./contract.js";
import { OmpConfigurationController, type TeamDraftMember } from "./controller.js";
import { SavedMembers } from "./SavedMembers.js";
import { RoleRow } from "./RoleRow.js";

const selectClass =
  "h-9 min-w-0 max-w-full rounded-md border border-border bg-input px-3 text-ui-base text-foreground outline-none transition-colors hover:bg-hover focus-visible:border-input-border-focused focus-visible:ring-2 focus-visible:ring-ring disabled:cursor-not-allowed disabled:opacity-50";

export function OmpConfigurationPanel({
  service,
  workspacePath,
  workspaceIdentity,
  sessionId,
  onClose,
  onTemporaryModelSelected,
  temporaryModelDisabled = false,
  mode = "all",
}: OmpConfigurationPanelProps) {
  const { intl, locale } = useZCodeIntl();
  // locale 属于 Provider 上下文；IntlInstance 仅负责格式化，读取其 locale 会导致整个配置面板渲染崩溃。
  const temporaryModelSelectedRef = useRef(onTemporaryModelSelected);
  useLayoutEffect(() => {
    temporaryModelSelectedRef.current = onTemporaryModelSelected;
  }, [onTemporaryModelSelected]);
  // Composer 回调会随模型快照变化，但不属于会话身份；
  // 因回调重建 controller 会丢失真实成功提示及未保存草稿。
  // Team 专页的草稿只绑定执行端，不随当前聊天切换或创建会话。
  const configurationSessionId = mode !== "team-only" ? sessionId : undefined;
  const controller = useMemo(
    () =>
      new OmpConfigurationController(
        service,
        { workspacePath, workspaceIdentity, sessionId: configurationSessionId },
        (model) => temporaryModelSelectedRef.current?.(model),
      ),
    [service, workspacePath, workspaceIdentity, configurationSessionId],
  );
  const state = useSyncExternalStore(
    controller.subscribe,
    controller.getSnapshot,
    controller.getSnapshot,
  );
  const [query, setQuery] = useState("");
  const [customRole, setCustomRole] = useState("");
  const [showUnavailable, setShowUnavailable] = useState(false);
  useEffect(() => {
    controller.connect();
    void controller.refresh();
    const focus = () => void controller.refresh();
    window.addEventListener("focus", focus);
    const settings = service.onDynamicWorkspaceConfigFrame({ workspacePath, workspaceIdentity })(
      () => void controller.refresh(),
    );
    const restart = service.onAgentRuntimeRestarted((event) => {
      if (event.workspaceKey !== resolveWorkspaceKey({ workspacePath, workspaceIdentity })) return;
      controller.invalidate();
      setQuery("");
      setCustomRole("");
      void controller.refresh();
    });
    const lifecycle = service.onAgentRuntimeLifecycle?.((event) => {
      if (
        event.workspaceKey === resolveWorkspaceKey({ workspacePath, workspaceIdentity }) &&
        event.state === "unavailable"
      ) {
        controller.invalidate();
        setQuery("");
        setCustomRole("");
      }
    });
    return () => {
      window.removeEventListener("focus", focus);
      settings.dispose();
      restart.dispose();
      lifecycle?.dispose();
      controller.dispose();
    };
  }, [controller, service, workspacePath, workspaceIdentity]);
  useEffect(() => {
    if (!state.dirty) return;
    void controller.preview();
  }, [controller, state.clientRevision, state.dirty]);
  useEffect(() => {
    void controller.searchModels(query);
  }, [controller, query, state.models]);
  const candidates = !query
    ? state.models
    : state.modelSearch?.query === query
      ? state.modelSearch.models
      : [];
  const selectableCandidates = candidates.filter((item) => item.selectable);
  const unavailableCandidates = candidates.filter((item) => !item.selectable);
  const visibleCandidates = showUnavailable
    ? [...selectableCandidates, ...unavailableCandidates]
    : selectableCandidates;
  const selectableModels = state.models.filter((item) => item.selectable);
  const zh = locale.startsWith("zh");
  const ReceiptContainer = state.receipt?.saveState === "complete" ? "details" : "div";
  const cancel = () => {
    if (mode === "all") {
      onClose?.();
      return;
    }
    // 取消必须废弃旧请求及 CAS 草稿，再从唯一原生所有者回读；不能把旧草稿重新保存。
    controller.invalidate();
    setQuery("");
    setShowUnavailable(false);
    void controller.refresh();
  };
  const setMember = (index: number, member: TeamDraftMember) => {
    const members = [...(state.members ?? [])];
    members[index] = member;
    controller.setMembers(members);
  };
  const move = (index: number, direction: number) => {
    const members = [...(state.members ?? [])];
    const next = index + direction;
    if (next < 0 || next >= members.length) return;
    [members[index], members[next]] = [members[next]!, members[index]!];
    controller.setMembers(members);
  };
  const content = (
    <>
      {mode === "all" && (
        <DialogHeader className="shrink-0 border-b border-border px-4 py-5 pr-12 sm:px-6 sm:pr-12">
          <div className="min-w-0 text-left">
            <div className="min-w-0 space-y-1">
              <DialogTitle className="text-ui-xl font-semibold">
                {intl.formatMessage({ id: "omp.configuration.title" })}
              </DialogTitle>
              <DialogDescription className="text-ui-caption">
                {zh
                  ? "管理原生模型目录、当前会话与持久配置。"
                  : "Manage the native catalog, current session and persistent configuration."}
              </DialogDescription>
            </div>
          </div>
          <div className="mt-4 flex min-w-0 flex-wrap items-center gap-x-4 gap-y-1 rounded-md bg-surface px-3 py-2 text-left text-ui-caption text-foreground-subtle">
            <code className="min-w-0 flex-1 truncate" title={workspacePath}>
              {workspacePath}
            </code>
            <span className="min-w-0 break-all">
              {locale.startsWith("zh") ? "原生 Profile" : "Native profile"}{" "}
              <code className="text-foreground">{state.team?.profile ?? "—"}</code>
            </span>
            {mode === "all" && (
              <span className="min-w-0 break-all">
                {locale.startsWith("zh") ? "会话" : "Session"}{" "}
                <code className="text-foreground">{sessionId}</code>
              </span>
            )}
          </div>
        </DialogHeader>
      )}
      <div
        className={
          mode !== "all"
            ? "min-w-0 space-y-4"
            : "min-h-0 flex-1 space-y-4 overflow-y-auto px-4 py-5 sm:px-6"
        }
      >
        {state.error ? (
          <div
            role="alert"
            data-testid="omp-config-error"
            className="rounded-lg border border-destructive bg-destructive-surface px-3 py-2 text-ui-caption text-destructive-surface-foreground"
          >
            {state.errorCode ? `${state.errorCode} · ` : ""}
            {typeof state.error === "string"
              ? state.error
              : intl.formatMessage(state.error, state.error.values)}
          </div>
        ) : null}
        {state.notice ? (
          <p
            role="status"
            data-testid="omp-config-notice"
            className="rounded-lg border border-border bg-surface px-3 py-2 text-ui-caption"
            data-message-id={typeof state.notice === "string" ? undefined : state.notice.id}
          >
            {typeof state.notice === "string"
              ? state.notice
              : intl.formatMessage(state.notice, state.notice.values)}
          </p>
        ) : null}
        {state.supported === false ? (
          <p
            role="status"
            data-testid="omp-config-unsupported"
            className="rounded-lg bg-warning-surface px-3 py-2 text-ui-caption text-warning-surface-foreground"
          >
            {intl.formatMessage({ id: "omp.configuration.unsupported" })}
          </p>
        ) : null}
        {/* 原生未提供配置接口时保留原控件，仅禁用写入，避免把“不支持”误呈现为功能已删除。 */}
        {/* 首次原生回读前改草稿会保留空 revision，后续无法建立 CAS 保存基线；基线就绪后再允许编辑。 */}
        <fieldset
          disabled={state.supported === false || !state.team}
          className="min-w-0 space-y-6 border-0 p-0"
          data-testid="omp-config-controls"
        >
          {mode !== "roles-only" && (
            <section
              className="min-w-0 space-y-4 overflow-hidden rounded-xl border border-border bg-card p-4 shadow-none"
              data-testid="omp-team-panel"
            >
              <div>
                <div className="min-w-0">
                  <h2 className="text-ui-lg font-semibold">
                    {intl.formatMessage({ id: "omp.configuration.teamModels" })}
                  </h2>
                  <p className="mt-1 text-ui-caption text-foreground-subtle">
                    {locale.startsWith("zh")
                      ? "全局共享 Team 按槽位顺序保存；重复成员会作为独立槽位保留。"
                      : "Globally shared Team members are saved in slot order. Repeated members remain separate slots."}
                  </p>
                </div>
              </div>
              {state.team?.issues
                .filter((issue) => mode === "all" || issue.target !== "session_model")
                .map((issue, index) => (
                  <p
                    key={index}
                    className="rounded-md bg-warning-surface px-3 py-2 text-ui-caption text-warning-surface-foreground"
                  >
                    {issue.list ?? issue.target}{" "}
                    {issue.index !== undefined ? `[${issue.index}]` : ""}{" "}
                    {issue.side ?? issue.source}: {issue.message}
                  </p>
                ))}
              <fieldset
                disabled={state.busy || state.requiresReadback || state.roleWritesBlocked}
                className="grid min-w-0 gap-4 border-0 p-0"
              >
                <div className="order-2 min-w-0 space-y-3">
                  <div>
                    <h3 className="text-ui-base font-medium">{zh ? "添加模型" : "Add model"}</h3>
                    <p className="mt-1 text-ui-caption text-foreground-subtle">
                      {locale.startsWith("zh")
                        ? "搜索已配置且可用的模型，点击添加到成员列表。"
                        : "Search configured, available models and add them to the member list."}
                    </p>
                  </div>
                  <div className="relative">
                    <Search
                      className="pointer-events-none absolute left-3 top-2.5 size-4 text-foreground-subtlest"
                      aria-hidden="true"
                    />
                    <Input
                      aria-label={intl.formatMessage({ id: "omp.configuration.searchCatalog" })}
                      data-testid="omp-team-model-search"
                      value={query}
                      onChange={(event) => setQuery(event.target.value)}
                      className={`${selectClass} w-full pl-9`}
                      placeholder={intl.formatMessage({
                        id: "omp.configuration.searchPlaceholder",
                      })}
                    />
                  </div>
                  {state.team && selectableModels.length === 0 && (
                    <p
                      role="status"
                      data-testid="omp-team-no-available-models"
                      className="text-ui-caption text-foreground-subtle"
                    >
                      {zh
                        ? "当前执行端没有可用模型。请先在模型服务中配置服务地址与认证；下方可查看未就绪模型的具体原因。"
                        : "No models are available on this execution target. Configure a model provider and its authentication first; unavailable models below show their reasons."}
                    </p>
                  )}
                  {unavailableCandidates.length > 0 && (
                    <label className="flex items-center gap-2 text-ui-caption text-foreground-subtle">
                      <input
                        type="checkbox"
                        data-testid="omp-team-show-unavailable"
                        checked={showUnavailable}
                        onChange={(event) => setShowUnavailable(event.target.checked)}
                      />
                      {zh
                        ? `查看未就绪模型（${unavailableCandidates.length}）`
                        : `Show unavailable models (${unavailableCandidates.length})`}
                    </label>
                  )}
                  <div
                    className="max-h-72 divide-y divide-input-border overflow-y-auto rounded-lg border border-border"
                    data-testid="omp-team-model-catalog"
                  >
                    {visibleCandidates.map((item, index) => (
                      <div
                        key={index}
                        className="flex min-w-0 items-center justify-between gap-3 px-3 py-2 text-ui-caption hover:bg-surface"
                      >
                        <span className="min-w-0">
                          <span className="block truncate font-medium" title={item.name}>
                            {item.name}
                          </span>
                          <code className="block break-all text-ui-xs text-foreground-subtle">
                            {item.model.provider}/{item.model.modelId}
                          </code>
                          {item.reason ? (
                            <span className="block break-words text-ui-xs text-foreground-subtle">
                              {item.reason}
                            </span>
                          ) : null}
                        </span>
                        <Button
                          type="button"
                          variant="ghost"
                          className="shrink-0"
                          data-omp-model-provider={item.model.provider}
                          data-omp-model-id={item.model.modelId}
                          disabled={!item.selectable || state.busy}
                          aria-label={`${zh ? "添加" : "Add"} ${item.name}`}
                          onClick={() =>
                            controller.setMembers([...(state.members ?? []), item.model])
                          }
                        >
                          {intl.formatMessage({ id: "omp.configuration.add" })}
                        </Button>
                      </div>
                    ))}
                    {visibleCandidates.length === 0 && (
                      <p className="px-3 py-3 text-ui-caption text-foreground-subtle">
                        {zh ? "没有匹配的可用模型。" : "No matching available models."}
                      </p>
                    )}
                  </div>
                </div>
                <div className="order-1 min-w-0 space-y-2">
                  <h3 className="flex flex-wrap items-center gap-2 text-ui-base font-medium">
                    {zh ? "成员模型" : "Member models"}
                    {state.dirty ? (
                      <span className="rounded bg-warning-surface px-2 py-0.5 text-ui-xs font-normal text-warning-surface-foreground">
                        {intl.formatMessage({ id: "omp.configuration.unsaved" })}
                      </span>
                    ) : null}
                  </h3>
                  <div className="max-h-72 divide-y divide-input-border overflow-y-auto rounded-lg border border-border">
                    {state.members === undefined ? (
                      <p>{intl.formatMessage({ id: "omp.configuration.draftUnreadable" })}</p>
                    ) : state.members === null ? (
                      <p>{intl.formatMessage({ id: "omp.configuration.draftInherit" })}</p>
                    ) : state.members.length === 0 ? (
                      <p>{intl.formatMessage({ id: "omp.configuration.draftEmpty" })}</p>
                    ) : (
                      state.members.map((member, index) => (
                        <div
                          key={index}
                          className="flex min-w-0 flex-wrap items-center gap-1 px-3 py-2"
                          data-testid={`omp-team-member-${index}`}
                        >
                          <span className="flex size-6 shrink-0 items-center justify-center rounded bg-background text-ui-xs text-foreground-subtle">
                            {index + 1}
                          </span>
                          <select
                            className={`${selectClass} w-32 flex-1`}
                            disabled={
                              state.busy || state.requiresReadback || state.roleWritesBlocked
                            }
                            aria-label={intl.formatMessage(
                              { id: "omp.configuration.member" },
                              { index: index + 1 },
                            )}
                            value={JSON.stringify(member)}
                            onChange={(event) =>
                              setMember(index, JSON.parse(event.target.value) as OmpModelRef)
                            }
                          >
                            <option value={JSON.stringify(member)}>
                              {"rawSelector" in member
                                ? intl.formatMessage(
                                    { id: "omp.configuration.needsRepair" },
                                    { selector: member.rawSelector },
                                  )
                                : `${member.provider}/${member.modelId}`}
                            </option>
                            {selectableModels.map((item, candidate) => (
                              <option
                                key={candidate}
                                value={JSON.stringify(item.model)}
                                disabled={!item.selectable}
                              >
                                {item.name} · {item.model.provider}/{item.model.modelId}{" "}
                                {item.reason}
                              </option>
                            ))}
                          </select>
                          <Button
                            type="button"
                            variant="ghost"
                            disabled={index === 0}
                            aria-label={intl.formatMessage(
                              { id: "omp.configuration.moveUp" },
                              { index: index + 1 },
                            )}
                            onClick={() => move(index, -1)}
                          >
                            <ArrowUp className="size-3.5" aria-hidden="true" />
                          </Button>
                          <Button
                            type="button"
                            variant="ghost"
                            disabled={index === (state.members?.length ?? 0) - 1}
                            aria-label={intl.formatMessage(
                              { id: "omp.configuration.moveDown" },
                              { index: index + 1 },
                            )}
                            onClick={() => move(index, 1)}
                          >
                            <ArrowDown className="size-3.5" aria-hidden="true" />
                          </Button>
                          <Button
                            data-testid={`omp-team-copy-${index}`}
                            type="button"
                            variant="ghost"
                            onClick={() => {
                              const members = [...(state.members ?? [])];
                              members.splice(index + 1, 0, member);
                              controller.setMembers(members);
                            }}
                          >
                            {intl.formatMessage({ id: "omp.configuration.copy" })}
                          </Button>
                          <Button
                            type="button"
                            variant="ghost"
                            onClick={() =>
                              controller.setMembers(
                                state.members?.filter((_, slot) => slot !== index) ?? [],
                              )
                            }
                          >
                            {intl.formatMessage({ id: "common.delete" })}
                          </Button>
                        </div>
                      ))
                    )}
                  </div>
                  <details className="pt-2 text-ui-caption">
                    <summary className="cursor-pointer text-foreground-subtle">
                      {zh ? "更多设置" : "More options"}
                    </summary>
                    <div className="flex flex-wrap gap-2 pt-2">
                      <Button
                        type="button"
                        variant="outline"
                        data-testid="omp-team-default"
                        onClick={() => controller.setMembers([])}
                      >
                        {intl.formatMessage({ id: "omp.configuration.restoreDefaultDraft" })}
                      </Button>
                      <Button
                        type="button"
                        variant="ghost"
                        onClick={() => controller.setMembers(null)}
                      >
                        {intl.formatMessage({ id: "omp.configuration.clearUserDraft" })}
                      </Button>
                    </div>
                  </details>
                </div>
              </fieldset>
              <details data-testid="omp-team-advanced" className="space-y-3 text-ui-caption">
                <summary className="cursor-pointer text-foreground-subtle">
                  {zh ? "高级详情" : "Advanced details"}
                </summary>
                <p className="break-all text-foreground-subtle">
                  {workspacePath} · {state.team?.profile ?? "—"}
                </p>
                {mode === "all" && (
                  <p className="break-words rounded-md bg-surface px-3 py-2 text-ui-caption leading-relaxed text-foreground-subtle">
                    {intl.formatMessage({ id: "omp.configuration.mainModel" })}:
                    {state.team?.sessionModel
                      ? `${state.team.sessionModel.name} (${state.team.sessionModel.model.provider}/${state.team.sessionModel.model.modelId}) · ${intl.formatMessage({ id: state.team.sessionModel.available ? "omp.configuration.available" : "omp.configuration.unavailable" })}`
                      : locale.startsWith("zh")
                        ? "由讨论所属会话的主模型确定"
                        : "Determined by the discussion's session model"}{" "}
                    · {intl.formatMessage({ id: "omp.configuration.effectiveSource" })}:{" "}
                    {state.team?.source
                      ? intl.formatMessage({ id: `omp.configuration.source.${state.team.source}` })
                      : intl.formatMessage({ id: "omp.configuration.unknown" })}{" "}
                    · {intl.formatMessage({ id: "omp.configuration.sync" })}:
                    {intl.formatMessage({
                      id: `omp.configuration.status.${state.team?.storage.syncState ?? "unknown"}`,
                    })}
                  </p>
                )}
                <div className="grid gap-2 sm:grid-cols-3" data-testid="omp-team-saved-lists">
                  <SavedMembers
                    title={intl.formatMessage({ id: "omp.configuration.userActive" })}
                    members={state.team?.userMembers}
                    readState={state.team?.storage.active.readState}
                  />
                  <SavedMembers
                    title={intl.formatMessage({ id: "omp.configuration.nfsPersistent" })}
                    members={state.team?.persistentMembers}
                    readState={state.team?.storage.persistent.readState}
                  />
                  <SavedMembers
                    title={intl.formatMessage(
                      { id: "omp.configuration.currentEffective" },
                      {
                        source: state.team?.source
                          ? intl.formatMessage({
                              id: `omp.configuration.source.${state.team.source}`,
                            })
                          : intl.formatMessage({ id: "omp.configuration.unknown" }),
                      },
                    )}
                    members={state.team?.effectiveMembers}
                  />
                </div>
              </details>
              {/* Team 专页只编辑成员配置；临时会话模型仍由聊天的 all 配置入口管理。 */}
              {mode === "all" && (
                <div className="space-y-2 border-t border-border pt-4">
                  <p
                    data-testid="omp-current-session-model"
                    className="break-words text-ui-caption text-foreground-subtle"
                  >
                    {intl.formatMessage({ id: "omp.configuration.temporarySessionModel" })}:{" "}
                    {state.team?.sessionModel
                      ? `${state.team.sessionModel.model.provider}/${state.team.sessionModel.model.modelId}`
                      : intl.formatMessage({ id: "omp.configuration.unknown" })}
                  </p>
                  <label className="flex min-w-0 flex-wrap items-center gap-2 text-ui-caption font-medium">
                    {intl.formatMessage({ id: "omp.configuration.temporarySessionModel" })}
                    <select
                      aria-label={intl.formatMessage({ id: "omp.configuration.temporaryModel" })}
                      data-testid="omp-temporary-model"
                      className={selectClass}
                      disabled={state.busy || state.requiresReadback || temporaryModelDisabled}
                      value=""
                      onChange={(event) => {
                        if (event.target.value)
                          void controller.switchTemporaryModel(
                            JSON.parse(event.target.value) as OmpModelRef,
                          );
                      }}
                    >
                      <option value="">
                        {intl.formatMessage({ id: "omp.configuration.chooseTemporary" })}
                      </option>
                      {(
                        state.roles.find((role) => role.roleId === "default")?.candidateModels ??
                        state.models.map((item) => item.model)
                      ).map((model, index) => (
                        <option key={index} value={JSON.stringify(model)}>
                          {model.provider}/{model.modelId}
                        </option>
                      ))}
                    </select>
                  </label>
                  <p className="text-ui-caption text-foreground-subtle">
                    {locale.startsWith("zh")
                      ? "仅影响当前会话，不写入 Team 或持久角色配置。"
                      : "Current session only. Does not persist to Team or role configuration."}
                  </p>
                </div>
              )}
              {state.preview && mode === "all" ? (
                <section
                  data-testid="omp-team-preview"
                  className="space-y-2 rounded-lg border border-border bg-surface p-3 text-ui-caption"
                >
                  <p className="text-ui-caption font-medium">
                    {intl.formatMessage(
                      { id: "omp.configuration.previewSummary" },
                      {
                        revision: state.preview.clientRevision,
                        source: state.preview.source
                          ? intl.formatMessage({
                              id: `omp.configuration.source.${state.preview.source}`,
                            })
                          : intl.formatMessage({ id: "omp.configuration.unknown" }),
                      },
                    )}
                  </p>
                  <SavedMembers
                    title={intl.formatMessage({ id: "omp.configuration.previewMembers" })}
                    members={state.preview.effectiveMembers}
                  />
                  <p>
                    {intl.formatMessage({ id: "omp.configuration.runtimeSlots" })}:
                    {state.team?.sessionModel
                      ? state.preview.participants.map((item) => item.label).join(", ") ||
                        intl.formatMessage({ id: "omp.configuration.none" })
                      : locale.startsWith("zh")
                        ? "全局设置无法确定；运行槽位及对齐/综合模型取决于讨论所属会话的主模型。"
                        : "Unavailable in global settings; runtime slots and alignment/synthesis models depend on the discussion's session model."}
                  </p>
                  {state.preview.issues.map((issue, index) => (
                    <p key={index}>
                      {issue.list ?? issue.target}: {issue.message}
                    </p>
                  ))}
                </section>
              ) : null}
              {state.receipt ? (
                <ReceiptContainer className="text-ui-caption">
                  {state.receipt.saveState === "complete" ? (
                    <summary className="cursor-pointer text-foreground-subtle">
                      {zh ? "保存回执" : "Save receipt"} ·{" "}
                      {intl.formatMessage({ id: "omp.configuration.status.complete" })}
                    </summary>
                  ) : null}
                  <section
                    data-testid="omp-team-receipt"
                    data-save-state={state.receipt.saveState}
                    className="space-y-2 rounded-lg border border-border bg-surface p-3 text-ui-caption"
                  >
                    <p className="font-medium">
                      {intl.formatMessage({ id: "omp.configuration.saveResult" })}:{" "}
                      {intl.formatMessage({
                        id: `omp.configuration.status.${state.receipt.saveState}`,
                      })}
                    </p>
                    <p>
                      {intl.formatMessage({ id: "omp.configuration.active" })}:{" "}
                      {intl.formatMessage({
                        id: `omp.configuration.status.${state.receipt.writes.active.status}`,
                      })}{" "}
                      {state.receipt.writes.active.message} ·{" "}
                      {intl.formatMessage({ id: "omp.configuration.persistent" })}:
                      {intl.formatMessage({
                        id: `omp.configuration.status.${state.receipt.writes.persistent.status}`,
                      })}{" "}
                      {state.receipt.writes.persistent.message}
                    </p>
                  </section>
                </ReceiptContainer>
              ) : null}
              <Button
                type="button"
                className="w-fit"
                data-testid="omp-team-save"
                disabled={
                  state.roleWritesBlocked ||
                  state.busy ||
                  !state.dirty ||
                  !state.expectedRevision ||
                  !state.team?.writableScopes.includes("user") ||
                  state.requiresReadback ||
                  Boolean(state.members?.some((item) => "rawSelector" in item))
                }
                onClick={() => void controller.saveTeam()}
              >
                {intl.formatMessage({ id: "omp.configuration.saveTeam" })}
              </Button>
              {state.roleWritesBlocked && mode === "team-only" && (
                <p role="status" className="text-ui-caption text-warning">
                  {intl.formatMessage({ id: "omp.configuration.profileRestartRequired" })}
                </p>
              )}
            </section>
          )}
          {mode !== "team-only" && (
            <section className="min-w-0" data-testid="omp-role-panel">
              <h2 className="text-ui-lg font-semibold">
                {intl.formatMessage({ id: "omp.configuration.persistentRoles" })}
              </h2>
              <p className="mb-3 mt-1 text-ui-caption text-foreground-subtle">
                {locale.startsWith("zh")
                  ? "各角色独立保存到原生用户配置，来源与项目覆盖保持可见。"
                  : "Save each role independently to native user configuration. Sources and project overrides remain visible."}
              </p>
              {state.roleWritesBlocked && (
                <p
                  data-testid="omp-role-profile-pending"
                  role="status"
                  className="rounded-md bg-warning-surface px-3 py-2 text-ui-caption text-warning-surface-foreground"
                >
                  {intl.formatMessage({ id: "omp.configuration.profileRestartRequired" })}
                </p>
              )}
              <div className="overflow-hidden rounded-xl border border-border bg-card py-0 shadow-none">
                {state.roles.map((role) => (
                  <RoleRow
                    key={role.roleId}
                    role={role}
                    controller={controller}
                    selectClass={selectClass}
                    disabled={state.busy || state.requiresReadback || state.roleWritesBlocked}
                  />
                ))}
              </div>
              {/* 新 profile 待重启时，新增角色也属于旧 profile 编辑；整组禁用，避免输入框和新增按钮漏过角色只读边界。 */}
              <fieldset
                disabled={state.busy || state.requiresReadback || state.roleWritesBlocked}
                className="mt-3 flex min-w-0 flex-wrap items-center gap-2 border-0 border-t border-border p-0 pt-4"
              >
                <Input
                  data-testid="omp-custom-role-id"
                  className={selectClass}
                  aria-label={intl.formatMessage({ id: "omp.configuration.newRole" })}
                  value={customRole}
                  onChange={(event) => setCustomRole(event.target.value)}
                  placeholder={intl.formatMessage({ id: "omp.configuration.customRoleId" })}
                />
                <Button
                  type="button"
                  data-testid="omp-custom-role-add"
                  variant="outline"
                  disabled={!customRole.trim() || state.busy || state.requiresReadback}
                  onClick={() => void controller.addRole(customRole.trim())}
                >
                  {intl.formatMessage({ id: "omp.configuration.addRole" })}
                </Button>
              </fieldset>
            </section>
          )}
        </fieldset>
        {state.externalChange || state.requiresReadback ? (
          <p
            role="status"
            data-testid="omp-config-external-change"
            className="rounded-lg bg-warning-surface px-3 py-2 text-ui-caption text-warning-surface-foreground"
          >
            {intl.formatMessage({ id: "omp.configuration.externalChange" })}
          </p>
        ) : null}
      </div>
      <div
        className={`flex shrink-0 flex-wrap items-center justify-end gap-2 border-t border-border py-3 ${mode === "all" ? "bg-popover px-4 sm:px-6" : ""}`}
      >
        <Button
          type="button"
          variant="outline"
          className="mr-auto"
          data-testid="omp-config-refresh"
          onClick={() => void controller.refresh()}
        >
          {intl.formatMessage({ id: "omp.configuration.refresh" })}
        </Button>
        {(mode === "all" || state.externalChange || state.requiresReadback) && (
          <Button
            type="button"
            variant="outline"
            disabled={state.supported === false || !state.team || state.requiresReadback}
            data-testid="omp-config-rebase"
            onClick={() => controller.rebase()}
          >
            {intl.formatMessage({ id: "omp.configuration.adoptLatest" })}
          </Button>
        )}
        <Button
          type="button"
          variant="outline"
          disabled={state.busy}
          data-testid="omp-config-cancel"
          onClick={cancel}
        >
          {mode !== "all"
            ? zh
              ? "取消"
              : "Cancel"
            : intl.formatMessage({ id: "omp.configuration.cancelClose" })}
        </Button>
      </div>
    </>
  );
  if (mode !== "all") {
    return (
      <div data-testid="omp-configuration-panel" className="min-w-0">
        {content}
      </div>
    );
  }
  return (
    <Dialog
      open
      onOpenChange={(open) => {
        if (!open) onClose?.();
      }}
    >
      <DialogContent
        className="flex max-h-[90dvh] w-full max-w-6xl flex-col gap-0 overflow-hidden p-0"
        data-testid="omp-configuration-panel"
      >
        {content}
      </DialogContent>
    </Dialog>
  );
}

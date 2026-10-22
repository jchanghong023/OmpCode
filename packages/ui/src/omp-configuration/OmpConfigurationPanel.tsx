import { useEffect, useLayoutEffect, useMemo, useRef, useState, useSyncExternalStore } from "react";
import type { OmpModelRef, OmpRoleDescriptor, OmpTeamMemberSlot } from "@zcode/shared";
import { resolveWorkspaceKey } from "@zcode/shared";
import { Button } from "@/components/ui/button.js";
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

const selectClass =
  "min-w-0 rounded border border-popover-border bg-surface px-2 py-1 text-ui-base";
function SavedMembers({
  title,
  members,
  readState,
}: {
  title: string;
  members: OmpTeamMemberSlot[] | null | undefined;
  readState?: string;
}) {
  const { intl } = useZCodeIntl();
  return (
    <section className="min-w-0 rounded border border-popover-border p-2">
      <h3 className="text-ui-caption font-medium">
        {title}{" "}
        {readState
          ? `(${intl.formatMessage({ id: `omp.configuration.status.${readState}` })})`
          : ""}
      </h3>
      {members === undefined ? (
        <p>{intl.formatMessage({ id: "omp.configuration.unreadable" })}</p>
      ) : members === null ? (
        <p>{intl.formatMessage({ id: "omp.configuration.notConfigured" })}</p>
      ) : members.length === 0 ? (
        <p>{intl.formatMessage({ id: "omp.configuration.emptyFallback" })}</p>
      ) : (
        <ol className="list-inside list-decimal">
          {members.map((slot, index) => (
            <li key={index} className="break-all text-ui-caption">
              <code>{slot.rawSelector}</code> —{" "}
              {slot.name ??
                slot.model?.modelId ??
                intl.formatMessage({ id: "omp.configuration.unresolved" })}{" "}
              [{intl.formatMessage({ id: `omp.configuration.status.${slot.status}` })}]{" "}
              {slot.reason}
            </li>
          ))}
        </ol>
      )}
    </section>
  );
}
function RoleRow({
  role,
  controller,
  disabled,
}: {
  role: OmpRoleDescriptor;
  controller: OmpConfigurationController;
  disabled: boolean;
}) {
  const { intl } = useZCodeIntl();
  const state = controller.getSnapshot();
  const draft = state.roleDrafts[role.roleId];
  const choice = draft
    ? draft.selection === null
      ? "inherit"
      : draft.selection.kind === "auto"
        ? "auto"
        : JSON.stringify({
            provider: draft.selection.model.provider,
            modelId: draft.selection.model.modelId,
          })
    : "unchanged";
  return (
    <fieldset
      className="grid gap-2 rounded border border-popover-border p-2"
      disabled={disabled || !role.configurable || !role.writableScopes.includes("user")}
      data-testid={`omp-role-${role.roleId}`}
    >
      <legend className="px-1 text-ui-caption font-medium">
        {role.name} / {role.roleId}{" "}
        {role.hidden ? intl.formatMessage({ id: "omp.configuration.internal" }) : ""}
      </legend>
      <p className="text-ui-caption">
        {intl.formatMessage({ id: "omp.configuration.user" })}:{" "}
        {role.userValue ?? intl.formatMessage({ id: "omp.configuration.notConfigured" })} ·{" "}
        {intl.formatMessage({ id: "omp.configuration.project" })}:{" "}
        {role.projectValue ?? intl.formatMessage({ id: "omp.configuration.notConfigured" })} ·{" "}
        {intl.formatMessage({ id: "omp.configuration.effective" })}:
        {role.effectiveModel
          ? `${role.effectiveModel.provider}/${role.effectiveModel.modelId}`
          : role.unresolvedReason}{" "}
        · {intl.formatMessage({ id: "omp.configuration.source" })}:{" "}
        {intl.formatMessage({ id: `omp.configuration.source.${role.source}` })}
      </p>
      {role.description ? <p className="text-ui-caption">{role.description}</p> : null}
      <div className="flex flex-wrap gap-2">
        <select
          aria-label={intl.formatMessage(
            { id: "omp.configuration.roleModel" },
            { roleId: role.roleId },
          )}
          data-testid={`omp-role-select-${role.roleId}`}
          className={selectClass}
          value={choice}
          onChange={(event) => {
            const value = event.target.value;
            if (value === "unchanged") return;
            controller.setRole(
              role,
              value === "inherit"
                ? null
                : value === "auto"
                  ? { kind: "auto" }
                  : { kind: "model", model: JSON.parse(value) as OmpModelRef },
            );
          }}
        >
          <option value="unchanged">
            {intl.formatMessage({ id: "omp.configuration.keepCurrent" })}
          </option>
          <option value="inherit">
            {intl.formatMessage({ id: "omp.configuration.clearRole" })}
          </option>
          <option value="auto">{intl.formatMessage({ id: "omp.configuration.auto" })}</option>
          {role.candidateModels.map((model, index) => (
            <option key={index} value={JSON.stringify(model)}>
              {model.provider}/{model.modelId}
            </option>
          ))}
        </select>
        {draft?.selection?.kind === "model" ? (
          <input
            aria-label={intl.formatMessage(
              { id: "omp.configuration.roleThinking" },
              { roleId: role.roleId },
            )}
            className={selectClass}
            placeholder={intl.formatMessage({ id: "omp.configuration.thinkingOptional" })}
            value={draft.selection.model.thinkingLevel ?? ""}
            onChange={(event) => {
              if (draft.selection?.kind !== "model") return;
              const { thinkingLevel: _thinkingLevel, ...model } = draft.selection.model;
              controller.setRole(role, {
                kind: "model",
                model: {
                  ...model,
                  ...(event.target.value ? { thinkingLevel: event.target.value } : {}),
                },
              });
            }}
          />
        ) : null}
        <Button
          type="button"
          variant="outline"
          disabled={!draft}
          data-testid={`omp-role-save-${role.roleId}`}
          onClick={() => void controller.saveRole(role.roleId)}
        >
          {intl.formatMessage({ id: "omp.configuration.saveRole" })}
        </Button>
      </div>
      {role.nonConfigurableReason ? <p>{role.nonConfigurableReason}</p> : null}
    </fieldset>
  );
}

export function OmpConfigurationPanel({
  service,
  workspacePath,
  workspaceIdentity,
  sessionId,
  onClose,
  onTemporaryModelSelected,
  temporaryModelDisabled = false,
}: OmpConfigurationPanelProps) {
  const { intl } = useZCodeIntl();
  const temporaryModelSelectedRef = useRef(onTemporaryModelSelected);
  useLayoutEffect(() => {
    temporaryModelSelectedRef.current = onTemporaryModelSelected;
  }, [onTemporaryModelSelected]);
  // Composer 回调会随模型快照变化，但不属于会话身份；
  // 因回调重建 controller 会丢失真实成功提示及未保存草稿。
  const controller = useMemo(
    () =>
      new OmpConfigurationController(
        service,
        { workspacePath, workspaceIdentity, sessionId },
        (model) => temporaryModelSelectedRef.current?.(model),
      ),
    [service, workspacePath, workspaceIdentity, sessionId],
  );
  const state = useSyncExternalStore(
    controller.subscribe,
    controller.getSnapshot,
    controller.getSnapshot,
  );
  const [query, setQuery] = useState("");
  const [customRole, setCustomRole] = useState("");
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
  return (
    <Dialog
      open
      onOpenChange={(open) => {
        if (!open) onClose();
      }}
    >
      <DialogContent
        className="max-h-[85vh] max-w-4xl overflow-y-auto"
        data-testid="omp-configuration-panel"
      >
        <DialogHeader>
          <DialogTitle>{intl.formatMessage({ id: "omp.configuration.title" })}</DialogTitle>
          <DialogDescription>
            {intl.formatMessage(
              { id: "omp.configuration.description" },
              { sessionId, profile: state.team?.profile ?? "default" },
            )}
          </DialogDescription>
        </DialogHeader>
        {state.error ? (
          <div
            role="alert"
            data-testid="omp-config-error"
            className="rounded border border-popover-border p-2 text-ui-base"
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
            data-message-id={typeof state.notice === "string" ? undefined : state.notice.id}
          >
            {typeof state.notice === "string"
              ? state.notice
              : intl.formatMessage(state.notice, state.notice.values)}
          </p>
        ) : null}
        {state.supported === false ? (
          <p role="status" data-testid="omp-config-unsupported">
            {intl.formatMessage({ id: "omp.configuration.unsupported" })}
          </p>
        ) : null}
        {/* 原生未提供配置接口时保留原控件，仅禁用写入，避免把“不支持”误呈现为功能已删除。 */}
        <fieldset
          disabled={state.supported === false}
          className="min-w-0 space-y-4 border-0 p-0"
          data-testid="omp-config-controls"
        >
          <section className="grid gap-2" data-testid="omp-team-panel">
            <h2 className="text-ui-lg font-medium">
              {intl.formatMessage({ id: "omp.configuration.teamModels" })}
            </h2>
            <p className="text-ui-caption">
              {intl.formatMessage({ id: "omp.configuration.mainModel" })}:
              {state.team?.sessionModel
                ? `${state.team.sessionModel.name} (${state.team.sessionModel.model.provider}/${state.team.sessionModel.model.modelId}) · ${intl.formatMessage({ id: state.team.sessionModel.available ? "omp.configuration.available" : "omp.configuration.unavailable" })}`
                : intl.formatMessage({ id: "omp.configuration.none" })}{" "}
              · {intl.formatMessage({ id: "omp.configuration.effectiveSource" })}:{" "}
              {state.team?.source
                ? intl.formatMessage({ id: `omp.configuration.source.${state.team.source}` })
                : intl.formatMessage({ id: "omp.configuration.unknown" })}{" "}
              · {intl.formatMessage({ id: "omp.configuration.sync" })}:
              {intl.formatMessage({
                id: `omp.configuration.status.${state.team?.storage.syncState ?? "unknown"}`,
              })}
            </p>
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
            {state.team?.issues.map((issue, index) => (
              <p key={index} className="text-ui-caption">
                {issue.list ?? issue.target} {issue.index !== undefined ? `[${issue.index}]` : ""}{" "}
                {issue.side ?? issue.source}: {issue.message}
              </p>
            ))}
            <h3 className="text-ui-caption font-medium">
              {intl.formatMessage({ id: "omp.configuration.userDraft" })}{" "}
              {state.dirty ? intl.formatMessage({ id: "omp.configuration.unsaved" }) : ""}
            </h3>
            <input
              aria-label={intl.formatMessage({ id: "omp.configuration.searchCatalog" })}
              data-testid="omp-team-model-search"
              value={query}
              onChange={(event) => setQuery(event.target.value)}
              className={selectClass}
              placeholder={intl.formatMessage({ id: "omp.configuration.searchPlaceholder" })}
            />
            <div
              className="max-h-36 overflow-auto rounded border border-popover-border p-2"
              data-testid="omp-team-model-catalog"
            >
              {candidates.map((item, index) => (
                <div
                  key={index}
                  className="flex flex-wrap items-center justify-between gap-2 text-ui-caption"
                >
                  <span className="min-w-0 break-words">
                    {item.name} · {item.model.provider}/{item.model.modelId} {item.reason}
                  </span>
                  <Button
                    type="button"
                    variant="ghost"
                    disabled={!item.selectable || state.busy}
                    onClick={() => controller.setMembers([...(state.members ?? []), item.model])}
                  >
                    {intl.formatMessage({ id: "omp.configuration.add" })}
                  </Button>
                </div>
              ))}
            </div>
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
                  className="flex flex-wrap items-center gap-1"
                  data-testid={`omp-team-member-${index}`}
                >
                  <span className="text-ui-caption">{index + 1}</span>
                  <select
                    className={selectClass}
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
                    {state.models.map((item, candidate) => (
                      <option
                        key={candidate}
                        value={JSON.stringify(item.model)}
                        disabled={!item.selectable}
                      >
                        {item.name} · {item.model.provider}/{item.model.modelId} {item.reason}
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
                    ↑
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
                    ↓
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
            <p data-testid="omp-current-session-model" className="text-ui-caption">
              {intl.formatMessage({ id: "omp.configuration.temporarySessionModel" })}:{" "}
              {state.team?.sessionModel
                ? `${state.team.sessionModel.model.provider}/${state.team.sessionModel.model.modelId}`
                : intl.formatMessage({ id: "omp.configuration.unknown" })}
            </p>
            <label className="flex flex-wrap gap-2 text-ui-caption">
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
            <div className="flex flex-wrap gap-2">
              <Button
                type="button"
                variant="outline"
                data-testid="omp-team-default"
                onClick={() => controller.setMembers([])}
              >
                {intl.formatMessage({ id: "omp.configuration.restoreDefaultDraft" })}
              </Button>
              <Button type="button" variant="outline" onClick={() => controller.setMembers(null)}>
                {intl.formatMessage({ id: "omp.configuration.clearUserDraft" })}
              </Button>
            </div>
            {state.preview ? (
              <section data-testid="omp-team-preview" className="grid gap-2">
                <p className="text-ui-caption">
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
                  {state.preview.participants.map((item) => item.label).join(", ") ||
                    intl.formatMessage({ id: "omp.configuration.none" })}
                </p>
                {state.preview.issues.map((issue, index) => (
                  <p key={index}>
                    {issue.list ?? issue.target}: {issue.message}
                  </p>
                ))}
              </section>
            ) : null}
            {state.receipt ? (
              <section data-testid="omp-team-receipt" data-save-state={state.receipt.saveState}>
                <p>
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
            ) : null}
            <Button
              type="button"
              data-testid="omp-team-save"
              disabled={
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
          </section>
          <section className="grid gap-2" data-testid="omp-role-panel">
            <h2 className="text-ui-lg font-medium">
              {intl.formatMessage({ id: "omp.configuration.persistentRoles" })}
            </h2>
            {state.roleWritesBlocked && (
              <p data-testid="omp-role-profile-pending" role="status">
                {intl.formatMessage({ id: "omp.configuration.profileRestartRequired" })}
              </p>
            )}
            {state.roles.map((role) => (
              <RoleRow
                key={role.roleId}
                role={role}
                controller={controller}
                disabled={state.busy || state.requiresReadback || state.roleWritesBlocked}
              />
            ))}
            <div className="flex flex-wrap gap-2">
              <input
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
            </div>
          </section>
        </fieldset>
        {state.externalChange || state.requiresReadback ? (
          <p role="status" data-testid="omp-config-external-change">
            {intl.formatMessage({ id: "omp.configuration.externalChange" })}
          </p>
        ) : null}
        <div className="flex flex-wrap justify-end gap-2">
          <Button
            type="button"
            variant="outline"
            data-testid="omp-config-refresh"
            onClick={() => void controller.refresh()}
          >
            {intl.formatMessage({ id: "omp.configuration.refresh" })}
          </Button>
          <Button
            type="button"
            variant="outline"
            disabled={state.supported === false || !state.team || state.requiresReadback}
            data-testid="omp-config-rebase"
            onClick={() => controller.rebase()}
          >
            {intl.formatMessage({ id: "omp.configuration.adoptLatest" })}
          </Button>
          <Button type="button" variant="outline" data-testid="omp-config-cancel" onClick={onClose}>
            {intl.formatMessage({ id: "omp.configuration.cancelClose" })}
          </Button>
        </div>
      </DialogContent>
    </Dialog>
  );
}

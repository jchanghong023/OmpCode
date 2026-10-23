import type { OmpModelRef, OmpRoleDescriptor } from "@zcode/shared";
import { Button } from "@/components/ui/button.js";
import { Input } from "@/components/ui/input.js";
import { useZCodeIntl } from "@/i18n/index.js";
import type { OmpConfigurationController } from "./controller.js";
export function RoleRow({
  role,
  controller,
  disabled,
  selectClass,
}: {
  role: OmpRoleDescriptor;
  controller: OmpConfigurationController;
  disabled: boolean;
  selectClass: string;
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
      className="min-w-0 space-y-2 border-0 border-b border-border px-4 py-3 last:border-b-0 disabled:opacity-60"
      disabled={disabled || !role.configurable || !role.writableScopes.includes("user")}
      data-testid={`omp-role-${role.roleId}`}
    >
      <legend className="flex max-w-full flex-wrap items-center gap-2 text-ui-base font-medium">
        {role.name}
        <code className="text-ui-xs font-normal text-foreground-subtle">{role.roleId}</code>
        {role.hidden ? (
          <span className="text-ui-xs text-foreground-subtle">
            {intl.formatMessage({ id: "omp.configuration.internal" })}
          </span>
        ) : null}
      </legend>
      <p className="break-words text-ui-caption leading-relaxed text-foreground-subtle">
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
      {role.description ? (
        <p className="text-ui-caption text-foreground-subtle">{role.description}</p>
      ) : null}
      <div className="flex min-w-0 flex-wrap items-center gap-2 [&>select]:w-full sm:[&>select]:w-auto sm:[&>select]:max-w-md">
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
          <Input
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
          className="shrink-0"
          data-testid={`omp-role-save-${role.roleId}`}
          onClick={() => void controller.saveRole(role.roleId)}
        >
          {intl.formatMessage({ id: "omp.configuration.saveRole" })}
        </Button>
      </div>
      {role.nonConfigurableReason ? (
        <p className="text-ui-caption text-warning-surface-foreground">
          {role.nonConfigurableReason}
        </p>
      ) : null}
    </fieldset>
  );
}

import { useMemo } from "react";
import type { ZCodeOmpModelRole } from "@zcode/shared";
import { Button } from "@/components/ui/button.js";
import { useZCodeIntl } from "@/i18n/IntlProvider.js";
import type { OmpModelCatalogEntry } from "./ompModelCatalog.js";
import { parseOmpRoleValue } from "./ompModelRoleValue.js";
import { isOmpRoleOverridden } from "./ompModelRolesFallback.js";

export interface RpcRowState {
  saving: boolean;
  savedAt: number | null;
  error: string | null;
  // 保存成功后 omp 返回的实际生效说明，行内原样展示。
  effectiveNote: string | null;
}

/** 角色字段只呈现所属编辑器的选择与回执；RPC 生命周期由 Dialog 独占。 */
export function OmpModelRolesRpcFields({
  roles,
  pending,
  rowState,
  catalogEntries,
  onSave,
  inline,
  onOpenChange,
}: {
  roles: readonly ZCodeOmpModelRole[];
  pending: Readonly<Record<string, string>>;
  rowState: Readonly<Record<string, RpcRowState>>;
  catalogEntries: readonly OmpModelCatalogEntry[];
  onSave: (roleId: string, modelPart: string, clear: boolean, level?: string) => Promise<void>;
  inline: boolean;
  onOpenChange?: (open: boolean) => void;
}) {
  const { intl } = useZCodeIntl();
  const catalogByModelPart = useMemo(() => {
    const map = new Map<string, OmpModelCatalogEntry>();
    for (const entry of catalogEntries) map.set(`${entry.providerId}/${entry.modelId}`, entry);
    return map;
  }, [catalogEntries]);
  const providerGroups = useMemo(() => {
    const groups = new Map<string, { label: string; models: { value: string; label: string }[] }>();
    for (const entry of catalogEntries) {
      const group = groups.get(entry.providerId) ?? { label: entry.providerName, models: [] };
      group.models.push({ value: `${entry.providerId}/${entry.modelId}`, label: entry.modelName });
      groups.set(entry.providerId, group);
    }
    return [...groups.values()];
  }, [catalogEntries]);

  return (
    <>
      <p className="text-ui-base text-foreground-subtle">
        {intl.formatMessage({ id: "ompModelRoles.fromAgent" })}
      </p>
      <div className="flex max-h-[50vh] flex-col gap-3 overflow-y-auto py-1">
        {roles.map((role) => {
          const row = rowState[role.roleId];
          const effective = role.effectiveModel
            ? `${role.effectiveModel.provider ?? ""}/${role.effectiveModel.modelId ?? ""}`
            : "";
          // OMP 的 auto 持久值为 "*"，显示时必须命中已有 auto 选项。
          const explicitValue = role.explicitValue === "*" ? "auto" : role.explicitValue;
          const displayValue = pending[role.roleId] ?? explicitValue ?? "";
          const parsed = parseOmpRoleValue(displayValue, catalogEntries);
          const entry = catalogByModelPart.get(parsed.modelPart);
          const overridden = isOmpRoleOverridden(role);
          return (
            <div
              key={role.roleId}
              className="flex flex-col gap-1"
              data-testid={`omp-role-${role.roleId}`}
            >
              <div className="flex items-center gap-3">
                <span className="w-24 shrink-0 text-ui-base font-medium text-foreground">
                  {role.roleId}
                </span>
                <select
                  aria-label={role.roleId}
                  className="h-8 min-w-0 flex-1 rounded-md border border-border bg-surface px-2 text-ui-base text-foreground disabled:opacity-60"
                  value={parsed.modelPart || (displayValue === "auto" ? "auto" : "")}
                  disabled={row?.saving || role.configurable === false}
                  onChange={(event) => {
                    const nextValue = event.target.value;
                    const nextEntry = catalogByModelPart.get(nextValue);
                    // 新模型支持原档位则保留，否则用新模型缺省档位；无缺省不写后缀。
                    const nextLevel = nextEntry
                      ? parsed.levelSuffix && nextEntry.thoughtLevels?.includes(parsed.levelSuffix)
                        ? parsed.levelSuffix
                        : nextEntry.defaultThoughtLevel
                      : undefined;
                    void onSave(role.roleId, nextValue, nextValue === "", nextLevel);
                  }}
                >
                  <option value="">
                    {intl.formatMessage({ id: "ompModelRoles.notConfigured" })}
                    {effective
                      ? ` (${effective})`
                      : role.unresolvedReason
                        ? ` (${role.unresolvedReason})`
                        : ""}
                  </option>
                  <option value="auto">
                    {intl.formatMessage({ id: "ompModelRoles.autoOption" })}
                  </option>
                  {/* 目录外的已配置值仍须可见，不能伪装成未配置。 */}
                  {!entry && displayValue && displayValue !== "auto" ? (
                    <option value={displayValue}>{displayValue}</option>
                  ) : null}
                  {providerGroups.map((group) => (
                    <optgroup key={group.label} label={group.label}>
                      {group.models.map((model) => (
                        <option key={model.value} value={model.value}>
                          {model.label}
                        </option>
                      ))}
                    </optgroup>
                  ))}
                </select>
                {entry?.thoughtLevels?.length ? (
                  <select
                    aria-label={`${role.roleId} ${intl.formatMessage({ id: "settings.ompModelRoles.thinkingLevel" })}`}
                    className="h-8 w-28 shrink-0 rounded-md border border-border bg-surface px-2 text-ui-base text-foreground disabled:opacity-60"
                    value={parsed.levelSuffix ?? ""}
                    disabled={row?.saving || role.configurable === false}
                    onChange={(event) => {
                      void onSave(role.roleId, parsed.modelPart, false, event.target.value);
                    }}
                  >
                    <option value="">
                      {intl.formatMessage({ id: "settings.ompModelRoles.levelDefault" })}
                    </option>
                    {entry.thoughtLevels.map((level) => (
                      <option key={level} value={level}>
                        {level}
                      </option>
                    ))}
                  </select>
                ) : null}
              </div>
              <div className="pl-24 text-ui-sm text-foreground-subtlest">
                {row?.saving ? (
                  <span>{intl.formatMessage({ id: "ompModelRoles.saving" })}</span>
                ) : row?.error ? (
                  <span className="text-destructive">
                    {intl.formatMessage({ id: "ompModelRoles.saveFailed" })}: {row.error}
                  </span>
                ) : row?.savedAt ? (
                  <span>
                    {intl.formatMessage({ id: "ompModelRoles.saved" })}
                    {overridden
                      ? ` · ${intl.formatMessage({ id: "ompModelRoles.overridden" })}`
                      : ""}
                    {row.effectiveNote ? ` · ${row.effectiveNote}` : ""}
                  </span>
                ) : role.configurable === false ? (
                  <span>{role.nonConfigurableReason ?? ""}</span>
                ) : null}
              </div>
            </div>
          );
        })}
      </div>
      {!inline ? (
        <div className="flex items-center justify-end gap-2">
          <Button variant="ghost" onClick={() => onOpenChange?.(false)}>
            {intl.formatMessage({ id: "common.close" })}
          </Button>
        </div>
      ) : null}
    </>
  );
}

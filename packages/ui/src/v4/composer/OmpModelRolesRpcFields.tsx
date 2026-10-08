import { useMemo } from "react";
import type { ZCodeOmpModelRole } from "@zcode/shared";
import { Button } from "@/components/ui/button.js";
import {
  Select,
  SelectContent,
  SelectGroup,
  SelectItem,
  SelectLabel,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select.js";
import { useZCodeIntl } from "@/i18n/IntlProvider.js";
import type { OmpModelCatalogEntry } from "./ompModelCatalog.js";
import { parseOmpRoleValue } from "./ompModelRoleValue.js";
import { isOmpRoleOverridden } from "./ompModelRolesFallback.js";

// Radix Select 不接受空选项值；占位值仅用于 UI，保存时还原 OMP 的空值语义。
const UNCONFIGURED_VALUE = "__omp_unconfigured__";
const DEFAULT_LEVEL_VALUE = "__omp_default_level__";

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
                <Select
                  value={parsed.modelPart || UNCONFIGURED_VALUE}
                  disabled={row?.saving || role.configurable === false}
                  onValueChange={(value) => {
                    const nextValue = value === UNCONFIGURED_VALUE ? "" : value;
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
                  <SelectTrigger aria-label={role.roleId} size="lg" className="min-w-0 flex-1">
                    <SelectValue />
                  </SelectTrigger>
                  <SelectContent position="popper" align="start">
                    <SelectItem value={UNCONFIGURED_VALUE}>
                      {intl.formatMessage({ id: "ompModelRoles.notConfigured" })}
                      {effective
                        ? ` (${effective})`
                        : role.unresolvedReason
                          ? ` (${role.unresolvedReason})`
                          : ""}
                    </SelectItem>
                    <SelectItem value="auto">
                      {intl.formatMessage({ id: "ompModelRoles.autoOption" })}
                    </SelectItem>
                    {/* 目录外的已配置值仍须可见，不能伪装成未配置。 */}
                    {!entry && displayValue && displayValue !== "auto" ? (
                      <SelectItem value={displayValue}>{displayValue}</SelectItem>
                    ) : null}
                    {providerGroups.map((group) => (
                      <SelectGroup key={group.label}>
                        <SelectLabel>{group.label}</SelectLabel>
                        {group.models.map((model) => (
                          <SelectItem key={model.value} value={model.value}>
                            {model.label}
                          </SelectItem>
                        ))}
                      </SelectGroup>
                    ))}
                  </SelectContent>
                </Select>
                {entry?.thoughtLevels?.length ? (
                  <Select
                    value={parsed.levelSuffix ?? DEFAULT_LEVEL_VALUE}
                    disabled={row?.saving || role.configurable === false}
                    onValueChange={(value) => {
                      void onSave(
                        role.roleId,
                        parsed.modelPart,
                        false,
                        value === DEFAULT_LEVEL_VALUE ? "" : value,
                      );
                    }}
                  >
                    <SelectTrigger
                      aria-label={`${role.roleId} ${intl.formatMessage({ id: "settings.ompModelRoles.thinkingLevel" })}`}
                      size="lg"
                      className="w-28 shrink-0"
                    >
                      <SelectValue />
                    </SelectTrigger>
                    <SelectContent position="popper" align="start">
                      <SelectItem value={DEFAULT_LEVEL_VALUE}>
                        {intl.formatMessage({ id: "settings.ompModelRoles.levelDefault" })}
                      </SelectItem>
                      {entry.thoughtLevels.map((level) => (
                        <SelectItem key={level} value={level}>
                          {level}
                        </SelectItem>
                      ))}
                    </SelectContent>
                  </Select>
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

// 本地旧核永久缺失角色 RPC 时才由 OmpModelRolesDialog 进入此分支。
// 临时选择归组件所有，保存通过主进程 YAML owner 备份并原子写入。

import { useCallback, useEffect, useMemo, useState } from "react";
import { usePlatform } from "@/hooks/usePlatform.js";
import { useZCodeIntl } from "@/i18n/IntlProvider.js";
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
import { logger } from "@/logger.js";
import type { OmpModelCatalogEntry } from "./ompModelCatalog.js";
import {
  parseOmpRoleValue,
  selectOmpRoleLevelValue,
  selectOmpRoleModelValue,
} from "./ompModelRoleValue.js";

// Radix Select 不接受空选项值；占位值仅用于 UI，不进入角色配置。
const UNCONFIGURED_VALUE = "__omp_unconfigured__";
const DEFAULT_LEVEL_VALUE = "__omp_default_level__";

const BUILTIN_OMP_ROLES = [
  "default",
  "smol",
  "slow",
  "vision",
  "plan",
  "commit",
  "tiny",
  "memory",
  "task",
  "advisor",
  "image",
  "web",
  "speech",
  "dictation",
  "judge",
] as const;

export function OmpModelRolesFallbackFields({
  catalogEntries,
  inline,
  onOpenChange,
}: {
  catalogEntries: readonly OmpModelCatalogEntry[];
  inline: boolean;
  onOpenChange?: (open: boolean) => void;
}) {
  const { intl } = useZCodeIntl();
  const platform = usePlatform();
  const [roles, setRoles] = useState<{ role: string; value: string }[]>(() =>
    BUILTIN_OMP_ROLES.map((role) => ({ role, value: "" })),
  );
  const [originalRoles, setOriginalRoles] = useState<ReadonlyMap<string, string>>(new Map());
  const [loadError, setLoadError] = useState<string | null>(null);
  const [saving, setSaving] = useState(false);
  const [saveError, setSaveError] = useState<string | null>(null);
  const [savedAt, setSavedAt] = useState<number | null>(null);
  const [savedWithBackup, setSavedWithBackup] = useState(false);

  const loadRoles = useCallback(async () => {
    if (!platform.readOmpModelRoles) {
      setLoadError("platform-unsupported");
      return;
    }
    setLoadError(null);
    try {
      const result = await platform.readOmpModelRoles();
      if (result.success) {
        const configured = new Map(result.roles.map((item) => [item.role, item.value]));
        setOriginalRoles(configured);
        const allRoles = [...new Set([...BUILTIN_OMP_ROLES, ...configured.keys()])];
        setRoles(allRoles.map((role) => ({ role, value: configured.get(role) ?? "" })));
      } else {
        setLoadError(result.error);
      }
    } catch (error) {
      setLoadError(error instanceof Error ? error.message : String(error));
    }
  }, [platform]);

  useEffect(() => {
    void loadRoles();
  }, [loadRoles]);

  const catalogByModelPart = useMemo(() => {
    const map = new Map<string, OmpModelCatalogEntry>();
    for (const entry of catalogEntries) {
      map.set(`${entry.providerId}/${entry.modelId}`, entry);
    }
    return map;
  }, [catalogEntries]);

  const providerGroups = useMemo(() => {
    const groups = new Map<string, { label: string; models: { value: string; label: string }[] }>();
    for (const entry of catalogEntries) {
      const value = `${entry.providerId}/${entry.modelId}`;
      const group = groups.get(entry.providerId) ?? { label: entry.providerName, models: [] };
      group.models.push({ value, label: entry.modelName });
      groups.set(entry.providerId, group);
    }
    return [...groups.values()];
  }, [catalogEntries]);

  const handleRoleChange = useCallback(
    (role: string, catalogValue: string) => {
      setRoles((current) =>
        current.map((item) =>
          item.role === role
            ? { ...item, value: selectOmpRoleModelValue(item.value, catalogValue, catalogEntries) }
            : item,
        ),
      );
    },
    [catalogEntries],
  );

  const handleLevelChange = useCallback(
    (role: string, level: string) => {
      setRoles((current) =>
        current.map((item) =>
          item.role === role
            ? { ...item, value: selectOmpRoleLevelValue(item.value, level, catalogEntries) }
            : item,
        ),
      );
    },
    [catalogEntries],
  );

  const handleSave = useCallback(async () => {
    if (!platform.writeOmpModelRoles) {
      setSaveError("platform-unsupported");
      return;
    }
    // 空字符串是明确的 unset 更新；仅用原值比较，不能把清除操作过滤掉。
    const changedRoles = roles.filter(
      (item) => item.value !== (originalRoles.get(item.role) ?? ""),
    );
    if (changedRoles.length === 0) return;
    setSaving(true);
    setSaveError(null);
    try {
      const result = await platform.writeOmpModelRoles(changedRoles);
      if (result.success) {
        setSavedAt(Date.now());
        setSavedWithBackup(Boolean(result.backupPath));
        setOriginalRoles(
          new Map(roles.filter((item) => item.value).map((item) => [item.role, item.value])),
        );
        logger.info("[omp-model-roles] 已写入 omp modelRoles", {
          backupPath: result.backupPath ?? null,
          roles: changedRoles.length,
        });
      } else {
        setSaveError(result.error ?? "unknown");
      }
    } catch (error) {
      setSaveError(error instanceof Error ? error.message : String(error));
    } finally {
      setSaving(false);
    }
  }, [originalRoles, platform, roles]);

  const dirty = roles.some((item) => item.value !== (originalRoles.get(item.role) ?? ""));

  return (
    <>
      {loadError ? (
        <div className="rounded-lg border border-border bg-surface px-3 py-2 text-ui-base text-foreground-subtle">
          {loadError === "omp_config_missing"
            ? intl.formatMessage({ id: "settings.ompModelRoles.configMissing" })
            : loadError === "omp_config_parse_failed" || loadError === "omp_model_roles_invalid"
              ? intl.formatMessage({ id: "settings.ompModelRoles.configInvalid" })
              : loadError === "platform-unsupported"
                ? intl.formatMessage({ id: "settings.ompModelRoles.platformUnsupported" })
                : intl.formatMessage({ id: "settings.ompModelRoles.loadFailed" })}
        </div>
      ) : (
        <div className="flex max-h-[50vh] flex-col gap-3 overflow-y-auto py-1">
          {catalogEntries.length === 0 ? (
            <div className="rounded-lg border border-border bg-surface px-3 py-2 text-ui-base text-foreground-subtle">
              {intl.formatMessage({ id: "settings.ompModelRoles.catalogEmpty" })}
            </div>
          ) : null}
          {roles.map((item) => {
            const parsed = parseOmpRoleValue(item.value, catalogEntries);
            const entry = catalogByModelPart.get(parsed.modelPart);
            const known = Boolean(entry);
            return (
              <div key={item.role} className="flex items-center gap-3">
                <span className="w-24 shrink-0 text-ui-base font-medium text-foreground">
                  {item.role}
                </span>
                <Select
                  value={item.value ? (known ? parsed.modelPart : item.value) : UNCONFIGURED_VALUE}
                  onValueChange={(value) =>
                    handleRoleChange(item.role, value === UNCONFIGURED_VALUE ? "" : value)
                  }
                  disabled={saving}
                >
                  <SelectTrigger aria-label={item.role} size="lg" className="min-w-0 flex-1">
                    <SelectValue />
                  </SelectTrigger>
                  <SelectContent position="popper" align="start">
                    <SelectItem value={UNCONFIGURED_VALUE}>
                      {intl.formatMessage({ id: "settings.ompModelRoles.unset" })}
                    </SelectItem>
                    <SelectItem value="auto">
                      {intl.formatMessage({ id: "ompModelRoles.autoOption" })}
                    </SelectItem>
                    {/* 目录外配置有独立选项，不能冒充 unset 或丢失其原值。 */}
                    {!known && item.value && item.value !== "auto" ? (
                      <SelectItem value={item.value}>{item.value}</SelectItem>
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
                    onValueChange={(value) =>
                      handleLevelChange(item.role, value === DEFAULT_LEVEL_VALUE ? "" : value)
                    }
                    disabled={saving}
                  >
                    <SelectTrigger
                      aria-label={`${item.role} ${intl.formatMessage({ id: "settings.ompModelRoles.thinkingLevel" })}`}
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
            );
          })}
        </div>
      )}
      <div className="flex items-center justify-end gap-2">
        {saveError ? (
          <span className="mr-auto text-ui-base text-foreground-subtle">{saveError}</span>
        ) : savedAt ? (
          <span className="mr-auto text-ui-base text-foreground-subtle">
            {intl.formatMessage({
              id: savedWithBackup
                ? "settings.ompModelRoles.saved"
                : "settings.ompModelRoles.created",
            })}
          </span>
        ) : null}
        {!inline ? (
          <Button variant="ghost" onClick={() => onOpenChange?.(false)}>
            {intl.formatMessage({ id: "common.close" })}
          </Button>
        ) : null}
        <Button disabled={saving || loadError !== null || !dirty} onClick={() => void handleSave()}>
          {saving
            ? intl.formatMessage({ id: "settings.ompModelRoles.saving" })
            : intl.formatMessage({ id: "settings.ompModelRoles.save" })}
        </Button>
      </div>
    </>
  );
}

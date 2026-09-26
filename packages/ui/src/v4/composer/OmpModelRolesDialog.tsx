// omp 换核（FORK.md）：模型管理事实源在 omp 侧。本对话框读写用户 omp 配置的
// modelRoles（role → provider/model:level）：角色清单来自 omp 配置，模型候选来自
// workspace-config 下发的 omp 目录；写入经主进程 yaml Document 级替换（保留注释，
// 写前自动备份），绝不整文件重写。

import { useCallback, useEffect, useMemo, useState } from "react";
import { usePlatform } from "@/hooks/usePlatform.js";
import { useZCodeIntl } from "@/i18n/IntlProvider.js";
import { Button } from "@/components/ui/button.js";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog.js";
import { logger } from "@/logger.js";
import type { OmpModelCatalogEntry } from "./ompModelCatalog.js";
import {
  parseOmpRoleValue,
  selectOmpRoleLevelValue,
  selectOmpRoleModelValue,
} from "./ompModelRoleValue.js";

// 当前内嵌 omp 的内建 role；用户配置的自定义 role 会在其后追加。
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

export interface OmpModelRolesDialogProps {
  open?: boolean;
  onOpenChange?: (open: boolean) => void;
  /** 设置页直接展示同一角色编辑器；会话工具栏继续使用对话框。 */
  inline?: boolean;
  /** omp 模型目录（workspace-config 投影）；用于角色候选与归属校验。 */
  catalogEntries: readonly OmpModelCatalogEntry[];
  workspacePath: string;
  workspaceIdentity?: string;
}

export function OmpModelRolesDialog(props: OmpModelRolesDialogProps) {
  const {
    open = false,
    onOpenChange,
    inline = false,
    catalogEntries,
    workspacePath: _workspacePath,
    workspaceIdentity: _workspaceIdentity,
  } = props;
  void _workspacePath;
  void _workspaceIdentity;
  const { intl } = useZCodeIntl();
  const platform = usePlatform();
  const [roles, setRoles] = useState<{ role: string; value: string }[]>([]);
  const [originalRoles, setOriginalRoles] = useState<ReadonlyMap<string, string>>(new Map());
  const [loadError, setLoadError] = useState<string | null>(null);
  const [saving, setSaving] = useState(false);
  const [saveError, setSaveError] = useState<string | null>(null);
  const [savedAt, setSavedAt] = useState<number | null>(null);

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
    if (open || inline) {
      void loadRoles();
    }
  }, [inline, loadRoles, open]);

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
      const group = groups.get(entry.providerId) ?? {
        label: entry.providerName,
        models: [],
      };
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
    const changedRoles = roles.filter(
      (item) => item.value && item.value !== originalRoles.get(item.role),
    );
    if (changedRoles.length === 0) return;
    setSaving(true);
    setSaveError(null);
    try {
      const result = await platform.writeOmpModelRoles(changedRoles);
      if (result.success) {
        setSavedAt(Date.now());
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

  const dirty = roles.some((item) => item.value && item.value !== originalRoles.get(item.role));

  if (!open && !inline) return null;

  const fields = (
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
                <select
                  aria-label={item.role}
                  className="h-8 min-w-0 flex-1 rounded-md border border-border bg-surface px-2 text-ui-base text-foreground"
                  value={known ? parsed.modelPart : ""}
                  onChange={(event) => handleRoleChange(item.role, event.target.value)}
                >
                  {!known ? (
                    <option value="">
                      {item.value || intl.formatMessage({ id: "settings.ompModelRoles.unset" })}
                    </option>
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
                    aria-label={`${item.role} ${intl.formatMessage({ id: "settings.ompModelRoles.thinkingLevel" })}`}
                    className="h-8 w-28 shrink-0 rounded-md border border-border bg-surface px-2 text-ui-base text-foreground"
                    value={parsed.levelSuffix ?? ""}
                    onChange={(event) => handleLevelChange(item.role, event.target.value)}
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
            );
          })}
        </div>
      )}
      <div className="flex items-center justify-end gap-2">
        {saveError ? (
          <span className="mr-auto text-ui-base text-foreground-subtle">{saveError}</span>
        ) : savedAt ? (
          <span className="mr-auto text-ui-base text-foreground-subtle">
            {intl.formatMessage({ id: "settings.ompModelRoles.saved" })}
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

  if (inline) {
    return (
      <section data-testid="omp-model-roles-section" className="flex max-w-3xl flex-col gap-4">
        <div>
          <h2 className="text-ui-lg font-semibold text-foreground">
            {intl.formatMessage({ id: "settings.ompModelRoles.title" })}
          </h2>
          <p className="mt-1 text-ui-base text-foreground-subtle">
            {intl.formatMessage({ id: "settings.ompModelRoles.description" })}
          </p>
        </div>
        {fields}
      </section>
    );
  }

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="max-w-xl">
        <DialogHeader>
          <DialogTitle>{intl.formatMessage({ id: "settings.ompModelRoles.title" })}</DialogTitle>
          <DialogDescription>
            {intl.formatMessage({ id: "settings.ompModelRoles.description" })}
          </DialogDescription>
        </DialogHeader>
        {fields}
      </DialogContent>
    </Dialog>
  );
}

// omp 换核（FORK.md / omp-project-mode.md）：模型管理事实源在 omp 侧。角色目录与保存
// 优先走 OMP 项目模式 RPC（get_model_roles / set_model_role）：全部可配置 role 始终可见
// （含未配置项），选定即自动保存（含保存中/失败/被覆盖状态）；OMP 未提供项目模式时
// 回落主进程读写用户 omp 配置 modelRoles（OmpModelRolesFallbackFields）。

import { useCallback, useEffect, useMemo, useState } from "react";
import type { ZCodeOmpModelRole } from "@zcode/shared";
import { useWorkspaceServicesResolution } from "@/hooks/useWorkspaceServices.js";
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
import { parseOmpRoleValue } from "./ompModelRoleValue.js";
import { OmpModelRolesFallbackFields } from "./OmpModelRolesFallbackFields.js";

type RolesSource = "loading" | "rpc" | "fallback";

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

interface RpcRowState {
  saving: boolean;
  savedAt: number | null;
  error: string | null;
}

export function OmpModelRolesDialog(props: OmpModelRolesDialogProps) {
  const {
    open = false,
    onOpenChange,
    inline = false,
    catalogEntries,
    workspacePath,
    workspaceIdentity,
  } = props;
  const { intl } = useZCodeIntl();
  const resolution = useWorkspaceServicesResolution(workspacePath, undefined, workspaceIdentity);
  const services = resolution.services;

  const [source, setSource] = useState<RolesSource>("loading");
  const [rpcRoles, setRpcRoles] = useState<ZCodeOmpModelRole[]>([]);
  const [rpcRowState, setRpcRowState] = useState<Record<string, RpcRowState>>({});
  // 本地待保存选择（保存失败时保留，供重试；Z12）。
  const [rpcPending, setRpcPending] = useState<Record<string, string>>({});

  const loadRpcRoles = useCallback(async () => {
    if (!resolution.rpcReady) return false;
    try {
      const result = await services.zcodeAgentService.getOmpModelRoles({
        workspacePath,
        ...(workspaceIdentity ? { workspaceIdentity } : {}),
      });
      setRpcRoles(result.roles);
      setSource("rpc");
      return true;
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      logger.debug("[omp-model-roles] RPC 目录不可用，回落本地配置", { error: message });
      return false;
    }
  }, [resolution.rpcReady, services, workspaceIdentity, workspacePath]);

  useEffect(() => {
    if (!open && !inline) return;
    setSource("loading");
    void loadRpcRoles().then((ok) => {
      if (!ok) setSource("fallback");
    });
  }, [inline, loadRpcRoles, open]);

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

  /** RPC 模式：选定模型/档位即自动保存（逐 role 修订；失败保留待保存选择）。 */
  const saveRpcRole = useCallback(
    async (roleId: string, catalogValue: string, clear: boolean, level?: string) => {
      const selection =
        clear || !catalogValue || catalogValue === "auto"
          ? catalogValue === "auto"
            ? ({ kind: "auto" } as const)
            : null
          : (() => {
              const slash = catalogValue.indexOf("/");
              const provider = catalogValue.slice(0, slash);
              const modelId = catalogValue.slice(slash + 1);
              if (!provider || !modelId) return null;
              // 档位由调用方显式传入（空串/undefined = 不带 thinkingLevel，即清除档位后缀）。
              return {
                kind: "model" as const,
                model: { provider, modelId, ...(level ? { thinkingLevel: level } : {}) },
              };
            })();
      setRpcRowState((current) => ({
        ...current,
        [roleId]: { saving: true, savedAt: null, error: null },
      }));
      try {
        const result = await services.zcodeAgentService.setOmpModelRole({
          workspacePath,
          ...(workspaceIdentity ? { workspaceIdentity } : {}),
          roleId,
          scope: "user",
          selection,
        });
        setRpcRoles((current) =>
          current.map((role) => (role.roleId === roleId ? result.role : role)),
        );
        setRpcPending((current) => {
          const next = { ...current };
          delete next[roleId];
          return next;
        });
        setRpcRowState((current) => ({
          ...current,
          [roleId]: { saving: false, savedAt: Date.now(), error: null },
        }));
      } catch (error) {
        const message = error instanceof Error ? error.message : String(error);
        // 失败回显完整尝试值（模型 + 档位）：parseOmpRoleValue 按目录把冒号后缀解析为
        // 档位，重试语义完整；模型 ID 含冒号时由目录校验兜底，不会误拆。
        setRpcPending((current) => ({
          ...current,
          [roleId]: level ? `${catalogValue}:${level}` : catalogValue,
        }));
        setRpcRowState((current) => ({
          ...current,
          [roleId]: { saving: false, savedAt: null, error: message },
        }));
      }
    },
    [services, workspaceIdentity, workspacePath],
  );

  // 档位与模型一致「选定即保存」（旧 #level pending 既导致回弹也无保存路径）；
  // modelPart 取当前展示值解析出的模型段，空档位 = 清除后缀（不带 thinkingLevel）。
  const handleRpcLevelChange = useCallback(
    (roleId: string, modelPart: string, level: string) => {
      void saveRpcRole(roleId, modelPart, false, level);
    },
    [saveRpcRole],
  );

  if (!open && !inline) return null;

  const fields =
    source === "rpc" ? (
      <>
        <p className="text-ui-base text-foreground-subtle">
          {intl.formatMessage({ id: "ompModelRoles.fromAgent" })}
        </p>
        <div className="flex max-h-[50vh] flex-col gap-3 overflow-y-auto py-1">
          {rpcRoles.map((role) => {
            const row = rpcRowState[role.roleId];
            const effective = role.effectiveModel
              ? `${role.effectiveModel.provider ?? ""}/${role.effectiveModel.modelId ?? ""}`
              : "";
            const pending = rpcPending[role.roleId];
            // OMP 把 {kind:"auto"} 持久为 explicitValue "*"（DEFAULT_MODEL_ROLE_ALIAS）；
            // 读侧归一为 "auto" 才能命中已有 auto 选项，否则已存 auto 显示成未配置态。
            const explicitValue = role.explicitValue === "*" ? "auto" : role.explicitValue;
            const displayValue = pending ?? explicitValue ?? "";
            const parsed = parseOmpRoleValue(displayValue, catalogEntries);
            const entry = catalogByModelPart.get(parsed.modelPart);
            const overridden =
              role.explicitValue !== undefined &&
              role.source !== undefined &&
              role.source !== "global" &&
              role.source !== "default" &&
              role.source !== "runtime";
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
                      // 档位跟随（models-and-commands.md）：新模型支持原等级则保留；
                      // 不支持时用其缺省档位（defaultThoughtLevel，来自
                      // modelDefaultThoughtLevel）；无缺省则不写档位后缀。
                      const nextEntry = catalogByModelPart.get(nextValue);
                      let nextLevel: string | undefined;
                      if (nextEntry) {
                        nextLevel =
                          parsed.levelSuffix &&
                          nextEntry.thoughtLevels?.includes(parsed.levelSuffix)
                            ? parsed.levelSuffix
                            : nextEntry.defaultThoughtLevel;
                      }
                      void saveRpcRole(role.roleId, nextValue, nextValue === "", nextLevel);
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
                    {/* 目录外 explicitValue 兜底（仿回落分支 !known）：额外 option 保证
                        已配置值可见且显示与磁盘一致，而不是显示成未配置态。 */}
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
                      onChange={(event) =>
                        handleRpcLevelChange(role.roleId, parsed.modelPart, event.target.value)
                      }
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
                    <span className="text-[var(--color-danger)]">
                      {intl.formatMessage({ id: "ompModelRoles.saveFailed" })}: {row.error}
                    </span>
                  ) : row?.savedAt ? (
                    <span>
                      {intl.formatMessage({ id: "ompModelRoles.saved" })}
                      {overridden
                        ? ` · ${intl.formatMessage({ id: "ompModelRoles.overridden" })}`
                        : ""}
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
    ) : source === "fallback" ? (
      <OmpModelRolesFallbackFields
        catalogEntries={catalogEntries}
        inline={inline}
        onOpenChange={onOpenChange}
      />
    ) : null;

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

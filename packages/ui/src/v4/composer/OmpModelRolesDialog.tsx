// omp 换核（FORK.md / omp-project-mode.md）：模型管理事实源在 omp 侧。角色目录与保存
// 优先走 OMP 项目模式 RPC（get_model_roles / set_model_role）：全部可配置 role 始终可见
// （含未配置项），选定即自动保存（含保存中/失败/被覆盖状态）。回落主进程读写用户 omp
// 配置 modelRoles（OmpModelRolesFallbackFields）的唯一触发条件是旧核永久缺失项目模式
//（-32601，omp-project-mode.md 三态语义）；rpc 未就绪与 -32000 暂时不可用停留错误态
// 提供重试，不绕过 omp 直写用户配置（协议 §8.3）。判定逻辑见 ompModelRolesFallback.ts。

import { useCallback, useEffect, useRef, useState } from "react";
import type { ZCodeOmpModelRole } from "@zcode/shared";
import type { IServiceAccessor } from "@zcode/services";
import { useWorkspaceServicesResolution } from "@/hooks/useWorkspaceServices.js";
import { useSettings } from "@/hooks/useSettingService.js";
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
  classifyOmpRoleSaveFailure,
  ompRoleEffectiveNote,
  resolveOmpRolesLoadOutcome,
  type OmpRolesLoadOutcome,
} from "./ompModelRolesFallback.js";
import { OmpModelRolesRpcFields, type RpcRowState } from "./OmpModelRolesRpcFields.js";
import { OmpModelRolesFallbackFields } from "./OmpModelRolesFallbackFields.js";

type RolesSource = "loading" | "rpc" | "fallback";

interface OmpRoleEditorResolution {
  services: IServiceAccessor;
  rpcReady: boolean;
  isRemoteTarget: boolean;
}

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
  const resolution = useWorkspaceServicesResolution(
    props.workspacePath,
    undefined,
    props.workspaceIdentity,
  );
  const platform = usePlatform();
  const { settings } = useSettings();
  const [activeProfile, setActiveProfile] = useState<string | null>(null);
  useEffect(() => {
    if ((!props.open && !props.inline) || !platform.listOmpProfiles || resolution.isRemoteTarget) return;
    let cancelled = false;
    void platform
      .listOmpProfiles()
      .then((result) => {
        if (!cancelled && result.success) setActiveProfile(result.activeProfile);
      })
      .catch(() => {
        // 无法确定当前运行 profile 时保持禁写，不能猜测目标并写入旧配置。
      });
    return () => {
      cancelled = true;
    };
  }, [platform, props.open, props.inline, resolution.isRemoteTarget]);
  const writeBlocked =
    !resolution.isRemoteTarget &&
    Boolean(platform.listOmpProfiles) &&
    (activeProfile === null || (settings?.ompProfile ?? activeProfile) !== activeProfile);
  // 每个工作区/连接/打开周期独占临时选择，旧 Promise 只能回到已卸载的编辑器。
  return (
    <OmpModelRolesEditor
      key={JSON.stringify([
        props.workspaceIdentity?.trim() || props.workspacePath,
        resolution.remoteSessionId,
        props.inline || props.open,
        writeBlocked,
      ])}
      {...props}
      resolution={resolution}
      writeBlocked={writeBlocked}
      profileUnavailable={activeProfile === null}
    />
  );
}

function OmpModelRolesEditor(props: OmpModelRolesDialogProps & {
  resolution: OmpRoleEditorResolution;
  writeBlocked: boolean;
  profileUnavailable: boolean;
}) {
  const {
    open = false,
    onOpenChange,
    inline = false,
    catalogEntries,
    workspacePath,
    workspaceIdentity,
  } = props;
  const { intl } = useZCodeIntl();
  const { resolution, writeBlocked } = props;
  const services = resolution.services;

  const [source, setSource] = useState<RolesSource>("loading");
  const [rpcRoles, setRpcRoles] = useState<ZCodeOmpModelRole[]>([]);
  const [rpcRowState, setRpcRowState] = useState<Record<string, RpcRowState>>({});
  // 本地待保存选择（保存失败时保留，供重试；Z12）。
  const [rpcPending, setRpcPending] = useState<Record<string, string>>({});
  // 目录加载失败信息（null=无失败）；值为展示用的原始错误细节，空串=无细节（rpc 未就绪）。
  const [loadFailure, setLoadFailure] = useState<string | null>(null);
  const generation = useRef(0);
  const loadSequence = useRef(0);
  const savingRoles = useRef(new Set<string>());
  useEffect(() => {
    setRpcPending({});
    setRpcRowState({});
    return () => {
      generation.current++;
      loadSequence.current++;
      savingRoles.current.clear();
    };
  }, [services]);

  const loadRpcRoles = useCallback(async (): Promise<OmpRolesLoadOutcome> => {
    const requestGeneration = generation.current;
    const requestSequence = ++loadSequence.current;
    // 回落分流（S8-1，协议 §8.3）：rpc 未就绪（agent 启动中/远端等待）与 -32000
    //（项目进程暂时不可用，可重试）一律不回落直写用户 omp config.yml；只有旧核
    // 永久缺失项目模式（-32601，"not supported by omp core"，与
    // useOmpCommandCompletion 同判据）才回落主进程读写本地配置。
    if (!resolution.rpcReady) {
      setLoadFailure("");
      return resolveOmpRolesLoadOutcome({ rpcReady: false, error: undefined });
    }
    try {
      const result = await services.zcodeAgentService.getOmpModelRoles({
        workspacePath,
        ...(workspaceIdentity ? { workspaceIdentity } : {}),
      });
      if (requestGeneration !== generation.current || requestSequence !== loadSequence.current) {
        return "unavailable";
      }
      setRpcRoles(result.roles);
      setSource("rpc");
      setLoadFailure(null);
      return "loaded";
    } catch (error) {
      if (requestGeneration !== generation.current || requestSequence !== loadSequence.current) {
        return "unavailable";
      }
      const message = error instanceof Error ? error.message : String(error);
      // 远端缺能力也不得降级写本机 profile，回落只属于本地目标。
      const outcome = resolution.isRemoteTarget
        ? "unavailable"
        : resolveOmpRolesLoadOutcome({ rpcReady: true, error });
      logger.debug("[omp-model-roles] RPC 角色目录不可用", { error: message, outcome });
      if (outcome === "unavailable") setLoadFailure(message);
      return outcome;
    }
  }, [resolution.rpcReady, resolution.isRemoteTarget, services, workspaceIdentity, workspacePath]);

  // 统一的加载入口：Effect 与手动重试共用；仅 -32601 判定回落，其余停留错误态。
  const runRpcLoad = useCallback(() => {
    setSource("loading");
    setLoadFailure(null);
    const requestGeneration = generation.current;
    const requestSequence = loadSequence.current + 1;
    void loadRpcRoles().then((outcome) => {
      if (requestGeneration !== generation.current || requestSequence !== loadSequence.current) return;
      if (outcome === "fallback") setSource("fallback");
    });
  }, [loadRpcRoles]);

  useEffect(() => {
    if (writeBlocked || (!open && !inline)) return;
    runRpcLoad();
  }, [inline, runRpcLoad, open, writeBlocked]);

  /** RPC 模式：选定模型/档位即自动保存（逐 role 修订；失败保留待保存选择）。 */
  const saveRpcRole = useCallback(
    async (roleId: string, catalogValue: string, clear: boolean, level?: string) => {
      if (writeBlocked || savingRoles.current.has(roleId)) return;
      savingRoles.current.add(roleId);
      const requestGeneration = generation.current;
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
      // 保存期间也展示本次选择，不能等失败才回显或让控件跳回旧值。
      setRpcPending((current) => ({
        ...current,
        [roleId]: level ? `${catalogValue}:${level}` : catalogValue,
      }));
      setRpcRowState((current) => ({
        ...current,
        [roleId]: { saving: true, savedAt: null, error: null, effectiveNote: null },
      }));
      try {
        const result = await services.zcodeAgentService.setOmpModelRole({
          workspacePath,
          ...(workspaceIdentity ? { workspaceIdentity } : {}),
          roleId,
          scope: "user",
          selection,
        });
        if (requestGeneration !== generation.current) return;
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
          [roleId]: {
            saving: false,
            savedAt: Date.now(),
            error: null,
            // §8.3：透传 omp 返回的实际生效说明（如被 runtime/项目层覆盖的精确来源）。
            effectiveNote: ompRoleEffectiveNote(result),
          },
        }));
      } catch (error) {
        if (requestGeneration !== generation.current) return;
        const message = error instanceof Error ? error.message : String(error);
        // 保存失败同样按三态分流（S8-1）：只有旧核永久缺失（-32601）才允许转本地
        // 回落保存（切换到回落编辑器直写用户 config.yml）；-32000 等暂时不可用保留
        // 待保存选择显示失败供重试，绝不静默降级直写用户配置。
        if (!resolution.isRemoteTarget && classifyOmpRoleSaveFailure(error) === "capabilityMissing") {
          logger.info("[omp-model-roles] 保存遇旧核能力缺失，转本地回落编辑", {
            roleId,
            error: message,
          });
          setRpcPending((current) => {
            const next = { ...current };
            delete next[roleId];
            return next;
          });
          setSource("fallback");
          return;
        }
        // 失败回显完整尝试值（模型 + 档位）：parseOmpRoleValue 按目录把冒号后缀解析为
        // 档位，重试语义完整；模型 ID 含冒号时由目录校验兜底，不会误拆。
        setRpcPending((current) => ({
          ...current,
          [roleId]: level ? `${catalogValue}:${level}` : catalogValue,
        }));
        setRpcRowState((current) => ({
          ...current,
          [roleId]: { saving: false, savedAt: null, error: message, effectiveNote: null },
        }));
      } finally {
        if (requestGeneration === generation.current) savingRoles.current.delete(roleId);
      }
    },
    [services, workspaceIdentity, workspacePath, resolution.isRemoteTarget, writeBlocked],
  );


  if (!open && !inline) return null;

  const fields =
    writeBlocked ? (
      <p className="text-ui-base text-foreground-subtle">
        {intl.formatMessage({
          id: props.profileUnavailable
            ? "settings.ompModelRoles.loadFailed"
            : "settings.ompProfile.restartRequired",
        })}
      </p>
    ) : source === "rpc" ? (
      <OmpModelRolesRpcFields
        roles={rpcRoles}
        pending={rpcPending}
        rowState={rpcRowState}
        catalogEntries={catalogEntries}
        onSave={saveRpcRole}
        inline={inline}
        onOpenChange={onOpenChange}
      />
    ) : loadFailure !== null ? (
      // 目录加载失败（rpc 未就绪 / -32000 暂时不可用 / 其他错误）：停留错误态并提供
      // 重试入口，不回落直写用户配置（S8-1）；错误框样式对齐 SkillsSection 失败态。
      <>
        <div className="rounded-lg border border-destructive/30 bg-destructive/10 px-3 py-2 text-ui-base text-destructive">
          {intl.formatMessage({ id: "ompModelRoles.loadUnavailable" })}
          {loadFailure ? `: ${loadFailure}` : ""}
        </div>
        <div className="flex items-center justify-end gap-2">
          {!inline ? (
            <Button variant="ghost" onClick={() => onOpenChange?.(false)}>
              {intl.formatMessage({ id: "common.close" })}
            </Button>
          ) : null}
          <Button onClick={runRpcLoad}>{intl.formatMessage({ id: "common.retry" })}</Button>
        </div>
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

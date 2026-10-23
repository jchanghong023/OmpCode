/* eslint-disable max-lines -- Composer 草稿 owner 同时收口选择、正文与提交生命周期，保持单一状态边界。 */
// 当前编辑由 Composer 持有；进入已有 Session 从当前快照恢复权限/Plan，在线只响应新变化。
// 菜单点击立即保存 Renderer 意图，Prewarm 与 Submission 只消费它，不反向覆盖。
//
// Workspace config 是 OMP 模型目录与默认 role 的唯一投影；Composer 只保存临时选择。
import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { resolveExecutionState, type ModelSelection, type ZCodeProvider } from "@zcode/shared";
import type { SessionConfigState } from "@zcode/shared/zcode-protocol-v4";
import type { IModelSelectionService } from "@zcode/services";
import {
  useModelSelectionServiceView,
  type ModelSelectionRead,
} from "@/hooks/useModelSelectionView.js";
import { submissionModeSchema } from "@zcode/shared/zcode-protocol-v4";
import { useSettings } from "@/hooks/useSettingService.js";
import { parseModelPickerValue } from "@/lib/zcodeSessionProjection.js";
import { readComposerRecent } from "@/lib/composerRecent.js";
import { useComposerClientNamespace } from "@/hooks/useServices.js";
import {
  resolveComposerScope,
  composerScopeKey,
  readComposerWorkspaceScope,
} from "@/v4/composer/composerDraftStore.js";
import {
  clearV4ComposerDraft,
  persistV4ComposerDraft,
  readV4ComposerDraft,
  V4_DRAFT_SCOPE_ROOT,
  type V4ComposerDraft,
} from "@/v4/composer/composerDraftStore.js";
import { resolveAppFollowupMode } from "@/v4/composer/followupModeSettings.js";
import { logger } from "@/logger.js";
import { useZCodeSessionStore } from "@/store/zcodeSessionStore.js";
import {
  useOmpModelCatalog,
  findOmpCatalogEntry,
  selectionForOmpEntry,
} from "@/omp-configuration/module.js";

export function applyDraftModelSelection(
  current: Partial<SessionConfigState>,
  model: ModelSelection,
): Partial<SessionConfigState> {
  const next = {
    ...current,
    modelSelection: {
      providerId: model.providerId,
      modelId: model.modelId,
      ...(model.options ? { options: { ...model.options } } : {}),
    },
    provider: model.providerId,
    model: model.modelId,
  };
  // thought 是模型的附属配置。切模型后保留源 thought 会让首发前配置屏障
  // 在目标模型已切成功后把它当成“同模型显式切 thought”再次写入，必须先清除。
  delete next.thought;
  return next;
}

export interface DraftConfigControl {
  modelSelectionRead: ModelSelectionRead;
  /** Renderer 下一次提交的配置；恢复采用当前权限，在线授权只同步对应字段。 */
  draftConfig: Partial<SessionConfigState>;
  /** 草稿已选 config（partial）；createSession 时经 buildDraftCreateConfigPayload 携带。 */
  draftConfigRef: React.RefObject<Partial<SessionConfigState>>;
  /** 当前草稿生命周期冻结的初始化 config；只供 prewarm/createSession 建立时使用。 */
  resolveInitialDraftConfig: () => Partial<SessionConfigState> | undefined;
  composerDraft: V4ComposerDraft;
  updateComposerContent: (
    content: Pick<V4ComposerDraft, "text" | "editorStateJson" | "mention">,
  ) => void;
  replaceComposerDraft: (draft: Omit<V4ComposerDraft, "updatedAt">) => void;
  /** 新任务被接纳后，把当前完整 Root Draft 原子式转移到真实 Session scope。 */
  promoteComposerDraft: (createdSessionId: string) => void;
  /** 在提交前捕获原意图；只在权威 accepted 后调用返回函数。 */
  captureAcceptedModelSelection: (
    selection: ModelSelection,
    expectedSelection?: ModelSelection,
  ) => () => void;
  handleDraftSelectModel: (modelProvider: string, model: string, reasoningLevel?: string) => void;
  handleDraftSelectThought: (thought: string) => void;
  handleDraftSwitchMode: (mode: string) => void;
}

interface ComposerState {
  scopeKey: string;
  storageScope: string | null;
  workspaceKey: string;
  draft: V4ComposerDraft;
  initialization: "new-task" | "session" | "promotion";
  observedConfig?: { permissionGrantId?: string; planTransitionId?: string };
  promotedSessionId?: string;
  /** 自动默认值只跟随原生 role 热更新；主动选模后即退出此所有权。 */
  nativeDefaultSelection?: ModelSelection;
}

export function useDraftConfigControl(params: {
  workspacePath: string;
  workspaceIdentity?: string;
  remoteSessionId?: string | null;
  storageScope: string | null;
  provider?: ZCodeProvider;
  /** 会话切换恢复文字/模型，权限和 Plan 使用当前快照。 */
  sessionId: string | null;
  /** 仅匹配当前 Session 的首份投影可用作初始化；null 表示还没恢复完成。 */
  sessionConfig?: Partial<SessionConfigState> | null;
  /** 仅连接可用性门控，不以 Host provider 配置门控原生启动。 */
  agentStartupAllowed?: boolean;
  modelSelectionService: IModelSelectionService | null;
}): DraftConfigControl {
  const {
    workspacePath,
    workspaceIdentity,
    remoteSessionId,
    storageScope,
    sessionId,
    sessionConfig,
    agentStartupAllowed = true,
  } = params;
  const workspaceKey = workspaceIdentity?.trim() || workspacePath;
  const { settings: sharedSettings } = useSettings();
  const appFollowupMode = resolveAppFollowupMode(sharedSettings);
  const scopeId = sessionId ?? V4_DRAFT_SCOPE_ROOT;
  const clientNamespace = useComposerClientNamespace();
  const draftProjectId = useZCodeSessionStore((state) =>
    state.workspaces[workspaceKey]?.draftStorageScope === storageScope && storageScope
      ? state.workspaces[workspaceKey]?.draftProjectId
      : undefined,
  );
  const rootScope = useMemo(
    () =>
      resolveComposerScope(
        draftProjectId !== undefined
          ? draftProjectId
          : readComposerWorkspaceScope(
              workspacePath,
              workspaceIdentity,
              clientNamespace,
              storageScope,
            )?.projectId,
        workspaceIdentity,
        clientNamespace,
        storageScope,
        remoteSessionId,
      ),
    [
      draftProjectId,
      workspacePath,
      workspaceIdentity,
      clientNamespace,
      storageScope,
      remoteSessionId,
    ],
  );
  const draftFocusVersion = useZCodeSessionStore((state) =>
    sessionId === null ? (state.workspaces[workspaceKey]?.draftFocusVersion ?? 0) : 0,
  );
  // New Task 可以复用同一个 pane；无文字时必须重新取 Recent，不能只清磁盘留旧内存。
  const scopeKey = JSON.stringify([
    workspaceKey,
    scopeId,
    draftFocusVersion,
    composerScopeKey(rootScope),
  ]);
  const navigationInitialization = useZCodeSessionStore((state) => {
    const workspace = state.workspaces[workspaceKey];
    return workspace?.activeTaskId === sessionId &&
      workspace?.draftStorageScope === storageScope &&
      Boolean(storageScope) &&
      workspace?.composerInitialization?.taskId === sessionId
      ? workspace.composerInitialization
      : undefined;
  });
  const loadedScope = useMemo<ComposerState>(() => {
    const saved = readV4ComposerDraft(workspacePath, workspaceIdentity, scopeId, rootScope);
    return {
      scopeKey,
      workspaceKey,
      storageScope,
      draft: saved ?? { text: "", updatedAt: 0, ...navigationInitialization?.config },
      initialization:
        sessionId === null || (!saved && navigationInitialization) ? "new-task" : "session",
    };
  }, [scopeKey]);
  const [storedState, setStoredState] = useState(loadedScope);
  // 首发是同一 pane 的地址迁移，保持其间的新编辑；换页或卸载不保留第二份配置。
  let currentState: ComposerState =
    storedState.scopeKey === scopeKey
      ? storedState
      : storedState.workspaceKey === workspaceKey &&
          storedState.storageScope === storageScope &&
          storedState.promotedSessionId === sessionId
        ? {
            ...storedState,
            scopeKey,
            initialization: "promotion",
            observedConfig: undefined,
            promotedSessionId: undefined,
          }
        : loadedScope;
  let draft = currentState.draft;
  const { catalog: nativeCatalog } = useOmpModelCatalog(
    workspacePath,
    workspaceIdentity,
    remoteSessionId,
    agentStartupAllowed,
  );
  // 保留旧展示读取接口，但不再向 Host 账号目录查询 OMP 模型。
  const modelSelectionRead = useModelSelectionServiceView(null, false, "remote-waiting");
  if (currentState.initialization === "new-task" && !draft.mode && nativeCatalog) {
    const recent = readComposerRecent(workspacePath, workspaceIdentity, undefined, rootScope);
    draft = {
      ...draft,
      mode: recent?.mode === "plan" ? "build" : (recent?.mode ?? "build"),
      planEnabled: false,
    };
  }
  if (
    (sessionId === null || (currentState.initialization === "new-task" && !draft.modelSelection)) &&
    nativeCatalog &&
    (!draft.modelSelection || draft.modelSelection === currentState.nativeDefaultSelection)
  ) {
    const selection = nativeCatalog.preferredSelection ?? undefined;
    if (JSON.stringify(selection) !== JSON.stringify(draft.modelSelection)) {
      draft = { ...draft, modelSelection: selection };
    }
    currentState =
      currentState.nativeDefaultSelection === draft.modelSelection
        ? currentState
        : { ...currentState, nativeDefaultSelection: draft.modelSelection };
  }
  if (sessionId && sessionConfig) {
    const previous = currentState.observedConfig;
    const observedConfig = {
      permissionGrantId: sessionConfig.permissionGrant?.interactionId,
      planTransitionId: sessionConfig.planTransition?.toolCallId,
    };
    const firstSnapshot = !previous;
    const mode = submissionModeSchema.safeParse(sessionConfig.mode);
    const currentMode = mode.success && mode.data !== "plan" ? mode.data : "build";
    const currentPlan = resolveExecutionState(sessionConfig).planEnabled;
    if (firstSnapshot && currentState.initialization === "session") {
      // 历史授权曾被当成新指令重放，覆盖最新确认模式。恢复直接采用当前事实，文字只恢复模型。
      draft = {
        ...draft,
        mode: currentMode,
        planEnabled: currentPlan,
        modelSelection: draft.mode ? draft.modelSelection : sessionConfig.modelSelection,
      };
    } else if (previous) {
      // 只处理本次打开后出现的新关联；使用最新快照值，不能从历史事件推导固定 yolo/Plan。
      const permissionChanged =
        observedConfig.permissionGrantId &&
        observedConfig.permissionGrantId !== previous.permissionGrantId;
      const planChanged =
        observedConfig.planTransitionId &&
        observedConfig.planTransitionId !== previous.planTransitionId;
      if (permissionChanged || planChanged)
        draft = {
          ...draft,
          ...(permissionChanged ? { mode: currentMode } : {}),
          ...(planChanged ? { planEnabled: currentPlan } : {}),
        };
    }
    if (
      firstSnapshot ||
      observedConfig.permissionGrantId !== previous.permissionGrantId ||
      observedConfig.planTransitionId !== previous.planTransitionId
    ) {
      currentState = { ...currentState, observedConfig };
    }
  }
  if (draft !== currentState.draft) currentState = { ...currentState, draft };
  if (currentState !== storedState) setStoredState(currentState);
  const stateRef = useRef(currentState);
  stateRef.current = currentState;
  // 稀疏临时选择始终由 Composer/会话持有，不能被旧平铺或 Host 解析结果补满。
  const effectiveSelection = draft.modelSelection;
  const draftConfig = useMemo<Partial<SessionConfigState>>(
    () => ({
      mode:
        currentState.initialization === "session" && !currentState.observedConfig
          ? undefined
          : draft.mode,
      planEnabled: draft.planEnabled ?? false,
      modelSelection: effectiveSelection,
      provider: effectiveSelection?.providerId ?? "",
      model: effectiveSelection?.modelId ?? "",
      thought: effectiveSelection?.options?.reasoningLevel ?? "",
    }),
    [
      draft.mode,
      draft.planEnabled,
      effectiveSelection,
      currentState.initialization,
      currentState.observedConfig,
    ],
  );
  const draftConfigRef = useRef(draftConfig);
  draftConfigRef.current = draftConfig;
  const persistDraft = useCallback(
    (value: V4ComposerDraft) => {
      const workspace = useZCodeSessionStore
        .getState()
        .getWorkspaceState(workspacePath, workspaceIdentity);
      return persistV4ComposerDraft(
        workspacePath,
        workspaceIdentity,
        // 首发已绑定但 React 尚未切换地址时，新输入也属于已创建的会话。
        stateRef.current.scopeKey === scopeKey
          ? (stateRef.current.promotedSessionId ?? scopeId)
          : scopeId,
        scopeId === V4_DRAFT_SCOPE_ROOT && workspace.draftStorageScope === storageScope
          ? {
              ...value,
              projectId:
                workspace.draftProjectId !== undefined ? workspace.draftProjectId : value.projectId,
              taskGroupId:
                workspace.draftTaskGroupId !== undefined
                  ? workspace.draftTaskGroupId
                  : value.taskGroupId,
            }
          : value,
        rootScope,
      );
    },
    [workspacePath, workspaceIdentity, scopeId, rootScope, scopeKey, storageScope],
  );
  const mountedRef = useRef(false);
  useEffect(() => {
    mountedRef.current = true;
    return () => {
      mountedRef.current = false;
    };
  }, []);
  useEffect(() => {
    if (navigationInitialization)
      useZCodeSessionStore
        .getState()
        .consumeComposerInitialization(workspacePath, navigationInitialization, workspaceIdentity);
  }, [scopeKey, navigationInitialization, workspacePath, workspaceIdentity]);
  const isCurrentScope = useCallback(
    () =>
      mountedRef.current &&
      stateRef.current.scopeKey === scopeKey &&
      (sessionId !== null ||
        (useZCodeSessionStore.getState().getWorkspaceState(workspacePath, workspaceIdentity)
          .draftFocusVersion ?? 0) === draftFocusVersion),
    [scopeKey, sessionId, workspacePath, workspaceIdentity, draftFocusVersion],
  );
  const lastPersistedDraftRef = useRef<V4ComposerDraft | null>(null);
  useEffect(() => {
    if (
      draft.mode &&
      draft !== lastPersistedDraftRef.current &&
      stateRef.current.draft === draft &&
      stateRef.current.scopeKey === scopeKey
    ) {
      persistDraft(draft);
      lastPersistedDraftRef.current = draft;
    }
  }, [draft, scopeKey, persistDraft]);
  const updateComposerDraft = useCallback(
    (update: (current: V4ComposerDraft) => V4ComposerDraft) => {
      // 旧 scope 的延迟编辑器回调不能写入刚切换到的会话。
      if (!isCurrentScope()) return;
      const previous = stateRef.current.draft;
      const next = update(previous);
      const nextState = {
        ...stateRef.current,
        draft: next,
        nativeDefaultSelection:
          next.modelSelection === previous.modelSelection
            ? stateRef.current.nativeDefaultSelection
            : undefined,
      };
      stateRef.current = nextState;
      const selection =
        next.modelSelection === previous.modelSelection
          ? draftConfigRef.current.modelSelection
          : next.modelSelection;
      draftConfigRef.current = {
        mode: next.mode,
        planEnabled: next.planEnabled ?? false,
        modelSelection: selection,
        provider: selection?.providerId ?? "",
        model: selection?.modelId ?? "",
        thought: selection?.options?.reasoningLevel ?? "",
      };
      setStoredState(nextState);
      persistDraft(next);
      lastPersistedDraftRef.current = next;
    },
    [isCurrentScope, persistDraft],
  );
  const updateDraftConfig = useCallback(
    (update: (current: Partial<SessionConfigState>) => Partial<SessionConfigState>) => {
      const next = update(draftConfigRef.current);
      const mode = submissionModeSchema.safeParse(next.mode);
      updateComposerDraft((current) => ({
        ...current,
        mode: mode.success ? mode.data : current.mode,
        modelSelection: next.modelSelection,
        // 导入等待目录期间的显式选择也是有效选择，不能再被默认初始化覆盖。
        ...(current.mode ? {} : { mode: mode.success ? mode.data : "build" }),
      }));
    },
    [updateComposerDraft],
  );
  const captureAcceptedModelSelection = useCallback(
    (selection: ModelSelection, expectedSelection: ModelSelection = selection): (() => void) => {
      const original = stateRef.current.draft.modelSelection;
      const effective = draftConfigRef.current.modelSelection;
      // 对象键顺序不是选择身份；协议重建同一选择时不能因此丢掉 accepted 写回。
      if (
        effective?.providerId !== expectedSelection.providerId ||
        effective.modelId !== expectedSelection.modelId ||
        effective.options?.reasoningLevel !== expectedSelection.options?.reasoningLevel
      )
        return () => {};
      return () => {
        // 自动对应只在本次提交被接纳后固定；旧 ACK 不得覆盖期间的新意图或新 scope。
        if (
          stateRef.current.scopeKey !== scopeKey ||
          stateRef.current.draft.modelSelection !== original
        )
          return;
        updateComposerDraft((current) => ({ ...current, modelSelection: selection }));
      };
    },
    [scopeKey, updateComposerDraft],
  );
  const resolveInitialDraftConfig = useCallback((): Partial<SessionConfigState> | undefined => {
    if (!draftConfigRef.current.mode) return undefined;
    const config = { ...draftConfigRef.current };
    if (appFollowupMode) {
      config.followupMode = appFollowupMode;
    }
    return config;
  }, [appFollowupMode]);

  const updateComposerContent = useCallback(
    (content: Pick<V4ComposerDraft, "text" | "editorStateJson" | "mention">) => {
      updateComposerDraft((current) => ({
        ...current,
        editorStateJson: undefined,
        mention: undefined,
        ...content,
      }));
    },
    [updateComposerDraft],
  );
  const replaceComposerDraft = useCallback(
    (replacement: Omit<V4ComposerDraft, "updatedAt">) => {
      updateComposerDraft(() => ({ ...replacement, updatedAt: Date.now() }));
    },
    [updateComposerDraft],
  );

  const promoteComposerDraft = useCallback(
    (createdSessionId: string) => {
      if (!isCurrentScope() || scopeId !== V4_DRAFT_SCOPE_ROOT) return;
      const targetSessionId = createdSessionId.trim();
      if (!targetSessionId) return;
      // 首发 Snapshot 可能迟到：空正文只在内存交接配置，有新文字则先写目标再删来源。
      const written = persistV4ComposerDraft(
        workspacePath,
        workspaceIdentity,
        targetSessionId,
        stateRef.current.draft,
        rootScope,
      );
      if (!written) return;
      const next = { ...stateRef.current, promotedSessionId: targetSessionId };
      stateRef.current = next;
      setStoredState(next);
      clearV4ComposerDraft(workspacePath, workspaceIdentity, V4_DRAFT_SCOPE_ROOT, rootScope);
    },
    [scopeId, isCurrentScope, workspaceIdentity, workspacePath, rootScope],
  );

  const handleDraftSelectModel = useCallback(
    (modelProvider: string, model: string, reasoningLevel?: string) => {
      const modelId = modelProvider ? `${modelProvider}/${model}` : model;
      const parsedSelection = parseModelPickerValue(modelId);
      const entry = findOmpCatalogEntry(
        nativeCatalog,
        parsedSelection.providerId,
        parsedSelection.modelId,
      );
      const modelSelection =
        reasoningLevel !== undefined
          ? { ...parsedSelection, options: { reasoningLevel } }
          : entry
            ? selectionForOmpEntry(entry)
            : parsedSelection;
      logger.debug("[v4-draft-config] select model", {
        modelProvider,
        model,
        modelId,
        modelSelectionProviderId: modelSelection.providerId,
        modelSelectionModelId: modelSelection.modelId,
        workspacePath,
        workspaceIdentity: workspaceIdentity ?? null,
      });
      updateDraftConfig((current) => applyDraftModelSelection(current, modelSelection));
    },
    [nativeCatalog, updateDraftConfig, workspaceIdentity, workspacePath],
  );

  const handleDraftSelectThought = useCallback(
    (thought: string) => {
      updateDraftConfig((current) => {
        const providerId = current.modelSelection?.providerId ?? current.provider?.trim();
        const modelId = current.modelSelection?.modelId ?? current.model?.trim();
        if (!providerId || !modelId) return { ...current, thought };
        const reasoningLevel = thought.trim();
        return {
          ...current,
          modelSelection: {
            providerId,
            modelId,
            ...(reasoningLevel
              ? {
                  options: {
                    ...current.modelSelection?.options,
                    reasoningLevel,
                  },
                }
              : {}),
          },
          thought,
        };
      });
    },
    [updateDraftConfig],
  );

  const handleDraftSwitchMode = useCallback(
    (mode: string) => {
      if (mode === "plan" || mode === "plan-off") {
        updateComposerDraft((current) => ({
          ...current,
          mode: current.mode === "plan" ? "build" : (current.mode ?? "build"),
          planEnabled: mode === "plan",
        }));
        return;
      }
      // 模式与模型同属当前 scope；不再写全局偏好，避免别的任务反向覆盖。
      const parsed = submissionModeSchema.safeParse(mode);
      if (parsed.success)
        updateComposerDraft((current) => ({
          ...current,
          mode: parsed.data,
        }));
    },
    [updateComposerDraft],
  );

  return {
    modelSelectionRead,
    draftConfig,
    draftConfigRef,
    resolveInitialDraftConfig,
    composerDraft: draft,
    updateComposerContent,
    replaceComposerDraft,
    promoteComposerDraft,
    captureAcceptedModelSelection,
    handleDraftSelectModel,
    handleDraftSelectThought,
    handleDraftSwitchMode,
  };
}

/** createSession payload 的草稿 config 片段（无选择时返回空对象，不携带 config 键）。 */
export function buildDraftCreateConfigPayload(
  draftConfig: Partial<SessionConfigState>,
  appFollowupMode?: SessionConfigState["followupMode"] | null,
): { config?: Partial<SessionConfigState> } {
  const config: Partial<SessionConfigState> = { ...draftConfig };
  if (appFollowupMode) {
    config.followupMode = appFollowupMode;
  }
  return Object.keys(config).length > 0 ? { config } : {};
}

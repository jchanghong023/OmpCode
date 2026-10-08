import { applyComposerPermissionGrant } from "@/v4/composer/composerPermissionGrant.js";
/* eslint-disable max-lines -- Composer 草稿 owner 同时收口选择、正文与提交生命周期，保持单一状态边界。 */
// Composer 的模式/模型选择与正文使用同一 scope 草稿；Session 只提供一次初始化种子。
// 菜单点击立即保存 Renderer 意图，Prewarm 与 Submission 只消费它，不反向覆盖。
//
// Workspace presentation 水合只提供 mode 与 slash commands；模型候选、能力和首选值
// 统一来自目标 Host ModelSelectionView。
import {
  useCallback,
  useEffect,
  useLayoutEffect,
  useMemo,
  useRef,
  useSyncExternalStore,
} from "react";
import { ZCODE_AGENT_PROVIDER, resolveExecutionState } from "@zcode/shared";
import { applyComposerPlanTransition } from "@/v4/composer/composerPlanTransition.js";
import { applyOmpComposerModelSync } from "@/v4/composer/OmpComposerModelSync.js";
import type {
  ZCodeConfigOption,
  ModelSelection,
  ZCodeProvider,
  ZCodeSlashCommand,
} from "@zcode/shared";
import type { SessionConfigState } from "@zcode/shared/zcode-protocol-v4";
import type { IModelSelectionService } from "@zcode/services";
import {
  useModelSelectionServiceView,
  type ModelSelectionRead,
} from "@/hooks/useModelSelectionView.js";
import { useShallow } from "zustand/react/shallow";
import { submissionModeSchema } from "@zcode/shared/zcode-protocol-v4";
import { prepareWorkspaceWithZCodeSessionService } from "@/hooks/useWorkspacePrepare.js";
import { mergeOmpWorkspaceConfigOptions } from "@/lib/ompWorkspaceConfigOptions.js";
import { useZCodeSessionService } from "@/hooks/useZCodeSessionService.js";
import { useSettings } from "@/hooks/useSettingService.js";
import { parseModelPickerValue } from "@/lib/zcodeSessionProjection.js";
import { initializeNewTaskDraft } from "@/v4/composer/newTaskDraft.js";
import {
  findOmpCatalogEntry,
  highestOmpThoughtLevel,
  ompSessionConfigToSelection,
  readOmpModelCatalog,
  resolveOmpModelSelection,
} from "@/v4/composer/ompModelCatalog.js";
import { V4_DRAFT_SCOPE_ROOT, type V4ComposerDraft } from "@/v4/composer/composerDraftStore.js";
import {
  type ComposerContentReader,
  type ComposerDraftEvent,
  type ComposerSubmissionReceipt,
} from "@/v4/composer/composerDraftOwner.js";
import {
  getSharedComposerDraftOwner,
  migrateSharedComposerDraft,
} from "@/v4/composer/composerDraftRegistry.js";
import { resolveAppFollowupMode } from "@/v4/composer/followupModeSettings.js";
import { logger } from "@/logger.js";
import { selectWorkspaceZCodeState, useZCodeSessionStore } from "@/store/zcodeSessionStore.js";

/** 目录水合单飞（per workspaceKey）：draft、已有 session 和严格模式双挂载共享一次 RPC。 */
const workspaceCatalogHydrationFlights = new Map<string, Promise<void>>();

function applyDraftModelSelection(
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

function shouldHydrateWorkspaceCatalog(params: {
  configOptions: readonly ZCodeConfigOption[];
  sessionId: string | null;
  slashCommands: readonly ZCodeSlashCommand[];
}): boolean {
  const hasModePresentation = params.configOptions.some(
    (option) => option.category === "mode" && option.type === "select",
  );
  // slashCommands 属于 workspace identity，不会随已有 session projection 恢复。
  // 因此已有 session 只要目录为空也必须独立水合；mode 目录也不再借模型目录间接提供。
  return params.slashCommands.length === 0 || !hasModePresentation;
}

interface DraftConfigControl {
  modelSelectionRead: ModelSelectionRead;
  /** Renderer 下一次提交的配置；Session 只在 scope 首次初始化时提供种子。 */
  draftConfig: Partial<SessionConfigState>;
  /** 草稿已选 config（partial）；createSession 时经 buildDraftCreateConfigPayload 携带。 */
  draftConfigRef: React.RefObject<Partial<SessionConfigState>>;
  /** 当前草稿生命周期冻结的初始化 config；只供 prewarm/createSession 建立时使用。 */
  resolveInitialDraftConfig: () => Partial<SessionConfigState> | undefined;
  composerDraft: V4ComposerDraft;
  updateComposerContent: (
    content: Pick<V4ComposerDraft, "text" | "editorStateJson" | "mention">,
  ) => void;
  markComposerDraftDirty: (text?: string, userEdit?: boolean) => void;
  readComposerDraft: () => V4ComposerDraft;
  subscribeComposerDraft: (listener: (event: ComposerDraftEvent) => void) => () => void;
  captureComposerSubmission: (
    content: Pick<V4ComposerDraft, "text" | "editorStateJson" | "mention">,
  ) => ComposerSubmissionReceipt;
  flushComposerDraft: () => boolean;
  registerComposerContentReader: (reader: ComposerContentReader) => () => void;
  replaceComposerDraft: (draft: Omit<V4ComposerDraft, "updatedAt">) => void;
  /** 新任务被接纳后，把当前完整 Root Draft 原子式转移到真实 Session scope。 */
  promoteComposerDraft: (createdSessionId: string) => void;
  /** 在提交前捕获原意图；只在权威 accepted 后调用返回函数。 */
  captureAcceptedModelSelection: (
    selection: ModelSelection,
    expectedSelection?: ModelSelection,
  ) => () => void;
  handleDraftSelectModel: (modelProvider: string, model: string) => void;
  handleDraftSelectThought: (thought: string) => void;
  handleDraftSwitchMode: (mode: string) => void;
}

export function useDraftConfigControl(params: {
  workspacePath: string;
  workspaceIdentity?: string;
  provider?: ZCodeProvider;
  /** 会话切换读取对应 scope；已有空选择也必须保留。 */
  sessionId: string | null;
  /** 仅匹配当前 Session 的首份投影可用作初始化；null 表示还没恢复完成。 */
  sessionConfig?: Partial<SessionConfigState> | null;
  /** provider registry 已通过 renderer readiness 门禁后才允许拉起 Agent。 */
  agentStartupAllowed?: boolean;
  modelSelectionService: IModelSelectionService | null;
}): DraftConfigControl {
  const {
    workspacePath,
    workspaceIdentity,
    provider,
    sessionId,
    sessionConfig,
    agentStartupAllowed = true,
    modelSelectionService,
  } = params;
  const workspaceKey = workspaceIdentity?.trim() || workspacePath;
  const displayProvider = provider ?? ZCODE_AGENT_PROVIDER;
  const zcodeSessionService = useZCodeSessionService(workspacePath, null, workspaceIdentity);
  const { settings: sharedSettings } = useSettings();
  const appFollowupMode = resolveAppFollowupMode(sharedSettings);
  const scopeId = sessionId ?? V4_DRAFT_SCOPE_ROOT;
  const scopeKey = JSON.stringify([workspaceKey, scopeId]);
  const loadedScope = useMemo(
    () => getSharedComposerDraftOwner({ workspacePath, workspaceIdentity, scopeId }),
    [scopeKey],
  );
  const currentState = loadedScope;
  const lease = useMemo(() => Symbol("composer-reader"), [currentState]);
  useSyncExternalStore(
    currentState.subscribeConfig,
    currentState.getConfigRevision,
    currentState.getConfigRevision,
  );
  const initialDraft = currentState.draft;
  let draft = initialDraft;
  // omp 换核：模型选择事实源 = workspace-config 的 omp 目录；ZCode 账号目录不再参与草稿。
  const configOptions = useZCodeSessionStore(
    useShallow(
      (state) => selectWorkspaceZCodeState(state, workspacePath, workspaceIdentity).configOptions,
    ),
  );
  const ompCatalog = useMemo(() => readOmpModelCatalog(configOptions), [configOptions]);
  // 账号级 ModelSelectionView 仅服务 readiness 门禁与 custom provider 恢复面；
  // 用户可选模型与草稿选择一律来自上面的 omp 目录（FORK.md 换核）。
  const modelSelectionRead = useModelSelectionServiceView(
    modelSelectionService,
    true,
    "remote-waiting",
    {
      selection: draft.modelSelection ?? null,
    },
  );
  const initializeAsNewTask = sessionId === null || draft.initializeFromNewTask === true;
  if (!draft.mode && (initializeAsNewTask ? ompCatalog !== null : sessionConfig != null)) {
    const mode = submissionModeSchema.safeParse(sessionConfig?.mode);
    // Recent 是初始化原意图，不先按旧 Provider 是否仍在候选中删掉；下一次输入读取
    // 由同一解析入口对应当前 omp 目录，或暂时留空。否则冷启动会绕过统一目录对应规则。
    // mode 是已初始化标记：历史恢复给出的空选择也是确定结果，后续 Snapshot 不得填满。
    draft =
      initializeAsNewTask && ompCatalog
        ? initializeNewTaskDraft(draft, workspacePath, workspaceIdentity, ompCatalog)
        : {
            ...draft,
            mode: mode.success && mode.data !== "plan" ? mode.data : "build",
            planEnabled: resolveExecutionState(sessionConfig ?? {}).planEnabled,
            modelSelection: ompSessionConfigToSelection(sessionConfig),
          };
  }
  if (sessionConfig) {
    draft = applyOmpComposerModelSync(draft, sessionConfig);
    draft = applyComposerPlanTransition(draft, sessionConfig.planTransition);
    draft = applyComposerPermissionGrant(draft, sessionConfig.permissionGrant);
  }
  useLayoutEffect(() => {
    // 新 pane 的初始化只在读取版本仍有效时提交，不能用旧 render 覆盖另一个 pane 的新编辑。
    if (draft !== initialDraft) currentState.updateConfig(() => draft, initialDraft);
  }, [currentState, draft, initialDraft]);
  const stateRef = useRef(currentState);
  stateRef.current = currentState;
  // 原因：目录短暂不可用时保留草稿原意图；提交由目录门禁阻断。
  const effectiveSelection = useMemo(
    () =>
      ompCatalog
        ? (resolveOmpModelSelection(ompCatalog, draft.modelSelection ?? null).selection ??
          undefined)
        : draft.modelSelection,
    [ompCatalog, draft.modelSelection],
  );
  const draftConfig = useMemo<Partial<SessionConfigState>>(
    () => ({
      mode: draft.mode,
      planEnabled: draft.planEnabled ?? false,
      modelSelection: effectiveSelection,
      provider: effectiveSelection?.providerId ?? "",
      model: effectiveSelection?.modelId ?? "",
      thought: effectiveSelection?.options?.reasoningLevel ?? "",
    }),
    [draft.mode, draft.planEnabled, effectiveSelection],
  );
  const draftConfigRef = useRef(draftConfig);
  draftConfigRef.current = draftConfig;
  useLayoutEffect(() => {
    currentState.acquireLease(lease);
    const flush = () => currentState.flush();
    if (typeof window !== "undefined") {
      window.addEventListener("pagehide", flush);
      window.addEventListener("blur", flush);
      window.addEventListener("beforeunload", flush);
    }
    return () => {
      currentState.releaseLease(lease);
      if (typeof window !== "undefined") {
        window.removeEventListener("pagehide", flush);
        window.removeEventListener("blur", flush);
        window.removeEventListener("beforeunload", flush);
      }
    };
  }, [currentState, lease]);
  const markComposerDraftDirty = useCallback(
    (text?: string, userEdit = true) => {
      if (stateRef.current === currentState) currentState.markDirty(lease, text, userEdit);
    },
    [currentState, lease],
  );
  const flushComposerDraft = useCallback(() => currentState.flush(), [currentState]);
  const registerComposerContentReader = useCallback(
    (reader: ComposerContentReader) => currentState.registerReader(lease, reader),
    [currentState, lease],
  );
  const readComposerDraft = useCallback(() => currentState.draft, [currentState]);
  const subscribeComposerDraft = useCallback(
    (listener: (event: ComposerDraftEvent) => void) =>
      currentState.subscribe((event) => {
        if (event.origin !== lease) listener(event);
      }),
    [currentState, lease],
  );
  const captureComposerSubmission = useCallback(
    (content: Pick<V4ComposerDraft, "text" | "editorStateJson" | "mention">) =>
      currentState.captureSubmission(lease, content),
    [currentState, lease],
  );
  const updateComposerDraft = useCallback(
    (update: (current: V4ComposerDraft) => V4ComposerDraft) => {
      if (stateRef.current !== currentState) return;
      currentState.updateConfig(update);
      const next = currentState.draft;
      draftConfigRef.current = {
        mode: next.mode,
        planEnabled: next.planEnabled ?? false,
        modelSelection: next.modelSelection,
        provider: next.modelSelection?.providerId ?? "",
        model: next.modelSelection?.modelId ?? "",
        thought: next.modelSelection?.options?.reasoningLevel ?? "",
      };
    },
    [currentState],
  );
  const updateDraftConfig = useCallback(
    (
      update: (current: Partial<SessionConfigState>) => Partial<SessionConfigState>,
      edited: "model" | "thought",
    ) => {
      const next = update(draftConfigRef.current);
      const mode = submissionModeSchema.safeParse(next.mode);
      updateComposerDraft((current) => ({
        ...current,
        mode: mode.success ? mode.data : current.mode,
        modelSelection: next.modelSelection,
        ...(edited === "model"
          ? { ompModelEdited: true as const, ompThoughtEdited: undefined }
          : { ompThoughtEdited: true as const }),
        // 用户已经显式改选，不能再由导入时等待的默认初始化覆盖。
        ...(current.initializeFromNewTask
          ? { mode: mode.success ? mode.data : "build", initializeFromNewTask: undefined }
          : {}),
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
        if (stateRef.current !== currentState || stateRef.current.draft.modelSelection !== original)
          return;
        updateComposerDraft((current) => ({
          ...current,
          modelSelection: selection,
          // accepted 已提交这份意图；以它作比较游标，随后原生临时模型事实可回投。
          ompModelBaseline: selection,
          ompModelEdited: undefined,
          ompThoughtEdited: undefined,
        }));
      };
    },
    [currentState, updateComposerDraft],
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
      if (stateRef.current === currentState) currentState.updateContent(lease, content);
    },
    [currentState, lease],
  );
  const replaceComposerDraft = useCallback(
    (replacement: Omit<V4ComposerDraft, "updatedAt">) => {
      // 撤回编辑替换正文/配置，但不能忘记已经消费的授权，否则旧快照会再次覆盖新选择。
      updateComposerDraft((current) => ({
        ...replacement,
        lastPermissionGrantId: current.lastPermissionGrantId,
        ompModelBaseline: current.ompModelBaseline,
        ompModelEdited: true,
        ompThoughtEdited: true,
        updatedAt: Date.now(),
      }));
    },
    [updateComposerDraft],
  );

  const promoteComposerDraft = useCallback(
    (createdSessionId: string) => {
      if (
        stateRef.current !== currentState ||
        scopeId !== V4_DRAFT_SCOPE_ROOT ||
        !createdSessionId.trim()
      )
        return;
      migrateSharedComposerDraft({
        workspacePath,
        workspaceIdentity,
        fromTaskId: V4_DRAFT_SCOPE_ROOT,
        toTaskId: createdSessionId,
        redirectSourceLookup: false,
      });
    },
    [currentState, scopeId, workspaceIdentity, workspacePath],
  );

  // ── workspace 目录水合（见文件头说明）──
  // 目录已 ready（reload/广播/上次水合写过）则跳过；否则读取最小 workspace presentation。
  useEffect(() => {
    const isDraft = sessionId === null;
    const store = useZCodeSessionStore.getState();
    const workspaceState = store.getWorkspaceState(workspacePath, workspaceIdentity);
    if (!agentStartupAllowed) {
      // V4 目录水合曾在无模型时直接进入 RPC，虽然 Host 不会启动 CLI，
      // renderer 仍会把正常等待态记成 hydration error。readiness 未通过时保持 idle；
      // registry 就绪后依赖变化会自动重新进入本 effect。
      store.setConfigOptionsStatus(workspacePath, "idle", workspaceIdentity);
      return;
    }
    const configOptions = workspaceState.configOptions ?? [];
    const hasModePresentation = configOptions.some(
      (option) => option.category === "mode" && option.type === "select",
    );
    const hasSlashCommandCatalog = workspaceState.slashCommands.length > 0;
    const shouldHydrateCatalog = shouldHydrateWorkspaceCatalog({
      configOptions,
      sessionId,
      slashCommands: workspaceState.slashCommands,
    });
    logger.debug("[v4-workspace-catalog] hydration check", {
      catalogScope: isDraft ? "draft" : "known-session",
      hasModePresentation,
      hasSlashCommandCatalog,
      flightInProgress: workspaceCatalogHydrationFlights.has(workspaceKey),
      configOptionsStatus: workspaceState.configOptionsStatus,
      workspaceKey,
    });
    const existingFlight = workspaceCatalogHydrationFlights.get(workspaceKey);
    if (existingFlight) {
      return;
    }
    if (!shouldHydrateCatalog) {
      return;
    }

    store.setConfigOptionsStatus(workspacePath, "loading", workspaceIdentity);
    const flight = prepareWorkspaceWithZCodeSessionService({
      workspacePath,
      workspaceIdentity,
      provider: displayProvider,
      zcodeSessionService,
    })
      .then((prepareResult) => {
        const baseOptions = prepareResult.configOptions ?? [];
        // omp 换核：workspace-config 广播先到时 store 里已有 omp 模型/思考档位目录；
        // 水合回写只带 mode 项，不能把已有 omp 目录冲掉。
        const latestBeforeWrite = useZCodeSessionStore.getState();
        if (!latestBeforeWrite) {
          return;
        }
        const mergedOptions = mergeOmpWorkspaceConfigOptions(
          latestBeforeWrite.getWorkspaceState(workspacePath, workspaceIdentity)?.configOptions ??
            [],
          baseOptions,
        );
        logger.debug("[v4-workspace-catalog] hydration done", {
          catalogScope: isDraft ? "draft" : "known-session",
          optionCount: baseOptions.length,
          slashCommandCount: prepareResult.slashCommands?.length ?? 0,
          modeCurrentValue: String(
            baseOptions.find((option) => option.category === "mode" && option.type === "select")
              ?.currentValue ?? "",
          ),
          workspaceKey,
        });
        const latest = useZCodeSessionStore.getState();
        latest.setConfigOptions(workspacePath, mergedOptions, workspaceIdentity);
        latest.setConfigOptionsStatus(workspacePath, "ready", workspaceIdentity);
        if (
          (latest.getWorkspaceState(workspacePath, workspaceIdentity)?.slashCommands.length ??
            0) === 0 &&
          prepareResult.slashCommands?.length
        ) {
          latest.setSlashCommands(workspacePath, prepareResult.slashCommands, workspaceIdentity);
        }
      })
      .catch((error) => {
        useZCodeSessionStore
          .getState()
          .setConfigOptionsStatus(workspacePath, "error", workspaceIdentity);
        logger.warn(`[v4-workspace-catalog] workspace 目录水合失败: ${String(error)}`);
      })
      .finally(() => {
        workspaceCatalogHydrationFlights.delete(workspaceKey);
      });
    workspaceCatalogHydrationFlights.set(workspaceKey, flight);
  }, [
    agentStartupAllowed,
    displayProvider,
    sessionId,
    workspaceIdentity,
    workspaceKey,
    workspacePath,
    zcodeSessionService,
  ]);
  const handleDraftSelectModel = useCallback(
    (modelProvider: string, model: string) => {
      const modelId = modelProvider ? `${modelProvider}/${model}` : model;
      const parsedSelection = parseModelPickerValue(modelId);
      // omp 目录：切模型时使用目标模型支持的最高思考档；之后单独选档仍由草稿保留。
      const entry = findOmpCatalogEntry(
        ompCatalog,
        parsedSelection.providerId,
        parsedSelection.modelId,
      );
      const highestThoughtLevel = highestOmpThoughtLevel(entry);
      const modelSelection =
        highestThoughtLevel !== undefined
          ? { ...parsedSelection, options: { reasoningLevel: highestThoughtLevel } }
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
      updateDraftConfig((current) => applyDraftModelSelection(current, modelSelection), "model");
    },
    [ompCatalog, updateDraftConfig, workspaceIdentity, workspacePath],
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
      }, "thought");
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
          initializeFromNewTask: undefined,
        }));
        return;
      }
      // 模式与模型同属当前 scope；不再写全局偏好，避免别的任务反向覆盖。
      const parsed = submissionModeSchema.safeParse(mode);
      if (parsed.success)
        updateComposerDraft((current) => ({
          ...current,
          mode: parsed.data,
          initializeFromNewTask: undefined,
        }));
    },
    [updateComposerDraft],
  );

  // 正文只在 scope 恢复时读取。稳态父页 render 不再传播逐字符变化的草稿对象；
  // 配置变更仍提供最新配置，编辑器的最新正文由当前 scope owner 保存。
  const composerDraft = useMemo(
    () => draft,
    [
      currentState,
      draft.mode,
      draft.planEnabled,
      draft.modelSelection,
      draft.lastPermissionGrantId,
      draft.lastPlanTransitionId,
    ],
  );
  return {
    modelSelectionRead,
    draftConfig,
    draftConfigRef,
    resolveInitialDraftConfig,
    composerDraft,
    markComposerDraftDirty,
    readComposerDraft,
    subscribeComposerDraft,
    captureComposerSubmission,
    flushComposerDraft,
    registerComposerContentReader,
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

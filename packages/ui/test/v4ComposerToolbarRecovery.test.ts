import { act, createElement, type ComponentProps } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { IServiceAccessor, ProviderSettingsView } from "@zcode/services";
import { TooltipProvider } from "@/components/ui/tooltip.js";
import { ServiceProvider } from "@/hooks/useServices.js";
import { V4ComposerModelControls } from "@/v4/composer/V4ComposerToolbar.js";
import type { ModelConfigSelect } from "@/ModelConfigSelect.js";
import { useZCodeSessionStore } from "@/store/zcodeSessionStore.js";
import type { ZCodeConfigOption, ZCodeWorkspaceEvent } from "@zcode/shared";

globalThis.IS_REACT_ACT_ENVIRONMENT = true;

type ModelConfigSelectProps = ComponentProps<typeof ModelConfigSelect>;
type V4ComposerModelControlsProps = ComponentProps<typeof V4ComposerModelControls>;

const customValue = "custom:custom-openai:gpt-4o";

const captured = vi.hoisted(() => ({
  modelSelectProps: null as ModelConfigSelectProps | null,
  thoughtControlProps: null as {
    indicatorClassName?: string;
    triggerClassName?: string;
    composerCollapsePriority?: number;
    onValueChange: (value: string) => void;
    option: { currentValue?: unknown; options?: Array<{ value: string }> };
  } | null,
  usageProps: [] as Array<Record<string, unknown>>,
}));

const workspaceEvents = vi.hoisted(
  () => new Map<string, Set<(event: ZCodeWorkspaceEvent) => void>>(),
);

const mocks = vi.hoisted(() => ({
  services: {
    zcodeAgentService: {
      getOmpProfiles: async () => ({ storageScope: "native-toolbar-scope" }),
      onAgentRuntimeRestarted: () => ({ dispose() {} }),
    },
    zcodeSessionService: {
      readWorkspacePresentation: async () => ({ mode: "build", slashCommands: [] }),
    },
    zcodeTaskService: {
      onDynamicWorkspaceEvent:
        (target: string | { workspacePath: string; workspaceIdentity?: string }) =>
        (listener: (event: ZCodeWorkspaceEvent) => void) => {
          const key =
            typeof target === "string"
              ? target
              : target.workspaceIdentity?.trim() || target.workspacePath;
          const listeners = workspaceEvents.get(key) ?? new Set();
          workspaceEvents.set(key, listeners);
          listeners.add(listener);
          return { dispose: () => listeners.delete(listener) };
        },
    },
  },
  auth: { user: { id: "account-a" } as { id: string } | null, authSessionSeq: 1 },
  codingPlanEntitlements: {} as Record<string, unknown>,
  codingPlanEntitlementsRefresh: vi.fn(async () => undefined),
  codingPlanEntitlementsEnabledStartPlanIds: [] as string[],
  enterpriseProducts: { snapshot: { productList: [] }, loading: false, error: null } as Record<
    string,
    unknown
  >,
  providerSettingsView: {
    revision: 1,
    addableProviders: [],
    providerOrder: [],
    providers: [],
  } as ProviderSettingsView,
  selectModel: vi.fn(),
  settings: {
    providerFamilyConnectionSelections: {},
    providerFamilyDomain: {},
  } as Record<string, unknown>,
  usageEntitlement: { snapshot: null, loading: false, error: null } as Record<string, unknown>,
  usageEntitlementRefresh: vi.fn(async () => undefined),
}));

vi.mock("@/store/StoreProvider.js", () => ({
  useZCodeStoreWithDefault: (selector: (state: typeof mocks.auth) => unknown) =>
    selector(mocks.auth),
}));
vi.mock("@/hooks/useWorkspaceServices.js", () => {
  const services = mocks.services;
  return {
    useBaseWorkspaceServices: () => services,
    useWorkspaceServices: () => services,
  };
});
vi.mock("@/ModelConfigSelect.js", async () => {
  const React = await import("react");
  return {
    ModelConfigSelect: (props: ModelConfigSelectProps) => {
      captured.modelSelectProps = props;
      if (props.triggerRef && "current" in props.triggerRef) {
        (props.triggerRef as { current: HTMLSpanElement | null }).current = {
          contains: () => false,
          getClientRects: () => [{ width: 1 }] as unknown as DOMRectList,
        } as HTMLSpanElement;
      }
      return React.createElement("button", {
        "data-testid": "mock-model-select",
        disabled: props.disabled,
      });
    },
  };
});

vi.mock("@/chat-input-toolbar/display.js", async () => {
  const React = await import("react");
  return {
    ChatContextUsage: (props: Record<string, unknown>) => {
      captured.usageProps.push(props);
      return React.createElement("span", { "data-testid": "mock-usage" });
    },
  };
});

vi.mock("@/chat-input-toolbar/ThoughtLevelCycleControl.js", async () => {
  const React = await import("react");
  return {
    ThoughtLevelCycleControl: (props: {
      onValueChange: (value: string) => void;
      option: { currentValue?: unknown; options?: Array<{ value: string }> };
    }) => {
      captured.thoughtControlProps = props;
      return React.createElement("span", { "data-testid": "mock-thought" });
    },
  };
});

vi.mock("@/v4/composer/toolbarShortcuts.js", () => ({
  useToolbarShortcutBindings: vi.fn(),
}));

vi.mock("@/chat-input-toolbar/modelSelection.js", () => ({
  resolveModelSelectTriggerDisplay: (value: string) => ({ value }),
  shouldShowManageModelsAction: () => false,
}));

vi.mock("@/store/TabStoreProvider.js", () => ({
  useTabStore: () => vi.fn(),
}));

vi.mock("@/hooks/useProviderSettingsView.js", () => ({
  useProviderSettingsView: () => ({
    state: mocks.providerSettingsView
      ? { status: "ready", view: mocks.providerSettingsView }
      : { status: "loading" },
    reload: vi.fn(),
  }),
}));

vi.mock("@/hooks/useSettingService.js", () => ({
  useSettings: () => ({
    settings: mocks.settings,
  }),
}));

vi.mock("@/hooks/useUsageEntitlement.js", () => ({
  useUsageEntitlement: vi.fn((_options) => ({
    ...mocks.usageEntitlement,
    refresh: mocks.usageEntitlementRefresh,
  })),
}));

vi.mock("@/i18n/IntlProvider.js", () => ({
  useZCodeIntl: () => ({
    intl: {
      formatMessage: ({ id }: { id: string }) => id,
    },
    locale: "zh-CN",
  }),
}));

vi.mock("@/settings/CodingPlanUpgradeDialogProvider.js", () => ({
  useCodingPlanUpgradeDialog: () => ({ openCodingPlanUpgrade: vi.fn() }),
}));

vi.mock("@/settings/model-provider-section/useCodingPlanEntitlements.js", () => ({
  useCodingPlanEntitlements: () => ({
    entitlements: mocks.codingPlanEntitlements,
    enabledStartPlanProviderIds: mocks.codingPlanEntitlementsEnabledStartPlanIds,
    refresh: mocks.codingPlanEntitlementsRefresh,
  }),
}));

vi.mock("@/settings/model-provider-section/useEnterpriseCodingPlanProducts.js", () => ({
  useEnterpriseCodingPlanProducts: () => mocks.enterpriseProducts,
}));

vi.mock("@/lib/sidebarUsageCodingPlanProviderPreference.js", async () => {
  const actual = await vi.importActual("@/lib/sidebarUsageCodingPlanProviderPreference.js");
  return {
    ...(actual as Record<string, unknown>),
    writeSidebarUsageCodingPlanProviderPreference: vi.fn(),
  };
});

vi.mock("@/lib/codingPlanUsageSources.js", async () => {
  const actual = await vi.importActual("@/lib/codingPlanUsageSources.js");
  return actual;
});

vi.mock("@/lib/settingsNavigation.js", () => ({
  setPendingSettingsSectionIntent: vi.fn(),
  setPendingSettingsUsageCodingPlanIntent: vi.fn(),
}));

function createMinimalElement(ownerDocument: Document, tagName = "div") {
  const element = {
    addEventListener: () => {},
    appendChild: (child: { parentNode?: unknown }) => {
      child.parentNode = element;
      return child;
    },
    childNodes: [] as unknown[],
    getAttribute: () => null,
    insertBefore: (child: { parentNode?: unknown }) => {
      child.parentNode = element;
      return child;
    },
    nodeName: tagName.toUpperCase(),
    nodeType: 1,
    ownerDocument,
    parentNode: null as unknown,
    removeAttribute: () => {},
    removeChild: (child: { parentNode?: unknown }) => {
      child.parentNode = null;
      return child;
    },
    removeEventListener: () => {},
    setAttribute: () => {},
    style: {},
    tagName: tagName.toUpperCase(),
  };
  return element as unknown as Element;
}

function installMinimalDom() {
  const documentMock = {
    addEventListener: () => {},
    createElement: (tagName: string) =>
      createMinimalElement(documentMock as unknown as Document, tagName),
    createElementNS: (_namespace: string, tagName: string) =>
      createMinimalElement(documentMock as unknown as Document, tagName),
    createTextNode: (nodeValue: string) => ({
      nodeType: 3,
      nodeValue,
      ownerDocument: documentMock,
      parentNode: null,
    }),
    nodeType: 9,
    removeEventListener: () => {},
  } as unknown as Document;
  const windowMock = {
    addEventListener: () => {},
    clearTimeout,
    document: documentMock,
    HTMLElement: function HTMLElement() {},
    HTMLIFrameElement: function HTMLIFrameElement() {},
    Node: function Node() {},
    removeEventListener: () => {},
    setTimeout,
  } as unknown as Window & typeof globalThis;
  Object.assign(globalThis, {
    document: documentMock,
    window: windowMock,
    HTMLElement: windowMock.HTMLElement,
    HTMLIFrameElement: windowMock.HTMLIFrameElement,
    Node: windowMock.Node,
  });
  return createMinimalElement(documentMock, "div");
}

async function flushMicrotasks(): Promise<void> {
  await Promise.resolve();
  await Promise.resolve();
}

function nativeModel(
  provider: string,
  model: string,
  levels: string[] = ["disabled"],
  defaultLevel = levels[0],
) {
  return {
    value: `${provider}/${model}`,
    name: model,
    modelProviderId: provider,
    modelProviderName: provider,
    modelThoughtLevels: levels,
    modelDefaultThoughtLevel: defaultLevel,
  };
}

function seedNativeCatalog(
  models = [nativeModel("custom-openai", "gpt-4o")],
  workspaceIdentity?: string,
) {
  const options: ZCodeConfigOption[] = [
    {
      id: "model",
      name: "Model",
      category: "model",
      type: "select",
      currentValue: models[0]?.value ?? "",
      options: models,
    },
  ];
  const store = useZCodeSessionStore.getState();
  store.setConfigOptions("/workspace", options, workspaceIdentity);
  store.setConfigOptionsStatus("/workspace", "ready", workspaceIdentity);
}

let toolbarRoot: Root;

beforeEach(() => {
  useZCodeSessionStore.setState({ workspaces: {} });
  seedNativeCatalog();
  toolbarRoot = createRoot(installMinimalDom());
});

// 已有会话会挂载真实 OMP 入口；补服务上下文，不 mock scope hook 或用待选 profile 代替运行事实。
function createToolbarElement(props: V4ComposerModelControlsProps) {
  return createElement(ServiceProvider, {
    services: mocks.services as unknown as IServiceAccessor,
    children: createElement(V4ComposerModelControls, props),
  });
}

async function renderToolbar(overrides: Partial<V4ComposerModelControlsProps> = {}): Promise<void> {
  // Zustand SSR 只读 initial state；必须提交客户端 render 才能观察已接受的原生目录与订阅。
  const seed = overrides.config ?? {
    provider: "custom-openai",
    model: "gpt-4o",
    thought: "disabled",
    mode: "build",
  };
  await act(async () => {
    toolbarRoot.render(
      // 原生目录与 OMP 入口共用真实 hooks；仅叶子控件捕获已渲染 props。
      createElement(
        TooltipProvider,
        null,
        createToolbarElement({
          workspacePath: "/workspace",
          sessionId: null,
          phase: null,
          config: {
            provider: "custom-openai",
            model: "gpt-4o",
            thought: "medium",
            thoughtLevels: ["medium", "high"],
            followupMode: "queue",
            mode: "build",
          },
          usage: {
            contextWindow: {
              usedTokens: 1024,
              maxTokens: 2048,
              autoCompactThresholdTokens: null,
            },
            cumulative: {
              inputTokens: 1024,
              outputTokens: 0,
              cacheReadTokens: 0,
              cacheWriteTokens: 0,
            },
          },
          disabled: false,
          onSelectModel: mocks.selectModel,
          onSelectThought: vi.fn(),
          onSwitchMode: vi.fn(),
          draftConfig: {
            mode: seed.mode,
            modelSelection: {
              providerId: seed.provider,
              modelId: seed.model,
              ...(seed.thought ? { options: { reasoningLevel: seed.thought } } : {}),
            },
          },
          ...overrides,
        }),
      ),
    );
    await flushMicrotasks();
  });
}

afterEach(async () => {
  await act(async () => toolbarRoot.unmount());
  workspaceEvents.clear();
  mocks.auth = { user: { id: "account-a" }, authSessionSeq: 1 };
  captured.modelSelectProps = null;
  captured.thoughtControlProps = null;
  captured.usageProps = [];
  mocks.codingPlanEntitlementsRefresh.mockClear();
  mocks.usageEntitlementRefresh.mockClear();
  mocks.codingPlanEntitlements = {};
  mocks.codingPlanEntitlementsEnabledStartPlanIds = [];
  mocks.enterpriseProducts = { snapshot: { productList: [] }, loading: false, error: null };
  mocks.providerSettingsView = {
    revision: 1,
    addableProviders: [],
    providerOrder: [],
    providers: [],
  };
  mocks.settings = {
    providerFamilyConnectionSelections: {},
    providerFamilyDomain: {},
  };
  mocks.usageEntitlement = { snapshot: null, loading: false, error: null };
  vi.clearAllMocks();
});

describe("V4ComposerModelControls recovery", () => {
  it("原生 workspace 事件更新目录，不把目录默认值写成 Composer 选择", async () => {
    seedNativeCatalog([]);
    await renderToolbar({ draftConfig: { mode: "build" } });
    expect(captured.modelSelectProps).toBeNull();

    const configOptions: ZCodeConfigOption[] = [
      {
        id: "model",
        name: "Model",
        category: "model",
        type: "select",
        currentValue: "native-provider/native-model",
        options: [nativeModel("native-provider", "native-model", ["disabled"], "disabled")],
      },
    ];
    await act(async () => {
      const listeners = workspaceEvents.get("/workspace");
      expect(listeners?.size).toBeGreaterThan(0);
      for (const listener of listeners ?? []) {
        listener({
          type: "workspace_config_options_update",
          workspacePath: "/workspace",
          configOptions,
        });
      }
    });

    expect(useZCodeSessionStore.getState().getWorkspaceState("/workspace")).toMatchObject({
      configOptions,
      configOptionsStatus: "ready",
    });
    expect(captured.modelSelectProps?.normalizedValue).toBe("");
    expect(
      captured.modelSelectProps?.modelGroups?.flatMap((group) =>
        group.items.map((item) => item.value),
      ),
    ).toEqual(["custom:native-provider:native-model"]);
    expect(mocks.selectModel).not.toHaveBeenCalled();
    captured.modelSelectProps?.onValueChange("custom:native-provider:native-model");
    expect(mocks.selectModel).toHaveBeenCalledWith(
      "native-provider",
      "native-model",
      null,
      "disabled",
    );
  });

  it("首次原生空目录不借旧 Host 目录生成可选项", async () => {
    seedNativeCatalog([]);
    await renderToolbar({
      modelSelectionView: {
        revision: 9,
        providers: [
          {
            providerId: "host-only",
            config: {},
            models: [{ modelId: "host-model", config: {} }],
          },
        ],
      },
    });
    expect(captured.modelSelectProps).toBeNull();
    expect(mocks.selectModel).not.toHaveBeenCalled();
  });

  it.each(["loading", "error"] as const)("连接处于 %s 时保留已接受的原生目录", async (status) => {
    await renderToolbar();
    await act(async () => {
      useZCodeSessionStore.getState().setConfigOptionsStatus("/workspace", status);
    });
    expect(captured.modelSelectProps?.disabled).toBe(false);
    captured.modelSelectProps?.onValueChange(customValue);
    expect(mocks.selectModel).toHaveBeenCalledWith(
      "custom-openai",
      "gpt-4o",
      { provider: "custom-openai", model: "gpt-4o" },
      "disabled",
    );
  });

  it("免登录可选择原生目录并使用模型默认 thinking", async () => {
    mocks.auth.user = null;
    seedNativeCatalog([nativeModel("native-provider", "native-model", ["low", "high"], "low")]);
    await renderToolbar({ draftConfig: { mode: "build" } });
    captured.modelSelectProps?.onValueChange("custom:native-provider:native-model");
    expect(mocks.selectModel).toHaveBeenCalledWith("native-provider", "native-model", null, "low");
  });

  it("原生目录按目标身份隔离同路径本地目录", async () => {
    seedNativeCatalog([nativeModel("remote", "remote-model")], "remote-identity");
    await renderToolbar();
    expect(
      captured.modelSelectProps?.modelGroups?.flatMap((group) =>
        group.items.map((item) => item.value),
      ),
    ).toEqual([customValue]);
    await renderToolbar({ workspaceIdentity: "remote-identity", draftConfig: { mode: "build" } });
    const values = captured.modelSelectProps?.modelGroups?.flatMap((group) =>
      group.items.map((item) => item.value),
    );
    expect(values).toEqual(["custom:remote:remote-model"]);
  });
  it("Highspeed 卡生效期间隐藏 context token usage 圈圈", async () => {
    await renderToolbar();
    expect(captured.usageProps.length).toBeGreaterThan(0);
    captured.usageProps = [];
    await renderToolbar({ modelLocked: true });
    expect(captured.usageProps).toEqual([]);
  });

  it("已有会话的 Composer 模型留空时仍能打开模型菜单重选", async () => {
    await renderToolbar({
      sessionId: "existing-session",
      draftMode: false,
      draftConfig: { mode: "build" },
    });
    expect(captured.modelSelectProps).not.toBeNull();
    expect(captured.modelSelectProps?.normalizedValue).toBe("");
    expect(captured.modelSelectProps?.disabled).toBe(false);
    captured.modelSelectProps?.onValueChange(customValue);
    expect(mocks.selectModel).toHaveBeenCalledWith("custom-openai", "gpt-4o", null, "disabled");
    expect(captured.thoughtControlProps).toBeNull();
  });

  it("忽略模型切换期间受控 Select 产生的空 thought 事件", async () => {
    seedNativeCatalog([nativeModel("custom-openai", "gpt-4o", ["medium", "high"], "medium")]);
    const onSelectThought = vi.fn();

    await renderToolbar({ onSelectThought });
    expect(captured.thoughtControlProps).toBeNull();
    expect(captured.modelSelectProps?.composerOptions).toBeDefined();
    captured.modelSelectProps?.composerOptions?.onValueChange("");
    expect(onSelectThought).not.toHaveBeenCalled();

    captured.modelSelectProps?.composerOptions?.onValueChange("high");
    expect(onSelectThought).toHaveBeenCalledWith("high", {
      provider: "custom-openai",
      model: "gpt-4o",
    });
  });

  it("会话候选档位只取当前原生目录，不取旧 Session 档位", async () => {
    seedNativeCatalog([nativeModel("custom-openai", "GLM-5.2", ["low", "high", "max"], "low")]);
    await renderToolbar({
      config: {
        provider: "custom-openai",
        model: "GLM-5.2",
        thought: "high",
        thoughtLevels: ["max", "high", "nothink"],
        followupMode: "queue",
        mode: "build",
      },
    });

    expect(captured.modelSelectProps?.composerOptions?.levels.map(({ value }) => value)).toEqual([
      "low",
      "high",
      "max",
    ]);
  });

  it.each([{ thoughtLevels: [] }, { thoughtLevels: ["disabled"] }])(
    "恢复的空档位不被目录补齐：$thoughtLevels",
    async ({ thoughtLevels }) => {
      await renderToolbar({
        config: {
          provider: "custom-openai",
          model: "gpt-4o",
          thought: "",
          thoughtLevels,
          followupMode: "queue",
          mode: "build",
        },
      });
      expect(captured.modelSelectProps?.composerOptions?.value).toBe("");
    },
  );

  it("草稿预热完成后仍展示 Composer 选择与原生候选，不消费旧投影档位", async () => {
    await renderToolbar({
      draftMode: true,
      draftConfig: {
        mode: "build",
        modelSelection: {
          providerId: "custom-openai",
          modelId: "gpt-4o",
          options: { reasoningLevel: "disabled" },
        },
      },
      config: {
        provider: "custom-openai",
        model: "gpt-4o",
        thought: "high",
        thoughtLevels: ["max", "high", "nothink"],
        followupMode: "queue",
        mode: "build",
      },
    });

    expect(captured.modelSelectProps?.composerOptions).toMatchObject({
      value: "disabled",
      levels: [{ value: "disabled" }],
    });
  });

  it("草稿切换目标模型时不复用旧预热投影的 thought 档位", async () => {
    await renderToolbar({
      draftMode: true,
      config: {
        provider: "custom-openai",
        model: "gpt-4o",
        thought: "high",
        thoughtLevels: ["medium", "high"],
        followupMode: "queue",
        mode: "build",
      },
      draftConfig: {
        modelSelection: { providerId: "custom-openai", modelId: "gpt-4.1" },
      },
    });

    expect(captured.modelSelectProps?.composerOptions?.levels).toEqual([]);
    expect(captured.modelSelectProps?.composerOptions?.value).toBe("");
    expect(captured.thoughtControlProps).toBeNull();
  });

  it("does not write a menu-first fallback when a session model is absent from the visible catalog", async () => {
    await renderToolbar({
      sessionId: "session-removed-model",
      phase: "completedSuccess",
      draftConfig: {
        mode: "build",
        modelSelection: {
          providerId: "removed-provider",
          modelId: "removed-model",
          options: { reasoningLevel: "high" },
        },
      },
      config: {
        provider: "removed-provider",
        model: "removed-model",
        thought: "high",
        thoughtLevels: ["high"],
        followupMode: "queue",
        mode: "build",
      },
      usage: null,
    });

    expect(mocks.selectModel).not.toHaveBeenCalled();
  });
});

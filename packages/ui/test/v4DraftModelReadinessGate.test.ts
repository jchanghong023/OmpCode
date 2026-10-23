// @vitest-environment jsdom
import { act, renderHook, waitFor } from "@testing-library/react";
import { beforeEach, describe, expect, it, vi } from "vitest";
import type { ZCodeConfigOption, ZCodeWorkspaceEvent } from "@zcode/shared";
import {
  buildOmpModelSelectGroups,
  readOmpModelCatalog,
  useOmpModelCatalog,
} from "@/omp-configuration/ompModelCatalog.js";
import { createComposerSubmissionConfig } from "@/v4/composer/composerSubmissionConfig.js";
import { useZCodeSessionStore } from "@/store/zcodeSessionStore.js";
import type * as WorkspacePrepareRpc from "@/hooks/workspacePrepareRpc.js";

const { service, prepareWorkspace, workspaceListeners } = vi.hoisted(() => ({
  service: { readWorkspacePresentation: vi.fn() },
  prepareWorkspace: vi.fn(),
  workspaceListeners: new Map<string, Set<(event: ZCodeWorkspaceEvent) => void>>(),
}));
vi.mock("@/hooks/useZCodeTaskService.js", () => ({
  useZCodeTaskService: () => taskService,
}));
const taskService = {
  onDynamicWorkspaceEvent:
    (target: { workspacePath: string; workspaceIdentity?: string }) =>
    (listener: (event: ZCodeWorkspaceEvent) => void) => {
      const key = target.workspaceIdentity?.trim() || target.workspacePath;
      const listeners = workspaceListeners.get(key) ?? new Set();
      listeners.add(listener);
      workspaceListeners.set(key, listeners);
      return { dispose: () => listeners.delete(listener) };
    },
};
vi.mock("@/hooks/useZCodeSessionService.js", () => ({ useZCodeSessionService: () => service }));
vi.mock("@/hooks/useWorkspacePrepare.js", () => ({
  prepareWorkspaceWithZCodeSessionService: prepareWorkspace,
}));
vi.mock("@/logger.js", () => ({ logger: { warn: vi.fn(), info: vi.fn() } }));
beforeEach(() => {
  useZCodeSessionStore.setState({ workspaces: {} });
  prepareWorkspace.mockReset();
  workspaceListeners.clear();
  service.readWorkspacePresentation.mockReset();
  prepareWorkspace.mockResolvedValue({ configOptions: nativeOptions(), slashCommands: [] });
});
function nativeOptions(modelId = "free-chat", thought = "low"): ZCodeConfigOption[] {
  return [
    {
      id: "model",
      category: "model",
      name: "Model",
      type: "select",
      currentValue: `native/${modelId}`,
      options: [
        {
          value: `native/${modelId}`,
          name: "Native Free Chat",
          modelProviderId: "native",
          modelProviderName: "Native Built-in",
          modelThoughtLevels: ["off", "low", "high"],
          modelDefaultThoughtLevel: thought,
        },
      ],
    },
  ];
}

function modeOptions(): ZCodeConfigOption[] {
  return [
    {
      id: "mode",
      category: "mode",
      name: "Mode",
      type: "select",
      currentValue: "build",
      options: [{ value: "build", name: "Build" }],
    },
  ];
}

function emitNativeDirectory(workspacePath: string, configOptions: ZCodeConfigOption[]) {
  for (const listener of workspaceListeners.get(workspacePath) ?? []) {
    listener({ type: "workspace_config_options_update", workspacePath, configOptions });
  }
}

describe("OMP native draft model readiness", () => {
  it("原生目录完整保留供应商与档位，默认档位不擅自改为最高", () => {
    const catalog = readOmpModelCatalog(nativeOptions())!;
    expect(catalog.entries[0]).toMatchObject({
      providerName: "Native Built-in",
      modelName: "Native Free Chat",
      thoughtLevels: ["off", "low", "high"],
      defaultThoughtLevel: "low",
    });
    expect(catalog.preferredSelection?.options?.reasoningLevel).toBe("low");
    expect(buildOmpModelSelectGroups(catalog)).toMatchObject([
      { label: "Native Built-in", items: [{ name: "Native Free Chat" }] },
    ]);
  });

  it("内置免 key、无档位模型无需 Host 配置即可构造稀疏发送意图", () => {
    const options = nativeOptions();
    delete options[0]!.options![0]!.modelThoughtLevels;
    delete options[0]!.options![0]!.modelDefaultThoughtLevel;
    const catalog = readOmpModelCatalog(options)!;
    expect(
      createComposerSubmissionConfig(
        { mode: "build", modelSelection: catalog.preferredSelection! },
        catalog,
      )?.modelSelection,
    ).toEqual({ providerId: "native", modelId: "free-chat" });
  });

  it("非空原生来源不混入 Host，空源只显示真实空态", () => {
    expect(buildOmpModelSelectGroups(readOmpModelCatalog(nativeOptions()))).toHaveLength(1);
    expect(readOmpModelCatalog([])).toBeNull();
    expect(readOmpModelCatalog([{ ...nativeOptions()[0]!, options: [] }])).toBeNull();
    expect(buildOmpModelSelectGroups(null)).toEqual([]);
    expect(
      createComposerSubmissionConfig(
        { mode: "build", modelSelection: { providerId: "host-only", modelId: "old" } },
        readOmpModelCatalog(nativeOptions()),
      ),
    ).toBeNull();
  });

  it("热更新消费 workspace 事实而非旧 task 模型快照", () => {
    const store = useZCodeSessionStore.getState();
    store.setConfigOptions("/workspace", nativeOptions(), "identity");
    store.setTaskConfigOptions("/workspace", "old-task", nativeOptions("old-task"), "identity");
    const { result } = renderHook(() => useOmpModelCatalog("/workspace", "identity", null, false));
    expect(result.current.catalog?.preferredSelection?.modelId).toBe("free-chat");
    act(() => store.setConfigOptions("/workspace", nativeOptions("hot-chat", "off"), "identity"));
    expect(result.current.catalog?.preferredSelection).toEqual({
      providerId: "native",
      modelId: "hot-chat",
      options: { reasoningLevel: "off" },
    });
  });

  it("设置先打开：真实 prepare 仅返回 mode，目录从 Host 后到事件水合", async () => {
    const actual = await vi.importActual<typeof WorkspacePrepareRpc>(
      "@/hooks/workspacePrepareRpc.js",
    );
    prepareWorkspace.mockImplementation(actual.prepareWorkspaceWithZCodeSessionService);
    service.readWorkspacePresentation.mockResolvedValue({ mode: "build", slashCommands: [] });
    const { result } = renderHook(() => useOmpModelCatalog("/settings-first"));
    await waitFor(() => expect(service.readWorkspacePresentation).toHaveBeenCalledTimes(1));
    await waitFor(() =>
      expect(result.current.configOptions.some((o) => o.id === "mode")).toBe(true),
    );
    expect(result.current.catalog).toBeNull();
    expect(result.current.status).toBe("loading");
    act(() => emitNativeDirectory("/settings-first", nativeOptions()));
    expect(result.current.catalog?.entries).toHaveLength(1);
    expect(result.current.status).toBe("ready");
    expect(prepareWorkspace).toHaveBeenCalledTimes(1);
  });

  it("mode-only ready 不能阻止 renderer refresh 后的 prepare", async () => {
    const store = useZCodeSessionStore.getState();
    store.setConfigOptions("/refresh", modeOptions());
    store.setConfigOptionsStatus("/refresh", "ready");
    const { result } = renderHook(() => useOmpModelCatalog("/refresh"));
    await waitFor(() => expect(result.current.catalog?.entries).toHaveLength(1));
    expect(prepareWorkspace).toHaveBeenCalledTimes(1);
  });

  it("已有会话切回同 profile 草稿会重新加载命令，不重置已就绪的模型", async () => {
    const path = "/command-draft";
    const scope = "native-profile";
    const commands = [{ name: "goal", description: "Native goal", source: "builtin" as const }];
    const store = useZCodeSessionStore.getState();
    store.startDraft(path, undefined, undefined, { draftStorageScope: scope });
    store.setConfigOptions(path, nativeOptions());
    store.setConfigOptionsStatus(path, "ready");
    store.setSlashCommands(path, commands);
    store.setActiveTaskId(path, "existing-task");
    const models = store.getWorkspaceState(path).configOptions;
    prepareWorkspace.mockResolvedValue({ configOptions: modeOptions(), slashCommands: commands });
    const { result } = renderHook(() => useOmpModelCatalog(path));

    act(() => store.startDraft(path, undefined, undefined, { draftStorageScope: scope }));
    await waitFor(() => expect(store.getWorkspaceState(path).slashCommands).toEqual(commands));
    expect(store.getWorkspaceState(path).configOptions).toBe(models);
    expect(result.current.status).toBe("ready");
    expect(result.current.catalog?.preferredSelection?.modelId).toBe("free-chat");
  });

  it("命令事件按身份替换目录，迟到 presentation 不能复活旧命令", async () => {
    const path = "/command-events";
    const identity = "remote:commands";
    const store = useZCodeSessionStore.getState();
    store.setConfigOptions(path, nativeOptions(), identity);
    store.setConfigOptionsStatus(path, "ready", identity);
    const pending = Promise.withResolvers<{
      configOptions: ZCodeConfigOption[];
      slashCommands: Array<{ name: string; description: string }>;
    }>();
    prepareWorkspace.mockReturnValue(pending.promise);
    renderHook(() => useOmpModelCatalog(path, identity));
    const current = [{ name: "repo", description: "Current native command" }];
    act(() => {
      for (const listener of workspaceListeners.get(identity) ?? []) {
        listener({
          type: "workspace_slash_commands_update",
          workspacePath: path,
          workspaceIdentity: identity,
          commands: current,
        });
      }
    });
    await act(async () =>
      pending.resolve({
        configOptions: modeOptions(),
        slashCommands: [{ name: "old-command", description: "Stale presentation" }],
      }),
    );
    expect(store.getWorkspaceState(path, identity).slashCommands).toEqual(current);
    expect(store.getWorkspaceState(path).slashCommands).toEqual([]);
  });

  it("原生目录先到、迟到 presentation 和热更新不会清空模型", async () => {
    const pending = Promise.withResolvers<{
      configOptions: ZCodeConfigOption[];
      slashCommands: [];
    }>();
    prepareWorkspace.mockReturnValue(pending.promise);
    const { result } = renderHook(() => useOmpModelCatalog("/native-first"));
    act(() => emitNativeDirectory("/native-first", nativeOptions()));
    await act(async () => pending.resolve({ configOptions: modeOptions(), slashCommands: [] }));
    expect(result.current.catalog?.preferredSelection?.modelId).toBe("free-chat");
    act(() => useZCodeSessionStore.getState().setConfigOptions("/native-first", modeOptions()));
    expect(result.current.catalog?.preferredSelection?.modelId).toBe("free-chat");
    act(() => emitNativeDirectory("/native-first", nativeOptions("new-chat")));
    expect(result.current.catalog?.preferredSelection?.modelId).toBe("new-chat");
    act(() => emitNativeDirectory("/native-first", [{ ...nativeOptions()[0]!, options: [] }]));
    expect(result.current.catalog).toBeNull();
    expect(result.current.status).toBe("ready");
  });

  it("同路径的 local 与 remote 身份不混用", () => {
    const store = useZCodeSessionStore.getState();
    store.setConfigOptions("/same", nativeOptions("local"));
    store.setConfigOptions("/same", nativeOptions("remote"), "remote-identity");
    const { result } = renderHook(() => useOmpModelCatalog("/same", undefined, null, false));
    expect(result.current.catalog?.preferredSelection?.modelId).toBe("local");
  });
});

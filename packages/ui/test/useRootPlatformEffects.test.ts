// @vitest-environment jsdom
import { createElement, type ReactNode } from "react";
import { renderHook } from "@testing-library/react";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { useRootPlatformEffects } from "@/root/useRootPlatformEffects.js";
import { useRootWorkspaceActions } from "@/root/useRootWorkspaceActions.js";
import { TabStoreProvider } from "@/store/TabStoreProvider.js";
import { useZCodeSessionStore } from "@/store/zcodeSessionStore.js";
import { INITIAL_PANE_LAYOUT, usePaneLayoutStore } from "@/v4/paneLayoutStore.js";
import { useWorkbenchGroupStore } from "@/v4/workbenchGroupStore.js";
import {
  persistPaneSession,
  readPersistedPaneSession,
  usePaneSessionPersistence,
} from "@/v4/usePaneSessionPersistence.js";
import {
  rememberComposerWorkspaceScope,
  resolveComposerScope,
} from "@/v4/composer/composerDraftStore.js";
import type { CreateTaskOptions } from "@/app-shell/types.js";
import {
  buildConnectedRemoteWorkspaceSessionTargets,
  buildWebRemoteControlWorkspaceTargets,
} from "@/root/rootPlatformWorkspaceSync.js";
import type { WindowTabState } from "@/store/tabStore.js";

const navigation = vi.hoisted(() => ({ reload: false }));
vi.mock("@/lib/rendererNavigation.js", () => ({
  isRendererReloadNavigation: () => navigation.reload,
}));

function wrapper({ children }: { children: ReactNode }) {
  return createElement(TabStoreProvider, null, children);
}

function bootstrapInitialWorkspace({
  identity,
  initialTaskDraft,
  initialTaskId,
  restoreOnStartup = false,
  clientMode = "desktop-continuous",
}: {
  identity?: string;
  initialTaskDraft?: CreateTaskOptions;
  initialTaskId?: string;
  restoreOnStartup?: boolean;
  clientMode?: "desktop-continuous" | "web-remote-replayable";
} = {}) {
  const path = "/workspace/demo";
  const addTab = vi.fn();
  const intl = { formatMessage: ({ id }: { id: string }) => id } as never;
  const platform = {
    onFocusTab: () => () => {},
    onNewTab: () => () => {},
    onNewTask: () => () => {},
    onOpenWorkspace: () => () => {},
    onTaskNotificationClick: () => () => {},
    setApplicationLocale: async () => {},
    syncWindowTabs: () => {},
    syncActiveTaskSession: () => {},
  } as never;
  return renderHook(
    () => {
      const actions = useRootWorkspaceActions({
        intl,
        platform,
        services: {} as never,
        tabStoreApi: {
          getState: () => ({ tabs: [], activeWorkspacePath: null, activeWorkspaceIdentity: null }),
        } as never,
        addTab,
        activeWorkspacePath: null,
        activeWorkspaceIdentity: null,
        supportsSettings: false,
        allowOpenWorkspace: true,
        preferDirectoryBrowser: false,
        refreshProviderState: vi.fn(),
        updateAppSettings: vi.fn(),
        setOAuthError: vi.fn(),
        setUser: vi.fn(),
        workbenchGroupClientMode: clientMode,
      });
      useRootPlatformEffects({
        initialWorkspaceAbsPath: path,
        initialWorkspaceIdentity: identity,
        initialTaskDraft,
        initialTaskId,
        clientMode,
        addTab,
        setIsBootstrappingInitialWorkspace: vi.fn(),
        platform,
        activateTabByPath: () => true,
        startDraftInWorkspace: actions.startDraftInWorkspace,
        startNewTaskFromActiveWorkspace: vi.fn(),
        openWorkspace: vi.fn(),
        openWorkspacePath: vi.fn(),
        setWorkspaceActionError: vi.fn(),
        isDesktop: clientMode === "desktop-continuous",
        locale: "en-US" as never,
        tabs: [
          createWorkspaceTab({ workspaceIdentity: identity, restorePaneSession: restoreOnStartup }),
        ],
        intl,
        isRestoringOAuthSession: false,
      });
    },
    { wrapper },
  );
}

describe("initial workspace draft and pane restoration priority", () => {
  beforeEach(() => {
    localStorage.clear();
    navigation.reload = false;
    useZCodeSessionStore.setState({ workspaces: {} });
    usePaneLayoutStore.setState(INITIAL_PANE_LAYOUT);
    useWorkbenchGroupStore.getState().resetWorkbenchGroups();
  });

  it.each([
    { reload: true, restoreOnStartup: false, identity: undefined },
    { reload: true, restoreOnStartup: false, identity: "remote:server:one:/workspace/demo" },
    { reload: false, restoreOnStartup: true, identity: "remote:server:one:/workspace/demo" },
  ])("leaves cached session B to the pane owner (%j)", ({ reload, restoreOnStartup, identity }) => {
    navigation.reload = reload;
    const path = "/workspace/demo";
    const key = identity ?? path;
    rememberComposerWorkspaceScope(path, identity, resolveComposerScope("project-a", identity));
    persistPaneSession(key, "session-b");
    bootstrapInitialWorkspace({ identity, restoreOnStartup });
    expect(
      useZCodeSessionStore.getState().getWorkspaceState(path, identity).draftFocusVersion,
    ).toBe(0);
    expect(readPersistedPaneSession(key)).toBe("session-b");
    renderHook(() => {
      const activeSessionId = useZCodeSessionStore(
        (state) => state.getWorkspaceState(path, identity).activeTaskId,
      );
      const draftFocusVersion = useZCodeSessionStore(
        (state) => state.getWorkspaceState(path, identity).draftFocusVersion,
      );
      usePaneSessionPersistence({
        workspaceKey: key,
        activeSessionId,
        draftFocusVersion,
        restoreOnStartup,
        selectSession: (sessionId) =>
          useZCodeSessionStore.getState().setActiveTaskId(path, sessionId, identity),
      });
    });
    expect(useZCodeSessionStore.getState().getWorkspaceState(path, identity).activeTaskId).toBe(
      "session-b",
    );
    expect(readPersistedPaneSession(key)).toBe("session-b");
  });

  it("keeps an explicit initial draft ahead of a reload target", () => {
    navigation.reload = true;
    persistPaneSession("/workspace/demo", "session-b");
    bootstrapInitialWorkspace({ initialTaskDraft: { projectId: "explicit-project" } });
    const workspace = useZCodeSessionStore.getState().getWorkspaceState("/workspace/demo");
    expect(workspace.activeTaskId).toBeNull();
    expect(workspace.draftFocusVersion).toBeGreaterThan(0);
    expect(workspace.draftProjectId).toBe("explicit-project");
  });

  it("keeps an explicit task ahead of cached project scope", () => {
    navigation.reload = true;
    rememberComposerWorkspaceScope("/workspace/demo", undefined, resolveComposerScope("project-a"));
    bootstrapInitialWorkspace({ initialTaskId: "explicit-session" });
    expect(useZCodeSessionStore.getState().getWorkspaceState("/workspace/demo").activeTaskId).toBe(
      "explicit-session",
    );
    expect(
      useZCodeSessionStore.getState().getWorkspaceState("/workspace/demo").draftFocusVersion,
    ).toBe(0);
  });

  it.each([
    { reload: true, clientMode: "desktop-continuous" as const },
    { reload: false, clientMode: "desktop-continuous" as const },
    { reload: true, clientMode: "web-remote-replayable" as const },
  ])("retains project draft when there is no eligible target (%j)", ({ reload, clientMode }) => {
    navigation.reload = reload;
    const identity = "remote:server:one:/workspace/demo";
    rememberComposerWorkspaceScope(
      "/workspace/demo",
      identity,
      resolveComposerScope("project-a", identity),
    );
    // A same-path local pane must not become the remote workspace's restoration target.
    persistPaneSession("/workspace/demo", "unrelated-local-session");
    if (clientMode === "web-remote-replayable") persistPaneSession(identity, "desktop-session");
    bootstrapInitialWorkspace({ identity, clientMode });
    const workspace = useZCodeSessionStore
      .getState()
      .getWorkspaceState("/workspace/demo", identity);
    expect(workspace.activeTaskId).toBeNull();
    expect(workspace.draftFocusVersion).toBeGreaterThan(0);
    expect(workspace.draftProjectId).toBe("project-a");
  });
});
function createWorkspaceTab(
  overrides: Partial<Extract<WindowTabState, { kind: "workspace" }>> = {},
): Extract<WindowTabState, { kind: "workspace" }> {
  return {
    id: overrides.id ?? "tab-1",
    kind: "workspace",
    label: overrides.label ?? "demo",
    workspacePath: overrides.workspacePath ?? "/workspace/demo",
    workspaceIdentity: overrides.workspaceIdentity,
    workspacePurpose: overrides.workspacePurpose,
    remoteSessionId: overrides.remoteSessionId,
    restorePaneSession: overrides.restorePaneSession,
    remoteTarget: overrides.remoteTarget,
  };
}

describe("buildWebRemoteControlWorkspaceTargets", () => {
  it("preserves conversation purpose for mobile task navigation", () => {
    expect(
      buildWebRemoteControlWorkspaceTargets({
        tabs: [
          createWorkspaceTab({
            id: "conversation",
            label: "default",
            workspacePath: "/Users/demo/.zcode/workspace/default",
            workspacePurpose: "conversation",
          }),
        ],
      }),
    ).toEqual([
      {
        workspacePath: "/Users/demo/.zcode/workspace/default",
        label: "default",
        kind: "local",
        workspacePurpose: "conversation",
      },
    ]);
  });

  it("syncs disconnected errors and reconnecting state by workspace identity", () => {
    expect(
      buildWebRemoteControlWorkspaceTargets({
        tabs: [
          createWorkspaceTab({
            id: "remote-1",
            label: "Remote App",
            workspacePath: "/workspace/remote",
            workspaceIdentity: "remote:ssh:dev:/workspace/remote",
            remoteTarget: { kind: "ssh", host: "dev", username: "root" },
          }),
          createWorkspaceTab({
            id: "remote-2",
            label: "Reconnecting App",
            workspacePath: "/workspace/reconnecting",
            workspaceIdentity: "remote:ssh:dev:/workspace/reconnecting",
            remoteTarget: { kind: "ssh", host: "dev", username: "root" },
          }),
          createWorkspaceTab({
            id: "local-1",
            label: "Local App",
            workspacePath: "/workspace/local",
          }),
        ],
        reconnectingRemoteWorkspaceKeys: ["remote:ssh:dev:/workspace/reconnecting"],
        remoteWorkspaceErrorByWorkspaceKey: {
          "remote:ssh:dev:/workspace/remote": "ssh closed",
        },
      }),
    ).toEqual([
      {
        workspacePath: "/workspace/remote",
        label: "Remote App",
        kind: "remote",
        connectionState: "disconnected",
        workspaceIdentity: "remote:ssh:dev:/workspace/remote",
        lastConnectionError: "ssh closed",
      },
      {
        workspacePath: "/workspace/reconnecting",
        label: "Reconnecting App",
        kind: "remote",
        connectionState: "reconnecting",
        workspaceIdentity: "remote:ssh:dev:/workspace/reconnecting",
      },
      {
        workspacePath: "/workspace/local",
        label: "Local App",
        kind: "local",
      },
    ]);
  });
});

describe("buildConnectedRemoteWorkspaceSessionTargets", () => {
  it("returns only connected remote tabs with workspace identity", () => {
    expect(
      buildConnectedRemoteWorkspaceSessionTargets({
        tabs: [
          createWorkspaceTab({
            id: "remote-connected",
            label: "Remote Connected",
            workspacePath: "/root",
            workspaceIdentity: "remote:docker:zcode-ssh-container:/root",
            remoteSessionId: "remote-session-1",
            remoteTarget: { kind: "docker", container: "zcode-ssh-container" },
          }),
          createWorkspaceTab({
            id: "remote-placeholder",
            label: "Remote Placeholder",
            workspacePath: "/workspace/disconnected",
            workspaceIdentity: "remote:ssh:dev:/workspace/disconnected",
            remoteTarget: { kind: "ssh", host: "dev", username: "root" },
          }),
          createWorkspaceTab({
            id: "local",
            label: "Local",
            workspacePath: "/workspace/local",
          }),
        ],
      }),
    ).toEqual([
      {
        workspacePath: "/root",
        label: "Remote Connected",
        kind: "remote",
        connectionState: "connected",
        workspaceIdentity: "remote:docker:zcode-ssh-container:/root",
        remoteSessionId: "remote-session-1",
      },
    ]);
  });
});

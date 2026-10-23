// @vitest-environment jsdom
import { createElement } from "react";
import type { ReactNode } from "react";
import { cleanup, fireEvent, render, renderHook, screen, waitFor } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type {
  SkillSummary,
  SkillsListResult,
  ZCodeSkillReferenceCatalogEntry,
} from "@zcode/shared";
import { ZCodeIntlProvider } from "../src/i18n/IntlProvider.js";
import { SkillsSection } from "../src/settings/SkillsSection.js";
import type * as RemoteSyncActionsModule from "../src/settings/RemoteSyncActions.js";
import { useSkillsMentionProvider } from "../src/mentions/providers/skillsMentionProvider.js";
import { buildSkillSuggestions } from "../src/slashCommandHelpers.js";

const h = vi.hoisted(() => ({
  result: {
    skills: [],
    capability: { userScopeAvailable: true },
    diagnostics: [],
  } as SkillsListResult,
  list: vi.fn<() => Promise<SkillsListResult>>(),
  getSkillReferenceCatalog: vi.fn<
    () => Promise<{
      authority: "workspace";
      skills: ZCodeSkillReferenceCatalogEntry[];
    }>
  >(),
  setEnabled:
    vi.fn<(params: { skillId: string; enabled: boolean; scope?: string }) => Promise<void>>(),
  deleteSkill: vi.fn(),
  openInFileManager: vi.fn(),
  onCreateTask: vi.fn(),
  initialize: vi.fn(async () => undefined),
  confirm: vi.fn(async () => false),
}));
const services = vi.hoisted(() => ({
  skillsService: { list: h.list, setEnabled: h.setEnabled, deleteSkill: h.deleteSkill },
  pluginManagementService: {},
  skillSyncService: {},
  zcodeAgentService: { getSkillReferenceCatalog: h.getSkillReferenceCatalog },
}));
const pluginState = vi.hoisted(() => ({
  plugins: [],
  installedPlugins: [],
  availablePlugins: [],
  workspacePath: null,
  workspaceIdentity: null,
  configScope: "workspace",
  initialize: h.initialize,
}));
vi.mock("@/workspace-config-catalog/index.js", () => ({
  useConfigWorkspaceServicesResolution: () => ({ services, rpcReady: true }),
}));
vi.mock("@/hooks/useWorkspaceServices.js", () => ({
  useBaseWorkspaceServices: () => services,
  useWorkspaceServicesResolution: () => ({ services, rpcReady: true, remoteSessionId: null }),
}));
vi.mock("@/store/pluginManagementStore.js", () => ({
  usePluginManagementStore: (selector: (state: typeof pluginState) => unknown) =>
    selector(pluginState),
}));
vi.mock("@/hooks/usePlatform.js", () => ({
  usePlatform: () => ({ openInFileManager: h.openInFileManager }),
}));
vi.mock("@/hooks/useConfirmDialog.js", () => ({ useConfirmDialog: () => h.confirm }));
vi.mock("@/lib/zcodeDraftSkillInvalidation.js", () => ({
  invalidateDeferredDraftSessionForSkillChange: vi.fn(async () => undefined),
}));
vi.mock("@/lib/skillStoreRefresh.js", () => ({
  refreshSharedSkillStoreForWorkspace: vi.fn(async () => undefined),
}));
vi.mock("@/ControlHintTooltip.js", () => ({
  ControlHintTooltip: ({ children }: { children: ReactNode }) => children,
}));
vi.mock("@/settings/ExternalAgentImportDialog.js", () => ({ SkillsImportDialog: () => null }));
vi.mock("@/settings/RemoteSyncActions.js", async (importOriginal) => ({
  ...(await importOriginal<typeof RemoteSyncActionsModule>()),
  RemoteSyncDialogs: () => null,
}));

function mount() {
  return render(
    createElement(
      ZCodeIntlProvider,
      { initialLocale: "en-US" },
      createElement(SkillsSection, {
        workspacePath: "/workspace",
        workspaceIdentity: "remote:wsl:Ubuntu:/workspace",
        remoteSessionId: "remote-session",
        remoteTarget: { kind: "wsl", distro: "Ubuntu", user: "alice" },
        scopeFilter: "workspace",
        searchQuery: "",
        onCreateTask: h.onCreateTask,
      }),
    ),
  );
}
function skill(native: boolean): SkillSummary {
  return {
    id: native ? "/workspace/.agents/skills/review/SKILL.md" : "glm:review",
    name: "repo-review",
    description: "Review a repository",
    body: "Review instructions",
    path: native
      ? "/workspace/.agents/skills/review/SKILL.md"
      : "/workspace/.zcode/skills/review/SKILL.md",
    scope: "workspace",
    enabled: true,
    ...(native
      ? {
          source: {
            provider: "custom",
            providerName: "Shared",
            path: "/shared/review/SKILL.md",
            level: "native" as const,
          },
        }
      : {}),
  };
}

beforeEach(() => {
  vi.clearAllMocks();
  h.result = { skills: [], capability: { userScopeAvailable: true }, diagnostics: [] };
  h.list.mockImplementation(async () => h.result);
  h.getSkillReferenceCatalog.mockImplementation(async () => ({
    authority: "workspace",
    skills: h.result.skills
      .filter((item) => item.enabled)
      .map((item) => ({
        id: item.id,
        name: item.name,
        description: item.description,
        path: item.path,
        scope: item.scope,
        enabled: true as const,
      })),
  }));
  h.setEnabled.mockImplementation(async ({ skillId, enabled }) => {
    h.result = {
      ...h.result,
      skills: h.result.skills.map((item) => (item.id === skillId ? { ...item, enabled } : item)),
    };
  });
});
afterEach(cleanup);

describe("SkillsSection service-driven lifecycle", () => {
  it.each([true, false])("workspace toggle uses capability scope (native: %s)", async (native) => {
    const item = skill(native);
    h.result = {
      skills: [item],
      diagnostics: [],
      capability: {
        userScopeAvailable: true,
        ...(native ? { toggleScope: "profile" as const } : {}),
      },
    };
    const view = mount();
    const toggle = await screen.findByRole("switch");
    expect(view.container.querySelector('[data-skill-toggle-scope="profile"]') !== null).toBe(
      native,
    );
    fireEvent.click(toggle);
    await waitFor(() =>
      expect(h.setEnabled).toHaveBeenCalledWith({
        workspacePath: "/workspace",
        workspaceIdentity: "remote:wsl:Ubuntu:/workspace",
        provider: "glm",
        scope: native ? "user" : "workspace",
        skillId: item.id,
        enabled: false,
      }),
    );
    await waitFor(() =>
      expect(screen.getByRole("switch").getAttribute("aria-checked")).toBe("false"),
    );
    expect(h.list.mock.calls.length).toBeGreaterThan(1);
  });

  it("keeps unsupported controls visible and disabled while displaying actual Shared source", async () => {
    h.result = {
      skills: [skill(true)],
      diagnostics: [],
      capability: { userScopeAvailable: true, toggleScope: "profile" },
      sharedDirectory: { path: "/shared", readOnly: true },
    };
    const view = mount();
    await screen.findByRole("switch");
    const source = view.container.querySelector('[data-skill-source="shared"]');
    expect(source?.textContent).toContain("/shared/review/SKILL.md");
    expect(source?.textContent).toContain("Ubuntu");
    expect(
      view.container.querySelector('[data-skill-shared-directory="true"]')?.textContent,
    ).toContain("/shared");
    const create = view.container.querySelector<HTMLButtonElement>(
      '[data-settings-create-action="settings.skills.create.open"]',
    );
    const remove = screen.getByRole("button", { name: "Delete" }) as HTMLButtonElement;
    const sync = screen.getByRole("button", { name: "Sync Skill" }) as HTMLButtonElement;
    expect(create?.disabled).toBe(true);
    expect(remove.disabled).toBe(true);
    expect(sync?.disabled).toBe(true);
    const more = screen.getByRole("button", { name: "More actions" });
    fireEvent.keyDown(more, { key: "Enter" });
    const importAction = await screen.findByRole("menuitem");
    expect(importAction.getAttribute("data-disabled")).not.toBeNull();
    fireEvent.keyDown(importAction, { key: "Escape" });
    await waitFor(() => expect(screen.queryByRole("menuitem")).toBeNull());
    fireEvent.click(screen.getByRole("button", { name: /repo-review/ }));
    const open = await screen.findByRole("button", { name: "Open" });
    expect((open as HTMLButtonElement).disabled).toBe(true);
    fireEvent.click(create!);
    fireEvent.click(remove);
    fireEvent.click(open);
    expect(h.onCreateTask).not.toHaveBeenCalled();
    expect(h.deleteSkill).not.toHaveBeenCalled();
    expect(h.openInFileManager).not.toHaveBeenCalled();
    expect(h.setEnabled).not.toHaveBeenCalled();
  });

  it.each([true, false])(
    "mention catalog retains execution identity without path admission (native: %s)",
    async (native) => {
      const item = skill(native);
      h.result = { ...h.result, skills: [item] };
      const { result } = renderHook(
        () =>
          useSkillsMentionProvider(
            "/workspace",
            "remote:wsl:Ubuntu:/workspace",
            null,
            "",
            true,
            false,
            "Empty",
            "Skills",
          ),
        {
          wrapper: ({ children }: { children: ReactNode }) =>
            createElement(ZCodeIntlProvider, { initialLocale: "en-US" }, children),
        },
      );

      await waitFor(() => expect(result.current.items).toHaveLength(1));
      expect(result.current.items[0]).toMatchObject({
        id: `skill:${item.id}`,
        value: item.name,
        data: { path: item.path, scope: item.scope },
      });
      expect(h.getSkillReferenceCatalog).toHaveBeenCalledWith({
        workspacePath: "/workspace",
        workspaceIdentity: "remote:wsl:Ubuntu:/workspace",
      });
      const catalog = await h.getSkillReferenceCatalog.mock.results[0]!.value;
      expect(buildSkillSuggestions(catalog.skills, "en-US")[0]).toMatchObject({
        id: `skill:${item.id}`,
        value: item.name,
        data: { path: item.path, scope: item.scope },
      });
    },
  );
});

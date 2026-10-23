// @vitest-environment jsdom
import { createElement } from "react";
import { act, cleanup, fireEvent, render, waitFor } from "@testing-library/react";
import { afterEach, expect, it, vi } from "vitest";
import type {
  OmpModelRef,
  OmpRoleDescriptor,
  OmpTeamConfig,
  ZCodeSessionStateSnapshot,
} from "@zcode/shared";
import type { OmpConfigurationPanelService } from "@/omp-configuration/contract.js";
import { OmpConfigurationController, OmpConfigurationPanel } from "@/omp-configuration/module.js";
import { ZCodeIntlProvider } from "@/i18n/IntlProvider.js";
import type { OmpProfileService } from "@/omp-configuration/contract.js";
import { OmpWorkspaceProfiles } from "@/omp-configuration/TeamPage.js";
import type { OmpProfileState } from "@zcode/shared";

afterEach(cleanup);

it.each(["all", "team-only"] as const)(
  "keeps %s editing disabled until the native baseline, then previews and saves with its revision",
  async (mode) => {
    const model = { provider: "fixture", modelId: "chat" };
    const team: OmpTeamConfig = {
      profile: null,
      revision: "initial-native-revision",
      userMembers: [{ index: 0, rawSelector: "fixture/chat", model, status: "available" }],
      persistentMembers: null,
      effectiveMembers: [model],
      source: "global",
      sessionModel: null,
      participants: [],
      issues: [],
      writableScopes: ["user"],
      storage: {
        mode: "single",
        syncState: "not_applicable",
        active: { readState: "present" },
        persistent: { readState: "not_applicable" },
      },
    };
    const baseline = Promise.withResolvers<OmpTeamConfig>();
    const configureOmpTeam = vi.fn<OmpConfigurationPanelService["configureOmpTeam"]>(
      async ({ request }) => {
        if (request.operation === "get_team_config") {
          if (request.preview)
            return {
              operation: request.operation,
              data: {
                ...team,
                preview: {
                  clientRevision: request.preview.clientRevision,
                  userMembers: [],
                  effectiveMembers: [],
                  source: "global",
                  participants: [],
                  issues: [],
                },
              },
            };
          return { operation: request.operation, data: await baseline.promise };
        }
        if (request.operation === "get_team_models")
          return {
            operation: request.operation,
            data: { models: [{ model, name: "Chat", selectable: true }] },
          };
        if (request.operation === "set_team_config")
          return {
            operation: request.operation,
            data: {
              saveState: "complete",
              writes: { active: { status: "saved" }, persistent: { status: "not_applicable" } },
              config: { ...team, revision: "saved-native-revision", userMembers: [] },
              effectiveMatchesRequested: true,
            },
          };
        throw new Error(`Unexpected operation: ${request.operation}`);
      },
    );
    const configureOmpSession = vi.fn<OmpConfigurationPanelService["configureOmpSession"]>(
      async () => ({ operation: "get_model_roles", data: { roles: [] } }),
    );
    const service: OmpConfigurationPanelService = {
      configureOmpSession,
      configureOmpTeam,
      setModel: vi.fn<OmpConfigurationPanelService["setModel"]>(),
      onDynamicWorkspaceConfigFrame: () => () => ({ dispose() {} }),
      onAgentRuntimeRestarted: () => ({ dispose() {} }),
    };
    const view = render(
      createElement(ZCodeIntlProvider, {
        initialLocale: "en-US",
        children: createElement(OmpConfigurationPanel, {
          workspacePath: "/initial",
          sessionId: "native-session",
          service,
          mode,
          onClose: vi.fn(),
        }),
      }),
    );
    const restore = view.getByTestId("omp-team-default") as HTMLButtonElement;
    expect(Boolean(view.queryByTestId("omp-role-panel"))).toBe(mode === "all");
    expect(Boolean(view.queryByTestId("omp-temporary-model"))).toBe(mode === "all");
    expect(view.queryByTestId("omp-team-task")).toBeNull();
    expect(view.queryByTestId("omp-team-start")).toBeNull();
    expect(view.queryByTestId("omp-team-run")).toBeNull();
    expect(restore.matches(":disabled")).toBe(true);
    expect(view.getByTestId("omp-team-save").matches(":disabled")).toBe(true);
    expect(view.getByTestId("omp-config-refresh").matches(":disabled")).toBe(false);
    expect(view.getByTestId("omp-config-cancel").matches(":disabled")).toBe(false);
    act(() => {
      restore.click();
      (view.getByTestId("omp-team-save") as HTMLButtonElement).click();
    });
    expect(
      configureOmpTeam.mock.calls.some(
        ([{ request }]) => request.operation === "get_team_config" && request.preview,
      ),
    ).toBe(false);
    expect(
      configureOmpTeam.mock.calls.some(([{ request }]) => request.operation.startsWith("set_")),
    ).toBe(false);
    await act(async () => {
      baseline.resolve(team);
      await baseline.promise;
    });
    await waitFor(() => expect(restore.matches(":disabled")).toBe(false));
    expect(view.getByTestId("omp-team-member-0").querySelector("select")!.value).toBe(
      JSON.stringify(model),
    );
    expect(view.getByTestId("omp-team-save").matches(":disabled")).toBe(true);
    fireEvent.click(restore);
    await waitFor(() => expect(view.getByTestId("omp-team-save").matches(":disabled")).toBe(false));
    expect(
      configureOmpTeam.mock.calls.some(
        ([{ request }]) =>
          request.operation === "get_team_config" && request.preview?.members?.length === 0,
      ),
    ).toBe(true);
    fireEvent.click(view.getByTestId("omp-team-save"));
    await waitFor(() =>
      expect(view.getByTestId("omp-team-receipt").getAttribute("data-save-state")).toBe("complete"),
    );
    expect(configureOmpTeam).toHaveBeenCalledWith({
      workspacePath: "/initial",
      workspaceIdentity: undefined,
      request: {
        operation: "set_team_config",
        scope: "user",
        expectedRevision: "initial-native-revision",
        members: [],
      },
    });
  },
);

it("retains the mounted target's notice and dirty draft when composer callbacks change", async () => {
  const model = { provider: "fixture", modelId: "chat" };
  const team: OmpTeamConfig = {
    profile: null,
    revision: "r1",
    userMembers: [
      {
        index: 0,
        rawSelector: "old invalid",
        model: null,
        status: "unresolved",
        reason: "missing",
      },
    ],
    persistentMembers: null,
    effectiveMembers: [],
    source: "global",
    sessionModel: null,
    participants: [],
    issues: [],
    writableScopes: ["user"],
    storage: {
      mode: "single",
      syncState: "not_applicable",
      active: { readState: "present" },
      persistent: { readState: "not_applicable" },
    },
  };
  const configureOmpTeam = vi.fn<OmpConfigurationPanelService["configureOmpTeam"]>(
    async ({ request: p }) => {
      if (p.operation === "get_team_config")
        return {
          operation: p.operation,
          data: {
            ...team,
            ...(p.preview
              ? {
                  preview: {
                    clientRevision: p.preview.clientRevision,
                    userMembers: [],
                    effectiveMembers: [],
                    source: "global",
                    participants: [],
                    issues: [],
                  },
                }
              : {}),
          },
        };
      if (p.operation === "get_team_models")
        return {
          operation: p.operation,
          data: { models: [{ model, name: "Chat", selectable: true }] },
        };
      throw new Error("unexpected save");
    },
  );
  const configureOmpSession = vi.fn<OmpConfigurationPanelService["configureOmpSession"]>(
    async () => ({ operation: "get_model_roles", data: { roles: [] } }),
  );
  const setModel = vi.fn<OmpConfigurationPanelService["setModel"]>();
  const service: OmpConfigurationPanelService = {
    configureOmpSession,
    configureOmpTeam,
    setModel,
    onDynamicWorkspaceConfigFrame: () => () => ({ dispose() {} }),
    onAgentRuntimeRestarted: () => ({ dispose() {} }),
  };
  const pending = Promise.withResolvers<ZCodeSessionStateSnapshot>();
  setModel.mockReturnValueOnce(pending.promise);
  const before = vi.fn();
  const after = vi.fn();
  const target = { workspacePath: "/a", workspaceIdentity: "workspace-a", sessionId: "a" };
  const panel = (selected: (model: OmpModelRef) => void, sessionId = target.sessionId) =>
    createElement(ZCodeIntlProvider, {
      initialLocale: "en-US",
      children: createElement(OmpConfigurationPanel, {
        service,
        ...target,
        sessionId,
        onClose: vi.fn(),
        onTemporaryModelSelected: selected,
      }),
    });
  const view = render(panel(before));
  const temporary = view.getByTestId("omp-temporary-model") as HTMLSelectElement;
  await waitFor(() => expect(temporary.options).toHaveLength(2));
  const member = view.getByTestId("omp-team-member-0").querySelector("select")!;
  fireEvent.change(member, { target: { value: JSON.stringify(model) } });
  fireEvent.change(temporary, { target: { value: JSON.stringify(model) } });
  expect(setModel).toHaveBeenCalledExactlyOnceWith({
    ...target,
    model: { providerId: model.provider, modelId: model.modelId },
    persistAsWorkspaceLastUsed: false,
  });
  expect(view.queryByTestId("omp-config-notice")).toBeNull();
  view.rerender(panel(after));
  await act(async () => {
    pending.resolve({} as ZCodeSessionStateSnapshot);
    await pending.promise;
  });
  await waitFor(() =>
    expect(view.getByTestId("omp-config-notice").getAttribute("data-message-id")).toBe(
      "omp.configuration.temporaryModelSwitched",
    ),
  );
  expect(before).not.toHaveBeenCalled();
  expect(after).toHaveBeenCalledExactlyOnceWith(model);
  view.rerender(panel(vi.fn()));
  expect(view.getByTestId("omp-config-notice").getAttribute("data-message-id")).toBe(
    "omp.configuration.temporaryModelSwitched",
  );
  expect(view.getByTestId("omp-team-member-0").querySelector("select")!.value).toBe(
    JSON.stringify(model),
  );
  expect(configureOmpSession.mock.calls.some(([p]) => p.operation.startsWith("set_"))).toBe(false);
  const stale = Promise.withResolvers<ZCodeSessionStateSnapshot>();
  setModel.mockReturnValueOnce(stale.promise);
  fireEvent.change(temporary, { target: { value: JSON.stringify(model) } });
  const peer = vi.fn();
  view.rerender(panel(peer, "b"));
  await act(async () => {
    stale.resolve({} as ZCodeSessionStateSnapshot);
    await stale.promise;
  });
  expect(peer).not.toHaveBeenCalled();
  expect(view.queryByTestId("omp-config-notice")).toBeNull();
});

it.each(["all", "roles-only"] as const)("preserves native roles in %s", async (mode) => {
  const model = { provider: "fixture", modelId: "chat" };
  const roles: OmpRoleDescriptor[] = ["default", "smol", "slow"].map((roleId) => ({
    roleId,
    name: roleId,
    configurable: true,
    userValue: null,
    projectValue: null,
    candidateModels: [model],
    source: "default",
    writableScopes: ["user"],
    hidden: false,
    section: "chat",
    revision: `${roleId}-r1`,
  }));
  const custom = { ...roles[0]!, roleId: "custom-reviewer", revision: "custom-r1" };
  const team: OmpTeamConfig = {
    profile: null,
    revision: "team-r1",
    userMembers: null,
    persistentMembers: null,
    effectiveMembers: [],
    source: "global",
    sessionModel: null,
    participants: [],
    issues: [],
    writableScopes: ["user"],
    storage: {
      mode: "single",
      syncState: "not_applicable",
      active: { readState: "present" },
      persistent: { readState: "not_applicable" },
    },
  };
  const configureOmpSession = vi.fn<OmpConfigurationPanelService["configureOmpSession"]>(
    async (params) => {
      if (params.operation === "get_model_roles")
        return { operation: params.operation, data: { roles: params.roleId ? [custom] : roles } };
      if (params.operation === "set_model_role")
        return {
          operation: params.operation,
          data: { role: { ...roles[0]!, revision: "default-r2" }, persisted: true },
        };
      throw new Error("unexpected operation");
    },
  );
  const service: OmpConfigurationPanelService = {
    configureOmpSession,
    configureOmpTeam: vi.fn<OmpConfigurationPanelService["configureOmpTeam"]>(
      async ({ request }) => {
        if (request.operation === "get_team_config")
          return { operation: request.operation, data: team };
        if (request.operation === "get_team_models")
          return {
            operation: request.operation,
            data: { models: [{ model, name: "Chat", selectable: true }] },
          };
        throw new Error("unexpected global save");
      },
    ),
    setModel: vi.fn<OmpConfigurationPanelService["setModel"]>(),
    onDynamicWorkspaceConfigFrame: () => () => ({ dispose() {} }),
    onAgentRuntimeRestarted: () => ({ dispose() {} }),
  };
  const view = render(
    createElement(ZCodeIntlProvider, {
      initialLocale: "en-US",
      children: createElement(OmpConfigurationPanel, {
        service,
        workspacePath: "/a",
        workspaceIdentity: "workspace-a",
        sessionId: "a",
        ...(mode === "all" ? { mode, onClose: vi.fn() } : { mode }),
      }),
    }),
  );
  expect(Boolean(view.queryByTestId("omp-team-panel"))).toBe(mode === "all");
  expect(Boolean(view.queryByTestId("omp-temporary-model"))).toBe(mode === "all");
  expect(Boolean(view.queryByRole("dialog"))).toBe(mode === "all");
  await waitFor(() => expect(view.getByTestId("omp-role-select-default")).toBeTruthy());
  fireEvent.change(view.getByTestId("omp-role-select-default"), {
    target: { value: JSON.stringify(model) },
  });
  expect((view.getByTestId("omp-role-save-default") as HTMLButtonElement).disabled).toBe(false);
  fireEvent.change(view.getByRole("textbox", { name: "New custom role" }), {
    target: { value: custom.roleId },
  });
  fireEvent.click(view.getByRole("button", { name: "Add custom role" }));
  await waitFor(() => expect(view.getByTestId(`omp-role-${custom.roleId}`)).toBeTruthy());
  for (const role of roles) {
    expect(view.getByTestId(`omp-role-${role.roleId}`)).toBeTruthy();
  }
  expect((view.getByTestId("omp-role-select-default") as HTMLSelectElement).value).toBe(
    JSON.stringify(model),
  );
  expect((view.getByTestId("omp-role-save-default") as HTMLButtonElement).disabled).toBe(false);
  expect(configureOmpSession.mock.calls.some(([p]) => p.operation.startsWith("set_"))).toBe(false);
  fireEvent.click(view.getByTestId("omp-role-save-default"));
  await waitFor(() =>
    expect(configureOmpSession).toHaveBeenCalledWith({
      workspacePath: "/a",
      workspaceIdentity: "workspace-a",
      sessionId: "a",
      operation: "set_model_role",
      roleId: "default",
      scope: "user",
      expectedRevision: "default-r1",
      selection: { kind: "model", model },
    }),
  );
});

it("merges a custom-only role lookup without hiding the standard directory or rebasing dirty roles", async () => {
  const model = { provider: "fixture", modelId: "chat" };
  const roles: OmpRoleDescriptor[] = ["default", "smol", "slow"].map((roleId) => ({
    roleId,
    name: roleId,
    configurable: true,
    userValue: null,
    projectValue: null,
    candidateModels: [model],
    source: "default",
    writableScopes: ["user"],
    hidden: false,
    section: "chat",
    revision: `${roleId}-r1`,
  }));
  const configureOmpSession = vi.fn<OmpConfigurationPanelService["configureOmpSession"]>(
    async (params) => {
      if (params.operation === "get_model_roles")
        return { operation: params.operation, data: { roles } };
      throw new Error("unexpected save");
    },
  );
  const configureOmpTeam = vi.fn<OmpConfigurationPanelService["configureOmpTeam"]>(
    async ({ request }) => {
      if (request.operation === "get_team_models")
        return {
          operation: request.operation,
          data: { models: [{ model, name: "Chat", selectable: true }] },
        };
      if (request.operation === "get_team_config")
        return {
          operation: request.operation,
          data: {
            profile: null,
            revision: "team-r1",
            userMembers: null,
            persistentMembers: null,
            effectiveMembers: [],
            source: "global",
            sessionModel: null,
            participants: [],
            issues: [],
            writableScopes: ["user"],
            storage: {
              mode: "single",
              syncState: "not_applicable",
              active: { readState: "present" },
              persistent: { readState: "not_applicable" },
            },
          },
        };
      throw new Error("unexpected global save");
    },
  );
  const controller = new OmpConfigurationController(
    {
      configureOmpTeam,
      configureOmpSession,
      setModel: vi.fn<OmpConfigurationPanelService["setModel"]>(),
    },
    { workspacePath: "/a", sessionId: "a" },
  );
  await controller.refresh();
  controller.setRole(roles[0]!, { kind: "model", model });
  const draft = controller.getSnapshot().roleDrafts.default;
  const custom = { ...roles[0]!, roleId: "custom-reviewer", revision: "custom-r1" };
  configureOmpSession.mockResolvedValueOnce({
    operation: "get_model_roles",
    data: { roles: [custom] },
  });
  await controller.addRole(custom.roleId);
  expect(controller.getSnapshot().roles).toEqual([...roles, custom]);
  expect(controller.getSnapshot().roleDrafts.default).toBe(draft);
  expect(draft?.expectedRevision).toBe("default-r1");
  configureOmpSession.mockResolvedValueOnce({
    operation: "get_model_roles",
    data: { roles: [{ ...roles[0]!, revision: "default-r2" }, custom] },
  });
  await controller.addRole(custom.roleId);
  expect(controller.getSnapshot().roles.map((role) => role.roleId)).toEqual([
    "default",
    "smol",
    "slow",
    custom.roleId,
  ]);
  expect(controller.getSnapshot().roles[0]?.revision).toBe("default-r2");
  expect(controller.getSnapshot().roleDrafts.default).toBe(draft);
  expect(configureOmpSession.mock.calls.some(([p]) => p.operation.startsWith("set_"))).toBe(false);
  configureOmpSession.mockResolvedValueOnce({
    operation: "set_model_role",
    data: { role: { ...roles[0]!, revision: "default-r3" }, persisted: true },
  });
  await controller.saveRole("default");
  expect(configureOmpSession).toHaveBeenLastCalledWith({
    workspacePath: "/a",
    sessionId: "a",
    operation: "set_model_role",
    roleId: "default",
    scope: "user",
    expectedRevision: "default-r1",
    selection: { kind: "model", model },
  });
});

it.each(["all", "team-only"] as const)(
  "retains visible disabled %s controls and the native unsupported reason",
  async (mode) => {
    const configureOmpSession = vi.fn<OmpConfigurationPanelService["configureOmpSession"]>(
      async () => {
        throw Object.assign(new Error("Native session/configure is unsupported"), { code: -32601 });
      },
    );
    const onClose = vi.fn();
    const service: OmpConfigurationPanelService = {
      configureOmpSession,
      configureOmpTeam: vi.fn<OmpConfigurationPanelService["configureOmpTeam"]>(async () => {
        throw Object.assign(new Error("Native omp/team/configure is unsupported"), {
          code: -32601,
        });
      }),
      setModel: vi.fn<OmpConfigurationPanelService["setModel"]>(),
      onDynamicWorkspaceConfigFrame: () => () => ({ dispose() {} }),
      onAgentRuntimeRestarted: () => ({ dispose() {} }),
    };
    const view = render(
      createElement(ZCodeIntlProvider, {
        initialLocale: "en-US",
        children: createElement(OmpConfigurationPanel, {
          workspacePath: "/unsupported",
          sessionId: "native-session",
          service,
          mode,
          onClose,
        }),
      }),
    );
    await waitFor(() =>
      expect(view.getByTestId("omp-config-unsupported").textContent).not.toBe(""),
    );
    expect(view.getByTestId("omp-configuration-panel")).toBeTruthy();
    expect(view.getByTestId("omp-team-panel")).toBeTruthy();
    expect(Boolean(view.queryByTestId("omp-role-panel"))).toBe(mode === "all");
    expect(view.getByTestId("omp-config-controls").getAttribute("disabled")).not.toBeNull();
    expect(view.getByTestId("omp-team-model-search").matches(":disabled")).toBe(true);
    expect(view.getByTestId("omp-team-default").matches(":disabled")).toBe(true);
    expect(view.getByTestId("omp-team-save").matches(":disabled")).toBe(true);
    expect(
      mode === "all"
        ? view.getByTestId("omp-temporary-model").matches(":disabled")
        : view.queryByTestId("omp-temporary-model") === null,
    ).toBe(true);
    expect(view.queryByTestId("omp-team-member-0")).toBeNull();
    expect(view.getByTestId("omp-team-model-catalog").querySelector("button")).toBeNull();
    expect(view.getByTestId("omp-config-refresh").matches(":disabled")).toBe(false);
    expect(view.getByTestId("omp-config-cancel").matches(":disabled")).toBe(false);
    expect(
      configureOmpSession.mock.calls.every(([request]) => !request.operation.startsWith("set_")),
    ).toBe(true);
    fireEvent.click(view.getByTestId("omp-config-cancel"));
    if (mode === "all") expect(onClose).toHaveBeenCalledOnce();
    else {
      await waitFor(() => expect(view.getByTestId("omp-config-unsupported")).toBeTruthy());
      expect(view.queryByRole("dialog")).toBeNull();
      expect(view.getByTestId("omp-team-save").matches(":disabled")).toBe(true);
    }
  },
);

it("selects workspace profiles without a session, keeps active separate from next-start, and ignores late old-workspace saves", async () => {
  const initial: OmpProfileState = {
    selectedProfile: null,
    activeProfile: null,
    profiles: [
      { name: null, active: true },
      { name: "profile-b", active: false },
    ],
    runtimeIdentity: "runtime-a",
    blockers: [],
    pending: false,
    supported: true,
  };
  const pending = Promise.withResolvers<OmpProfileState>();
  const selectOmpProfile = vi
    .fn<OmpProfileService["selectOmpProfile"]>()
    .mockReturnValue(pending.promise);
  const service: OmpProfileService = {
    getOmpProfiles: vi.fn(async (target) =>
      target.workspacePath === "/b"
        ? {
            ...initial,
            activeProfile: "profile-b",
            selectedProfile: "profile-b",
            runtimeIdentity: "runtime-b",
          }
        : initial,
    ),
    selectOmpProfile,
    onAgentRuntimeRestarted: () => ({ dispose() {} }),
  };
  const panel = (workspacePath: string) =>
    createElement(ZCodeIntlProvider, {
      initialLocale: "en-US",
      children: createElement(OmpWorkspaceProfiles, { service, workspacePath }),
    });
  const view = render(panel("/a"));
  await waitFor(() =>
    expect(view.getByTestId("omp-profile-select").matches(":disabled")).toBe(false),
  );
  fireEvent.change(view.getByTestId("omp-profile-select"), { target: { value: "profile-b" } });
  fireEvent.click(view.getByTestId("omp-profile-save-next"));
  expect(selectOmpProfile).toHaveBeenCalledExactlyOnceWith({
    workspacePath: "/a",
    workspaceIdentity: undefined,
    profile: "profile-b",
    expectedRuntimeIdentity: "runtime-a",
    apply: "next-start",
  });
  expect((view.getByTestId("omp-profile-select") as HTMLSelectElement).value).toBe("profile-b");
  expect(view.getByTestId("omp-profile-state").getAttribute("data-selected-profile")).toBe(
    "default",
  );
  expect(view.getByTestId("omp-profile-state").getAttribute("data-active-profile")).toBe("default");
  view.rerender(panel("/b"));
  await waitFor(() =>
    expect(view.getByTestId("omp-profile-state").getAttribute("data-runtime-identity")).toBe(
      "runtime-b",
    ),
  );
  await act(async () => {
    pending.resolve({ ...initial, selectedProfile: "profile-b" });
    await pending.promise;
  });
  expect(view.getByTestId("omp-profile-state").getAttribute("data-runtime-identity")).toBe(
    "runtime-b",
  );
  expect(view.getByTestId("omp-profile-state").getAttribute("data-active-profile")).toBe(
    "profile-b",
  );
  expect(view.getByTestId("omp-profile-state").getAttribute("data-selected-profile")).toBe(
    "profile-b",
  );
  expect((view.getByTestId("omp-profile-select") as HTMLSelectElement).value).toBe("profile-b");
});

it("keeps unsupported profile controls visible and offers no hot-switch action while native work runs", async () => {
  const initial: OmpProfileState = {
    selectedProfile: null,
    activeProfile: null,
    profiles: [{ name: null, active: true }],
    runtimeIdentity: "runtime",
    pending: false,
    supported: true,
    blockers: [{ code: "running", message: "A native turn is running" }],
  };
  const getOmpProfiles = vi.fn<OmpProfileService["getOmpProfiles"]>().mockResolvedValue(initial);
  const service: OmpProfileService = {
    getOmpProfiles,
    selectOmpProfile: vi.fn(),
    onAgentRuntimeRestarted: () => ({ dispose() {} }),
  };
  const view = render(
    createElement(ZCodeIntlProvider, {
      initialLocale: "en-US",
      children: createElement(OmpWorkspaceProfiles, { workspacePath: "/a", service }),
    }),
  );
  await waitFor(() =>
    expect(view.getByTestId("omp-profile-save-next").matches(":disabled")).toBe(false),
  );
  expect(view.queryByTestId("omp-profile-apply-now")).toBeNull();
  expect(view.getByText("running: A native turn is running")).toBeTruthy();
  getOmpProfiles.mockResolvedValue({
    ...initial,
    supported: false,
    reason: "Native profiles unsupported",
  });
  fireEvent.click(view.getByTestId("omp-profile-refresh"));
  await waitFor(() => expect(view.getByText("Native profiles unsupported")).toBeTruthy());
  expect(view.getByTestId("omp-profile-select").matches(":disabled")).toBe(true);
  expect(view.getByTestId("omp-profile-new-name").matches(":disabled")).toBe(true);
  expect(service.selectOmpProfile).not.toHaveBeenCalled();
});

it("does not acknowledge a failed new-profile save or replay it on reload", async () => {
  const initial: OmpProfileState = {
    selectedProfile: null,
    activeProfile: null,
    profiles: [{ name: null, active: true }],
    runtimeIdentity: "r1",
    blockers: [],
    pending: false,
    supported: true,
  };
  const service: OmpProfileService = {
    getOmpProfiles: vi.fn(async () => initial),
    selectOmpProfile: vi.fn(async () => {
      throw new Error("Invalid native profile name");
    }),
    onAgentRuntimeRestarted: () => ({ dispose() {} }),
  };
  const view = render(
    createElement(ZCodeIntlProvider, {
      initialLocale: "en-US",
      children: createElement(OmpWorkspaceProfiles, { workspacePath: "/a", service }),
    }),
  );
  await waitFor(() =>
    expect(view.getByTestId("omp-profile-new-name").matches(":disabled")).toBe(false),
  );
  fireEvent.change(view.getByTestId("omp-profile-new-name"), { target: { value: "../invalid" } });
  fireEvent.click(view.getByTestId("omp-profile-save-next"));
  await waitFor(() =>
    expect(view.getByTestId("omp-profile-error").textContent).toContain(
      "Invalid native profile name",
    ),
  );
  expect(view.getByTestId("omp-profile-state").getAttribute("data-selected-profile")).toBe(
    "default",
  );
  fireEvent.click(view.getByTestId("omp-profile-refresh"));
  await waitFor(() => expect(view.queryByTestId("omp-profile-error")).toBeNull());
  expect(service.selectOmpProfile).toHaveBeenCalledTimes(1);
});

it("blocks global Team and persistent role writes while a saved profile awaits restart and rechecks before a stale save", async () => {
  const model = { provider: "fixture", modelId: "chat" };
  const role: OmpRoleDescriptor = {
    roleId: "smol",
    name: "smol",
    configurable: true,
    hidden: false,
    userValue: null,
    projectValue: null,
    candidateModels: [model],
    source: "default",
    writableScopes: ["user"],
    section: "chat",
    revision: "r1",
  };
  const team: OmpTeamConfig = {
    profile: null,
    revision: "r1",
    userMembers: null,
    persistentMembers: null,
    effectiveMembers: [],
    source: "global",
    sessionModel: null,
    participants: [],
    issues: [],
    writableScopes: ["user"],
    storage: {
      mode: "single",
      syncState: "not_applicable",
      active: { readState: "present" },
      persistent: { readState: "not_applicable" },
    },
  };
  const pending: OmpProfileState = {
    selectedProfile: "next",
    activeProfile: null,
    profiles: [{ name: null, active: true }],
    runtimeIdentity: "old-runtime",
    blockers: [],
    pending: false,
    supported: true,
  };
  const getOmpProfiles = vi.fn<OmpProfileService["getOmpProfiles"]>().mockResolvedValue(pending);
  const configureOmpSession = vi.fn<OmpConfigurationPanelService["configureOmpSession"]>(
    async (params) => {
      if (params.operation === "get_model_roles")
        return { operation: params.operation, data: { roles: [role] } };
      throw new Error("Must not save to the old native profile");
    },
  );
  const service: OmpConfigurationPanelService = {
    getOmpProfiles,
    configureOmpSession,
    configureOmpTeam: vi.fn<OmpConfigurationPanelService["configureOmpTeam"]>(
      async ({ request }) => {
        if (request.operation === "get_team_config")
          return { operation: request.operation, data: team };
        if (request.operation === "get_team_models")
          return {
            operation: request.operation,
            data: { models: [{ model, name: "chat", selectable: true }] },
          };
        throw new Error("Must not save to the old native profile");
      },
    ),
    setModel: vi.fn(),
    onDynamicWorkspaceConfigFrame: () => () => ({ dispose() {} }),
    onAgentRuntimeRestarted: () => ({ dispose() {} }),
  };
  const view = render(
    createElement(ZCodeIntlProvider, {
      initialLocale: "en-US",
      children: createElement(OmpConfigurationPanel, {
        service,
        workspacePath: "/a",
        sessionId: "a",
        onClose: vi.fn(),
      }),
    }),
  );
  await waitFor(() =>
    expect(view.getByTestId("omp-role-select-smol").matches(":disabled")).toBe(true),
  );
  expect(view.getByTestId("omp-role-profile-pending").textContent).toContain(
    "takes effect after restart",
  );
  fireEvent.click(view.getByTestId("omp-team-default"));
  expect(view.getByTestId("omp-team-save").matches(":disabled")).toBe(true);
  getOmpProfiles.mockResolvedValue({ ...pending, selectedProfile: null });
  fireEvent.click(view.getByTestId("omp-config-refresh"));
  await waitFor(() =>
    expect(view.getByTestId("omp-role-select-smol").matches(":disabled")).toBe(false),
  );
  fireEvent.change(view.getByTestId("omp-role-select-smol"), { target: { value: "auto" } });
  getOmpProfiles.mockResolvedValue(pending);
  fireEvent.click(view.getByTestId("omp-role-save-smol"));
  await waitFor(() =>
    expect(view.getByTestId("omp-role-profile-pending").textContent).toContain(
      "takes effect after restart",
    ),
  );
  expect(view.getByTestId("omp-role-save-smol").matches(":disabled")).toBe(true);
  expect(view.getByTestId("omp-team-save").matches(":disabled")).toBe(true);
  expect(
    vi
      .mocked(service.configureOmpTeam)
      .mock.calls.some(([{ request }]) => request.operation === "set_team_config"),
  ).toBe(false);
  expect(
    configureOmpSession.mock.calls.some(([params]) => params.operation === "set_model_role"),
  ).toBe(false);
});

it("exposes native roles inline without the Team editor or temporary model controls", async () => {
  const team: OmpTeamConfig = {
    profile: null,
    revision: "native-r1",
    userMembers: null,
    persistentMembers: null,
    effectiveMembers: [],
    source: "global",
    sessionModel: null,
    participants: [],
    issues: [],
    writableScopes: ["user"],
    storage: {
      mode: "single",
      syncState: "not_applicable",
      active: { readState: "present" },
      persistent: { readState: "not_applicable" },
    },
  };
  const configureOmpSession = vi.fn<OmpConfigurationPanelService["configureOmpSession"]>(
    async () => ({ operation: "get_model_roles", data: { roles: [] } }),
  );
  const service: OmpConfigurationPanelService = {
    configureOmpSession,
    configureOmpTeam: async ({ request }) => {
      if (request.operation === "get_team_config")
        return { operation: request.operation, data: team };
      if (request.operation === "get_team_models")
        return { operation: request.operation, data: { models: [] } };
      throw new Error("Role management must not write Team settings");
    },
    setModel: vi.fn(),
    onDynamicWorkspaceConfigFrame: () => () => ({ dispose() {} }),
    onAgentRuntimeRestarted: () => ({ dispose() {} }),
  };
  const view = render(
    createElement(ZCodeIntlProvider, {
      initialLocale: "en-US",
      children: createElement(OmpConfigurationPanel, {
        service,
        workspacePath: "/native",
        workspaceIdentity: "remote-native",
        sessionId: "existing-session",
        mode: "roles-only",
      }),
    }),
  );
  await waitFor(() =>
    expect(configureOmpSession).toHaveBeenCalledWith({
      workspacePath: "/native",
      workspaceIdentity: "remote-native",
      sessionId: "existing-session",
      operation: "get_model_roles",
    }),
  );
  expect(view.getByTestId("omp-role-panel")).toBeTruthy();
  expect(view.getByTestId("omp-custom-role-id")).toBeTruthy();
  expect(view.queryByTestId("omp-team-panel")).toBeNull();
  expect(view.queryByTestId("omp-temporary-model")).toBeNull();
  expect(view.queryByRole("dialog")).toBeNull();
});

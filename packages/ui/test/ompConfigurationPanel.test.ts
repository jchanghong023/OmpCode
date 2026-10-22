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

afterEach(cleanup);

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
  const configureOmpSession = vi.fn<OmpConfigurationPanelService["configureOmpSession"]>(
    async (p) => {
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
      if (p.operation === "get_model_roles") return { operation: p.operation, data: { roles: [] } };
      throw new Error("unexpected save");
    },
  );
  const setModel = vi.fn<OmpConfigurationPanelService["setModel"]>();
  const service: OmpConfigurationPanelService = {
    configureOmpSession,
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

it("keeps dirty standard role controls available after adding a custom-only lookup result", async () => {
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
      if (params.operation === "get_team_config")
        return { operation: params.operation, data: team };
      if (params.operation === "get_team_models")
        return {
          operation: params.operation,
          data: { models: [{ model, name: "Chat", selectable: true }] },
        };
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
        onClose: vi.fn(),
      }),
    }),
  );
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
      if (params.operation === "get_team_models")
        return {
          operation: params.operation,
          data: { models: [{ model, name: "Chat", selectable: true }] },
        };
      if (params.operation === "get_team_config")
        return {
          operation: params.operation,
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
      throw new Error("unexpected save");
    },
  );
  const controller = new OmpConfigurationController(
    { configureOmpSession, setModel: vi.fn<OmpConfigurationPanelService["setModel"]>() },
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

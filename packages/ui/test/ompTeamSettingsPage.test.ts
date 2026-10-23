// @vitest-environment jsdom
import { createElement } from "react";
import { cleanup, fireEvent, render, waitFor } from "@testing-library/react";
import { afterEach, expect, it, vi } from "vitest";
import type { IZCodeAgentService } from "@zcode/services";
import type { OmpTeamConfig } from "@zcode/shared";
import type { OmpConfigurationPanelService } from "@/omp-configuration/contract.js";
import { TeamPage } from "@/omp-configuration/TeamPage.js";
import { OmpConfigurationController } from "@/omp-configuration/module.js";
import { ZCodeIntlProvider } from "@/i18n/IntlProvider.js";
import { useZCodeAgentService } from "@/hooks/useZCodeAgentService.js";

vi.mock("@/hooks/useZCodeAgentService.js", () => ({ useZCodeAgentService: vi.fn() }));
afterEach(cleanup);

function fixture(userMembers: OmpTeamConfig["userMembers"] = []) {
  const model = { provider: "fixture", modelId: "chat" };
  const other = { provider: "fixture", modelId: "review" };
  const team: OmpTeamConfig = {
    profile: null,
    revision: "r1",
    userMembers,
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
  const service = {
    configureOmpTeam: vi.fn<OmpConfigurationPanelService["configureOmpTeam"]>(
      async ({ request }) => {
        if (request.operation === "get_team_config")
          return {
            operation: request.operation,
            data: {
              ...team,
              ...(request.preview
                ? {
                    preview: {
                      clientRevision: request.preview.clientRevision,
                      userMembers: [],
                      effectiveMembers: [],
                      source: "global" as const,
                      participants: [],
                      issues: [],
                    },
                  }
                : {}),
            },
          };
        if (request.operation === "get_team_models")
          return {
            operation: request.operation,
            data: {
              models: [
                {
                  model: { provider: "unconfigured", modelId: "aaa-unavailable" },
                  name: "Unconfigured model",
                  selectable: false,
                  reason: "Provider authentication is not configured",
                },
                ...[model, other].map((model) => ({
                  model,
                  name: model.modelId,
                  selectable: true,
                })),
              ],
            },
          };
        return {
          operation: request.operation,
          data: {
            saveState: "complete",
            writes: { active: { status: "saved" }, persistent: { status: "not_applicable" } },
            config: {
              ...team,
              revision: "r2",
              userMembers:
                request.members?.map((model, index) => ({
                  index,
                  model,
                  rawSelector: `${model.provider}/${model.modelId}`,
                  status: "available" as const,
                })) ?? null,
            },
            effectiveMatchesRequested: true,
          },
        };
      },
    ),
    configureOmpSession: vi.fn<OmpConfigurationPanelService["configureOmpSession"]>(),
    observeOmpTeam: vi.fn(),
    sendConversationCommandV4: vi.fn(),
    createSession: vi.fn(),
    setModel: vi.fn(),
    onDynamicWorkspaceConfigFrame: () => () => ({ dispose() {} }),
    onAgentRuntimeRestarted: () => ({ dispose() {} }),
  };
  vi.mocked(useZCodeAgentService).mockReturnValue(service as unknown as IZCodeAgentService);
  return { service, model, other };
}

it("routes every Team operation globally without a session and never requests roles or a temporary model", async () => {
  const { service, model } = fixture();
  const controller = new OmpConfigurationController(service, { workspacePath: "/global" });
  await controller.refresh();
  await controller.searchModels("chat");
  controller.setMembers([model, model]);
  await controller.preview();
  await controller.saveTeam();
  await controller.addRole("reviewer");
  await controller.saveRole("reviewer");
  await controller.switchTemporaryModel(model);
  expect(service.configureOmpTeam.mock.calls.map(([{ request }]) => request.operation)).toEqual([
    "get_team_config",
    "get_team_models",
    "get_team_models",
    "get_team_config",
    "set_team_config",
  ]);
  expect(service.configureOmpTeam.mock.calls.every(([target]) => !("sessionId" in target))).toBe(
    true,
  );
  expect(service.configureOmpSession).not.toHaveBeenCalled();
  expect(service.setModel).not.toHaveBeenCalled();
  expect(service.createSession).not.toHaveBeenCalled();
});

it("preserves invalid raw slots and edits without saving; cancel cannot save", async () => {
  const { service, model } = fixture([
    { index: 0, rawSelector: "old invalid", model: null, status: "unresolved", reason: "missing" },
  ]);
  const controller = new OmpConfigurationController(service, { workspacePath: "/global" });
  await controller.refresh();
  expect(controller.getSnapshot().members).toEqual([{ rawSelector: "old invalid" }]);
  controller.setMembers([model, model]);
  await controller.preview();
  expect(controller.getSnapshot().preview?.clientRevision).toBe(
    controller.getSnapshot().clientRevision,
  );
  controller.dispose();
  expect(
    service.configureOmpTeam.mock.calls.some(([{ request }]) =>
      request.operation.startsWith("set_"),
    ),
  ).toBe(false);
});

it("edits and saves globally ordered members without any session or discussion", async () => {
  const { service, model, other } = fixture();
  const view = render(
    createElement(ZCodeIntlProvider, {
      initialLocale: "en-US",
      children: createElement(TeamPage, { workspacePath: "/settings-only" }),
    }),
  );
  await waitFor(() =>
    expect(view.getByTestId("omp-team-panel").querySelector('[role="dialog"]')).toBeNull(),
  );
  expect(view.queryByRole("dialog")).toBeNull();
  expect(view.queryByTestId("omp-team-session-required")).toBeNull();
  const first = await waitFor(() => {
    const button = view
      .getByTestId("omp-team-model-catalog")
      .querySelector<HTMLButtonElement>('button[data-omp-model-id="chat"]');
    expect(button).not.toBeNull();
    expect(button!.matches(":disabled")).toBe(false);
    return button!;
  });
  const catalog = view.getByTestId("omp-team-model-catalog");
  expect(catalog.querySelector('[data-omp-model-provider="unconfigured"]')).toBeNull();
  fireEvent.click(view.getByTestId("omp-team-show-unavailable"));
  const unavailable = catalog.querySelector<HTMLButtonElement>(
    '[data-omp-model-provider="unconfigured"]',
  )!;
  expect(unavailable.matches(":disabled")).toBe(true);
  fireEvent.click(first);
  const second = view
    .getByTestId("omp-team-model-catalog")
    .querySelector<HTMLButtonElement>('button[data-omp-model-id="review"]')!;
  expect(second.matches(":disabled")).toBe(false);
  fireEvent.click(second);
  fireEvent.click(view.getByTestId("omp-team-copy-0"));
  fireEvent.click(view.getByRole("button", { name: "Move member 3 up" }));
  fireEvent.click(view.getByTestId("omp-team-save"));
  await waitFor(() =>
    expect(view.getByTestId("omp-team-receipt").getAttribute("data-save-state")).toBe("complete"),
  );
  expect(service.configureOmpTeam).toHaveBeenCalledWith({
    workspacePath: "/settings-only",
    workspaceIdentity: undefined,
    request: {
      operation: "set_team_config",
      scope: "user",
      expectedRevision: "r1",
      members: [model, other, model],
    },
  });
  expect(service.configureOmpSession).not.toHaveBeenCalled();
  expect(service.setModel).not.toHaveBeenCalled();
  expect(service.createSession).not.toHaveBeenCalled();
  expect(service.observeOmpTeam).not.toHaveBeenCalled();
  expect(service.sendConversationCommandV4).not.toHaveBeenCalled();
  expect(view.queryByTestId("omp-role-panel")).toBeNull();
  expect(view.queryByTestId("omp-temporary-model")).toBeNull();
  expect(view.queryByTestId("omp-team-start")).toBeNull();
});

it("cancels an edited global roster without saving or closing the settings page", async () => {
  const { service, model } = fixture([
    {
      index: 0,
      rawSelector: "fixture/chat",
      model: { provider: "fixture", modelId: "chat" },
      status: "available",
    },
  ]);
  const view = render(
    createElement(ZCodeIntlProvider, {
      initialLocale: "en-US",
      children: createElement(TeamPage, { workspacePath: "/settings-only" }),
    }),
  );
  const add = await waitFor(() => {
    const button = view
      .getByTestId("omp-team-model-catalog")
      .querySelector<HTMLButtonElement>('button[data-omp-model-id="review"]')!;
    expect(button?.matches(":disabled")).toBe(false);
    return button;
  });
  fireEvent.click(add);
  expect(view.getByTestId("omp-team-member-1")).toBeTruthy();
  fireEvent.click(view.getByTestId("omp-config-cancel"));
  await waitFor(() => {
    expect(view.queryByTestId("omp-team-member-1")).toBeNull();
    const select = view.getByTestId("omp-team-member-0").querySelector("select")!;
    expect(JSON.parse(select.value)).toEqual(model);
  });
  expect(view.getByTestId("omp-team-page")).toBeTruthy();
  expect(
    service.configureOmpTeam.mock.calls.some(
      ([{ request }]) => request.operation === "set_team_config",
    ),
  ).toBe(false);
  expect(service.createSession).not.toHaveBeenCalled();
});

it("keeps unsupported global settings visible without falling back to session configuration", async () => {
  const { service } = fixture();
  service.configureOmpTeam.mockRejectedValue(
    Object.assign(new Error("Native omp/team/configure is unsupported"), { code: -32601 }),
  );
  const view = render(
    createElement(ZCodeIntlProvider, {
      initialLocale: "en-US",
      children: createElement(TeamPage, {
        workspacePath: "/settings-only",
        sessionId: "existing-session",
      }),
    }),
  );
  await waitFor(() => expect(view.getByTestId("omp-config-unsupported")).toBeTruthy());
  expect(view.getByTestId("omp-team-save").matches(":disabled")).toBe(true);
  expect(view.queryByTestId("omp-role-panel")).toBeNull();
  expect(view.queryByTestId("omp-temporary-model")).toBeNull();
  fireEvent.click(view.getByTestId("omp-config-cancel"));
  expect(view.getByTestId("omp-team-page")).toBeTruthy();
  expect(view.queryByRole("dialog")).toBeNull();
  await waitFor(() => expect(view.getByTestId("omp-config-unsupported")).toBeTruthy());
  expect(service.configureOmpTeam.mock.calls.every(([target]) => !("sessionId" in target))).toBe(
    true,
  );
  expect(service.configureOmpSession).not.toHaveBeenCalled();
  expect(service.createSession).not.toHaveBeenCalled();
});

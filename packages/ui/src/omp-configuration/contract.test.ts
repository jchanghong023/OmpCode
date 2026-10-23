import { describe, expect, it, vi } from "vitest";
import type { ZCodeSessionStateSnapshot } from "@zcode/shared";
import type { OmpModelRef, OmpTeamConfig, ZCodeSessionConfigureResult } from "@zcode/shared";
import type { OmpConfigurationService } from "./contract.js";
import { OmpConfigurationController } from "./module.js";

const model = { provider: "fixture", modelId: "chat" };
function snapshot(revision = "r1"): OmpTeamConfig {
  return {
    profile: null,
    revision,
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
}
function fixture(onTemporaryModelSelected?: (model: OmpModelRef) => void) {
  const configureOmpTeam = vi.fn<OmpConfigurationService["configureOmpTeam"]>(
    async ({ request: p }) => {
      if (p.operation === "get_team_config")
        return {
          operation: p.operation,
          data: {
            ...snapshot(),
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
  const configureOmpSession = vi.fn<OmpConfigurationService["configureOmpSession"]>(async (p) => {
    if (p.operation === "get_model_roles") return { operation: p.operation, data: { roles: [] } };
    throw new Error("unexpected session save");
  });
  const setModel = vi
    .fn<OmpConfigurationService["setModel"]>()
    .mockResolvedValue({} as ZCodeSessionStateSnapshot);
  const controller = new OmpConfigurationController(
    { configureOmpTeam, configureOmpSession, setModel },
    { workspacePath: "/a", sessionId: "a" },
    onTemporaryModelSelected,
  );
  return { controller, configureOmpTeam, configureOmpSession, setModel };
}
describe("OMP configuration draft contract", () => {
  it("does not transplant a late temporary model into another composer generation", async () => {
    const selected = vi.fn();
    const { controller, setModel } = fixture(selected);
    const pending = Promise.withResolvers<ZCodeSessionStateSnapshot>();
    setModel.mockReturnValueOnce(pending.promise);
    const request = controller.switchTemporaryModel(model);
    controller.invalidate();
    pending.resolve({} as ZCodeSessionStateSnapshot);
    await request;
    expect(selected).not.toHaveBeenCalled();
  });
  it("keeps dirty draft and original CAS revision when external facts refresh", async () => {
    const { controller, configureOmpTeam } = fixture();
    await controller.refresh();
    controller.setMembers([model]);
    configureOmpTeam.mockResolvedValueOnce({
      operation: "get_team_config",
      data: snapshot("r2"),
    });
    await controller.refresh();
    expect(controller.getSnapshot().members).toEqual([model]);
    expect(controller.getSnapshot().expectedRevision).toBe("r1");
    expect(controller.getSnapshot().team?.revision).toBe("r2");
    expect(controller.getSnapshot().externalChange).toBe(true);
  });
  it("retains draft after conflict or partial receipt and never automatically replays", async () => {
    const { controller, configureOmpTeam } = fixture();
    await controller.refresh();
    controller.setMembers([model]);
    const data = {
      errorCode: "revision_conflict",
      saveState: "partial",
      writes: { active: { status: "saved" }, persistent: { status: "failed" } },
      config: snapshot("r2"),
    };
    configureOmpTeam.mockRejectedValueOnce(
      Object.assign(new Error("conflict"), { code: -32000, data }),
    );
    await controller.saveTeam();
    expect(controller.getSnapshot().receipt?.saveState).toBe("partial");
    expect(controller.getSnapshot().members).toEqual([model]);
    expect(controller.getSnapshot().errorCode).toBe("revision_conflict");
    expect(controller.getSnapshot().dirty).toBe(true);
    expect(controller.getSnapshot().requiresReadback).toBe(true);
    await controller.saveTeam();
    expect(
      configureOmpTeam.mock.calls.filter(([p]) => p.request.operation === "set_team_config"),
    ).toHaveLength(1);
  });
  it("discards stale preview and disposed session responses", async () => {
    const { controller, configureOmpTeam } = fixture();
    await controller.refresh();
    controller.setMembers([model]);
    const pending = Promise.withResolvers<ZCodeSessionConfigureResult>();
    configureOmpTeam.mockReturnValueOnce(pending.promise);
    const request = controller.preview();
    const revision = controller.getSnapshot().clientRevision;
    controller.setMembers([]);
    pending.resolve({
      operation: "get_team_config",
      data: {
        ...snapshot(),
        preview: {
          clientRevision: revision,
          userMembers: [],
          effectiveMembers: [],
          source: "global",
          participants: [],
          issues: [],
        },
      },
    });
    await request;
    expect(controller.getSnapshot().preview).toBeNull();
    const late = Promise.withResolvers<ZCodeSessionConfigureResult>();
    configureOmpTeam.mockReturnValueOnce(late.promise);
    const refresh = controller.refresh();
    controller.dispose();
    late.resolve({ operation: "get_team_config", data: snapshot("late") });
    await refresh;
    expect(controller.getSnapshot().team?.revision).not.toBe("late");
  });
  it("marks lost save outcome unknown and requires readback before another save", async () => {
    const { controller, configureOmpTeam } = fixture();
    await controller.refresh();
    controller.setMembers([model]);
    configureOmpTeam.mockRejectedValueOnce(new Error("connection closed"));
    await controller.saveTeam();
    expect(controller.getSnapshot().receipt?.saveState).toBe("unknown");
    expect(controller.getSnapshot().requiresReadback).toBe(true);
    await controller.saveTeam();
    expect(
      configureOmpTeam.mock.calls.filter(([p]) => p.request.operation === "set_team_config"),
    ).toHaveLength(1);
  });
  it("saves the complete ordered duplicate list with CAS and reports overrides", async () => {
    const { controller, configureOmpTeam, configureOmpSession } = fixture();
    await controller.refresh();
    controller.setMembers([model, model]);
    const config = {
      ...snapshot("r2"),
      userMembers: [0, 1].map((index) => ({
        index,
        rawSelector: "fixture/chat",
        model,
        status: "available" as const,
      })),
    };
    configureOmpTeam.mockResolvedValueOnce({
      operation: "set_team_config",
      data: {
        saveState: "complete",
        writes: { active: { status: "saved" }, persistent: { status: "not_applicable" } },
        config,
        effectiveMatchesRequested: false,
        effectiveNote: "project override",
      },
    });
    await controller.saveTeam();
    expect(configureOmpTeam).toHaveBeenLastCalledWith({
      workspacePath: "/a",
      workspaceIdentity: undefined,
      request: {
        operation: "set_team_config",
        scope: "user",
        expectedRevision: "r1",
        members: [model, model],
      },
    });
    expect(configureOmpSession.mock.calls.every(([p]) => p.operation === "get_model_roles")).toBe(
      true,
    );
    expect(controller.getSnapshot().dirty).toBe(false);
    expect(controller.getSnapshot().receipt?.effectiveMatchesRequested).toBe(false);
    expect(controller.getSnapshot().expectedRevision).toBe("r2");
  });
  it("invalidates in-flight results across connection generations and profile changes", async () => {
    const { controller, configureOmpTeam } = fixture();
    await controller.refresh();
    const pending = Promise.withResolvers<ZCodeSessionConfigureResult>();
    configureOmpTeam.mockReturnValueOnce(pending.promise);
    const request = controller.refresh();
    controller.invalidate();
    pending.resolve({ operation: "get_team_config", data: snapshot("old-generation") });
    await request;
    expect(controller.getSnapshot().team).toBeNull();
    const staleProfile = Promise.withResolvers<ZCodeSessionConfigureResult>();
    configureOmpTeam.mockReturnValueOnce(staleProfile.promise);
    const staleRequest = controller.refresh();
    configureOmpTeam.mockResolvedValueOnce({
      operation: "get_team_config",
      data: { ...snapshot("other-profile"), profile: "other" },
    });
    await controller.refresh();
    staleProfile.resolve({ operation: "get_team_config", data: snapshot("late-old-profile") });
    await staleRequest;
    expect(controller.getSnapshot().team?.profile).toBe("other");
    expect(controller.getSnapshot().team?.revision).toBe("other-profile");
    await controller.refresh();
    expect(controller.getSnapshot().team).toBeNull();
    expect(controller.getSnapshot().requiresReadback).toBe(true);
  });
});

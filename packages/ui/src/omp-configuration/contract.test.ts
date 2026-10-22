import { describe, expect, it, vi } from "vitest";
import type { ZCodeSessionStateSnapshot } from "@zcode/shared";
import type {
  OmpModelRef,
  OmpRoleDescriptor,
  OmpTeamConfig,
  ZCodeSessionConfigureResult,
} from "@zcode/shared";
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
  const configureOmpSession = vi.fn<OmpConfigurationService["configureOmpSession"]>(async (p) => {
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
    if (p.operation === "get_model_roles") return { operation: p.operation, data: { roles: [] } };
    throw new Error("unexpected save");
  });
  const setModel = vi
    .fn<OmpConfigurationService["setModel"]>()
    .mockResolvedValue({} as ZCodeSessionStateSnapshot);
  const controller = new OmpConfigurationController(
    { configureOmpSession, setModel },
    { workspacePath: "/a", sessionId: "a" },
    onTemporaryModelSelected,
  );
  return { controller, configureOmpSession, setModel };
}
describe("OMP configuration draft contract", () => {
  it("preserves invalid raw slots and edits without saving; cancel cannot save", async () => {
    const { controller, configureOmpSession } = fixture();
    await controller.refresh();
    expect(controller.getSnapshot().members).toEqual([{ rawSelector: "old invalid" }]);
    controller.setMembers([model, model]);
    await controller.preview();
    expect(controller.getSnapshot().preview?.clientRevision).toBe(
      controller.getSnapshot().clientRevision,
    );
    controller.dispose();
    expect(configureOmpSession.mock.calls.some(([p]) => p.operation.startsWith("set_"))).toBe(
      false,
    );
  });
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
    const { controller, configureOmpSession } = fixture();
    await controller.refresh();
    controller.setMembers([model]);
    configureOmpSession.mockResolvedValueOnce({
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
    const { controller, configureOmpSession } = fixture();
    await controller.refresh();
    controller.setMembers([model]);
    const data = {
      errorCode: "revision_conflict",
      saveState: "partial",
      writes: { active: { status: "saved" }, persistent: { status: "failed" } },
      config: snapshot("r2"),
    };
    configureOmpSession.mockRejectedValueOnce(
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
      configureOmpSession.mock.calls.filter(([p]) => p.operation === "set_team_config"),
    ).toHaveLength(1);
  });
  it("discards stale preview and disposed session responses", async () => {
    const { controller, configureOmpSession } = fixture();
    await controller.refresh();
    controller.setMembers([model]);
    const pending = Promise.withResolvers<ZCodeSessionConfigureResult>();
    configureOmpSession.mockReturnValueOnce(pending.promise);
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
    configureOmpSession.mockReturnValueOnce(late.promise);
    const refresh = controller.refresh();
    controller.dispose();
    late.resolve({ operation: "get_team_config", data: snapshot("late") });
    await refresh;
    expect(controller.getSnapshot().team?.revision).not.toBe("late");
  });
  it("marks lost save outcome unknown and requires readback before another save", async () => {
    const { controller, configureOmpSession } = fixture();
    await controller.refresh();
    controller.setMembers([model]);
    configureOmpSession.mockRejectedValueOnce(new Error("connection closed"));
    await controller.saveTeam();
    expect(controller.getSnapshot().receipt?.saveState).toBe("unknown");
    expect(controller.getSnapshot().requiresReadback).toBe(true);
    await controller.saveTeam();
    expect(
      configureOmpSession.mock.calls.filter(([p]) => p.operation === "set_team_config"),
    ).toHaveLength(1);
  });
  it("saves the complete ordered duplicate list with CAS and reports overrides", async () => {
    const { controller, configureOmpSession } = fixture();
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
    configureOmpSession.mockResolvedValueOnce({
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
    expect(configureOmpSession).toHaveBeenLastCalledWith({
      workspacePath: "/a",
      sessionId: "a",
      operation: "set_team_config",
      scope: "user",
      expectedRevision: "r1",
      members: [model, model],
    });
    expect(controller.getSnapshot().dirty).toBe(false);
    expect(controller.getSnapshot().receipt?.effectiveMatchesRequested).toBe(false);
    expect(controller.getSnapshot().expectedRevision).toBe("r2");
  });
  it("keeps role draft revision across refresh, then explicitly rebases and saves", async () => {
    const { controller, configureOmpSession } = fixture();
    await controller.refresh();
    const role: OmpRoleDescriptor = {
      roleId: "custom-reviewer",
      name: "Reviewer",
      configurable: true,
      userValue: null,
      projectValue: null,
      candidateModels: [model],
      source: "default",
      writableScopes: ["user"],
      hidden: false,
      section: "chat",
      revision: "role-r1",
    };
    configureOmpSession.mockResolvedValueOnce({
      operation: "get_model_roles",
      data: { roles: [role] },
    });
    await controller.addRole(role.roleId);
    controller.setRole(role, { kind: "model", model });
    configureOmpSession.mockResolvedValueOnce({
      operation: "get_model_roles",
      data: { roles: [{ ...role, revision: "role-r2" }] },
    });
    await controller.addRole(role.roleId);
    expect(controller.getSnapshot().roleDrafts[role.roleId]?.expectedRevision).toBe("role-r1");
    controller.rebase();
    configureOmpSession.mockResolvedValueOnce({
      operation: "set_model_role",
      data: { role: { ...role, revision: "role-r3" }, persisted: true },
    });
    await controller.saveRole(role.roleId);
    expect(configureOmpSession).toHaveBeenLastCalledWith({
      workspacePath: "/a",
      sessionId: "a",
      operation: "set_model_role",
      roleId: role.roleId,
      scope: "user",
      expectedRevision: "role-r2",
      selection: { kind: "model", model },
    });
    expect(controller.getSnapshot().roleDrafts[role.roleId]).toBeUndefined();
  });
  it("invalidates in-flight results across connection generations and profile changes", async () => {
    const { controller, configureOmpSession } = fixture();
    await controller.refresh();
    const pending = Promise.withResolvers<ZCodeSessionConfigureResult>();
    configureOmpSession.mockReturnValueOnce(pending.promise);
    const request = controller.refresh();
    controller.invalidate();
    pending.resolve({ operation: "get_team_config", data: snapshot("old-generation") });
    await request;
    expect(controller.getSnapshot().team?.revision).toBe("r1");
    expect(controller.getSnapshot().requiresReadback).toBe(true);
    configureOmpSession.mockResolvedValueOnce({
      operation: "get_team_config",
      data: { ...snapshot("other-profile"), profile: "other" },
    });
    await controller.refresh();
    expect(controller.getSnapshot().team?.profile).toBeNull();
    expect(controller.getSnapshot().requiresReadback).toBe(true);
    expect(controller.getSnapshot().busy).toBe(false);
  });
});

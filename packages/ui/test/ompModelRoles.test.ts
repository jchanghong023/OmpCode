import { describe, expect, it, vi } from "vitest";
import type { OmpRoleDescriptor } from "@zcode/shared";
import type { OmpConfigurationService } from "../src/omp-configuration/contract.js";
import { OmpConfigurationController } from "../src/omp-configuration/module.js";

const model = { provider: "fixture", modelId: "chat" };

function fixture() {
  const configureOmpTeam = vi.fn<OmpConfigurationService["configureOmpTeam"]>(
    async ({ request }) => {
      if (request.operation === "get_team_models") {
        return { operation: request.operation, data: { models: [] } };
      }
      if (request.operation === "get_team_config") {
        return {
          operation: request.operation,
          data: {
            profile: null,
            revision: "team-r1",
            userMembers: [],
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
      }
      throw new Error("unexpected team write in role test");
    },
  );
  const configureOmpSession = vi.fn<OmpConfigurationService["configureOmpSession"]>(
    async (request) => {
      if (request.operation === "get_model_roles") {
        return { operation: request.operation, data: { roles: [] } };
      }
      throw new Error("unexpected role save");
    },
  );
  const controller = new OmpConfigurationController(
    {
      configureOmpTeam,
      configureOmpSession,
      setModel: vi.fn<OmpConfigurationService["setModel"]>(),
    },
    { workspacePath: "/a", sessionId: "a" },
  );
  return { controller, configureOmpSession };
}

describe("OMP model role draft contract", () => {
  it("exposes native role conflicts without replay, then explicitly reads back, rebases and saves", async () => {
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
    // 真实 app-server 保留数字 RPC code，把 ModelRoleError.code 放入 data.code；不是 Team 的 errorCode。
    configureOmpSession.mockRejectedValueOnce(
      Object.assign(new Error('Model role "custom-reviewer" changed since it was read.'), {
        name: "ZCodeProtocolClientError",
        code: -32000,
        data: { code: "revision_conflict" },
      }),
    );
    await controller.saveRole(role.roleId);
    expect(controller.getSnapshot().errorCode).toBe("revision_conflict");
    expect(controller.getSnapshot().requiresReadback).toBe(true);
    expect(controller.getSnapshot().roleDrafts[role.roleId]).toEqual({
      expectedRevision: "role-r1",
      selection: { kind: "model", model },
    });
    await controller.saveRole(role.roleId);
    expect(
      configureOmpSession.mock.calls.filter(([p]) => p.operation === "set_model_role"),
    ).toHaveLength(1);
    controller.rebase();
    expect(controller.getSnapshot().roleDrafts[role.roleId]?.expectedRevision).toBe("role-r1");
    const externalRole = {
      ...role,
      userValue: "fixture/external-model-unavailable",
      revision: "role-r2",
    };
    configureOmpSession.mockResolvedValueOnce({
      operation: "get_model_roles",
      data: { roles: [externalRole] },
    });
    await controller.refresh();
    expect(controller.getSnapshot().requiresReadback).toBe(false);
    expect(controller.getSnapshot().externalChange).toBe(true);
    expect(controller.getSnapshot().roles).toEqual([externalRole]);
    expect(controller.getSnapshot().roleDrafts[role.roleId]).toEqual({
      expectedRevision: "role-r1",
      selection: { kind: "model", model },
    });
    expect(
      configureOmpSession.mock.calls.filter(([p]) => p.operation === "set_model_role"),
    ).toHaveLength(1);
    controller.rebase();
    expect(controller.getSnapshot().roleDrafts[role.roleId]).toEqual({
      expectedRevision: "role-r2",
      selection: { kind: "model", model },
    });
    configureOmpSession.mockResolvedValueOnce({
      operation: "set_model_role",
      data: { role: { ...role, revision: "role-r3" }, persisted: true },
    });
    await controller.saveRole(role.roleId);
    expect(configureOmpSession).toHaveBeenLastCalledWith({
      workspacePath: "/a",
      workspaceIdentity: undefined,
      sessionId: "a",
      operation: "set_model_role",
      roleId: role.roleId,
      scope: "user",
      expectedRevision: "role-r2",
      selection: { kind: "model", model },
    });
    expect(controller.getSnapshot().roleDrafts[role.roleId]).toBeUndefined();
  });
});

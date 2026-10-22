import { describe, expect, it, vi } from "vitest";
import type { SkillsListResult } from "@zcode/shared";
import { createSkillsService } from "../src/skills/skillsService.js";

const nativeResult: SkillsListResult = {
  skills: [
    {
      id: "/native/SKILL.md",
      name: "native",
      description: "Native skill",
      body: "Native body",
      path: "/native/SKILL.md",
      scope: "workspace",
      enabled: true,
    },
  ],
  capability: { userScopeAvailable: true, toggleScope: "profile" },
  diagnostics: [],
};

describe("native OMP skills service bridge", () => {
  it("reads native inventory using workspace identity without Host filesystem discovery", async () => {
    const manageNativeSkills = vi.fn(async () => nativeResult);
    const service = createSkillsService({ manageNativeSkills });
    expect(
      await service.list({ workspacePath: "/workspace", workspaceIdentity: "remote:one" }),
    ).toBe(nativeResult);
    expect(manageNativeSkills).toHaveBeenCalledWith({
      action: "list",
      workspacePath: "/workspace",
      workspaceIdentity: "remote:one",
    });
  });
  it("routes user-profile toggles and propagates native persistence failures", async () => {
    const manageNativeSkills = vi.fn(async () => nativeResult);
    const service = createSkillsService({ manageNativeSkills });
    const params = {
      workspacePath: "/workspace",
      workspaceIdentity: "identity",
      skillId: "/native/SKILL.md",
      enabled: false,
      scope: "user" as const,
    };
    await service.setEnabled(params);
    expect(manageNativeSkills).toHaveBeenCalledWith({ ...params, action: "setEnabled" });
    manageNativeSkills.mockRejectedValueOnce(new Error("Native config unwritable"));
    await expect(service.setEnabled(params)).rejects.toThrow("Native config unwritable");
  });
  it("rejects workspace and plugin persistence instead of silently changing the profile", async () => {
    const manageNativeSkills = vi.fn(async () => nativeResult);
    const service = createSkillsService({ manageNativeSkills });
    for (const scope of ["workspace", "plugin"] as const) {
      await expect(
        service.setEnabled({
          workspacePath: "/workspace",
          skillId: "skill",
          enabled: false,
          scope,
        }),
      ).rejects.toThrow("profile user layer");
    }
    expect(manageNativeSkills).not.toHaveBeenCalled();
  });
  it("reports unsupported mutations and never copies or deletes skill directories", async () => {
    const service = createSkillsService();
    const params = { workspacePath: "/workspace", skillId: "/shared/plugin/SKILL.md" };
    await expect(service.copyToCommon(params)).rejects.toThrow("unsupported");
    await expect(service.removeFromCommon(params)).rejects.toThrow("unsupported");
    await expect(service.deleteSkill(params)).rejects.toThrow("unsupported");
    await expect(service.list(params)).rejects.toThrow("unavailable");
  });
  it("leaves native reference admission and body injection to OMP", async () => {
    const manageNativeSkills = vi.fn(async () => nativeResult);
    const service = createSkillsService({ manageNativeSkills });
    const prompt = "Use $native";
    expect(await service.buildPromptContext({ workspacePath: "/workspace", prompt })).toEqual({
      prompt,
      activatedSkillNames: [],
    });
    expect(manageNativeSkills).not.toHaveBeenCalled();
  });
});

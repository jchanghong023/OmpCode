import type { SkillsListResult } from "@zcode/shared";
import type { ISkillsService, NativeSkillsManageParams } from "./skills.js";

interface SkillsServiceOptions {
  manageNativeSkills?: (params: NativeSkillsManageParams) => Promise<SkillsListResult>;
}

/** OMP owns discovery, enabled state and persistence; Host only routes management commands. */
export function createSkillsService(options?: SkillsServiceOptions): ISkillsService {
  const manage = (params: NativeSkillsManageParams) => {
    if (!options?.manageNativeSkills) {
      throw new Error("Native OMP skill management is unavailable in this Host");
    }
    return options.manageNativeSkills(params);
  };
  return {
    async list(params) {
      return manage({
        action: "list",
        workspacePath: params.workspacePath,
        workspaceIdentity: params.workspaceIdentity,
      });
    },
    async setEnabled(params) {
      // 资源来源 scope 不是持久化 scope；原生仅提供 profile 用户层写入口，不能静默写工作区。
      if (params.scope && params.scope !== "user") {
        throw new Error(
          "Skill toggles only support the current OMP profile user layer, not workspace/plugin persistence",
        );
      }
      await manage({
        action: "setEnabled",
        workspacePath: params.workspacePath,
        workspaceIdentity: params.workspaceIdentity,
        skillId: params.skillId,
        enabled: params.enabled,
        scope: "user",
      });
    },
    async buildPromptContext(params) {
      // 引用准入与技能正文由原生 prepareReferences/skill 资源承担，Host 不再二次注入正文。
      return { prompt: params.prompt, activatedSkillNames: [] };
    },
    async copyToCommon() {
      throw new Error("Copying skills is unsupported: OMP exposes no equivalent safe native API");
    },
    async removeFromCommon() {
      throw new Error("Removing skills is unsupported: OMP exposes no equivalent safe native API");
    },
    async deleteSkill() {
      throw new Error("Deleting skills is unsupported: OMP exposes no equivalent safe native API");
    },
  };
}

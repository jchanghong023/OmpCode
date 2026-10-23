import { z } from "zod";
import type { ZCodeProvider, SkillsPromptContext, SkillsListResult } from "@zcode/shared";
import { ServiceChannels } from "@zcode/shared";
import { createServiceDescriptor } from "../descriptors.js";

/** OMP bridge extension: no Session is created for management. */
export const nativeSkillsManageParamsSchema = z.discriminatedUnion("action", [
  z.object({ action: z.literal("list"), workspacePath: z.string().min(1) }).strict(),
  z.object({ action: z.literal("refresh"), workspacePath: z.string().min(1) }).strict(),
  z
    .object({
      action: z.literal("setEnabled"),
      workspacePath: z.string().min(1),
      skillId: z.string().min(1),
      enabled: z.boolean(),
      scope: z.enum(["user", "workspace"]).default("user"),
    })
    .strict(),
]);
export type NativeSkillsManageParams = z.input<typeof nativeSkillsManageParamsSchema> & {
  workspaceIdentity?: string;
};
export const nativeSkillsManageResultSchema = z
  .object({
    skills: z.array(
      z
        .object({
          id: z.string(),
          name: z.string(),
          description: z.string(),
          body: z.string(),
          path: z.string(),
          scope: z.enum(["workspace", "user", "plugin"]),
          enabled: z.boolean(),
          pluginName: z.string().optional(),
          source: z
            .object({
              provider: z.string(),
              providerName: z.string(),
              path: z.string(),
              level: z.enum(["user", "project", "native"]),
              origin: z.string().optional(),
              pluginName: z.string().optional(),
            })
            .strict(),
          disabledReason: z.enum(["item-disabled", "provider-disabled", "user-opt-in"]).optional(),
        })
        .strict(),
    ),
    capability: z
      .object({ userScopeAvailable: z.literal(true), toggleScope: z.literal("profile") })
      .strict(),
    diagnostics: z.array(
      z
        .object({
          code: z.literal("skill_read_failed"),
          severity: z.literal("warning"),
          message: z.string(),
          path: z.string(),
        })
        .strict(),
    ),
    sharedDirectory: z
      .object({ path: z.string(), readOnly: z.literal(true) })
      .strict()
      .optional(),
  })
  .strict();
export interface ISkillsService {
  list(params: {
    workspacePath: string;
    workspaceIdentity?: string;
    provider?: ZCodeProvider;
  }): Promise<SkillsListResult>;
  setEnabled(params: {
    workspacePath: string;
    workspaceIdentity?: string;
    provider?: ZCodeProvider;
    scope?: "workspace" | "user" | "plugin";
    skillId: string;
    enabled: boolean;
  }): Promise<void>;
  buildPromptContext(params: {
    workspacePath: string;
    workspaceIdentity?: string;
    provider?: ZCodeProvider;
    prompt: string;
  }): Promise<SkillsPromptContext>;
  /** OMP 无等价安全复制 API；当前桥接明确拒绝。 */
  copyToCommon(params: {
    workspacePath: string;
    workspaceIdentity?: string;
    skillId: string;
  }): Promise<{ newPath: string }>;
  /** OMP 无等价安全移除 API；当前桥接明确拒绝。 */
  removeFromCommon(params: {
    workspacePath: string;
    workspaceIdentity?: string;
    skillId: string;
  }): Promise<void>;
  /** OMP 无等价安全删除 API；不得直接删除共享或插件技能目录。 */
  deleteSkill(params: {
    workspacePath: string;
    workspaceIdentity?: string;
    skillId: string;
  }): Promise<void>;
}

export const ISkillsService = createServiceDescriptor<ISkillsService>(ServiceChannels.Skills);

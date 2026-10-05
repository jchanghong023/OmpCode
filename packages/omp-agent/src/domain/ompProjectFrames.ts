// OMP 项目模式 wire 帧契约（对端 = `omp --mode rpc-ui --rpc-project`）。
// 契约来源：oh-my-pi 仓库 docs-zh-CN/requirements/rpc-ui-protocol.md §13—§15 与
// packages/coding-agent/src/modes/rpc/rpc-project-types.ts。此处只声明本适配器消费的字段，
// 未知字段透传不拒帧（与 ompFrames.ts 同一原则）。

import { z } from "zod";

/** 项目模式 ready 帧（在 ompReadyFrameSchema 基础上追加的字段）。 */
export const ompProjectReadyInfoSchema = z
  .object({
    mode: z.literal("rpc-ui-project"),
    projectIdentity: z.object({ projectRoot: z.string() }).passthrough(),
    processInstanceId: z.string(),
    capabilities: z
      .object({
        multiSession: z.boolean().optional(),
        commandCompletion: z.boolean().optional(),
        executeCommand: z.boolean().optional(),
        skillManagement: z.boolean().optional(),
        subagentHistory: z.boolean().optional(),
        subagentControl: z.boolean().optional(),
        modelRoleConfig: z.boolean().optional(),
      })
      .passthrough(),
  })
  .passthrough();
export type OmpProjectReadyInfo = z.infer<typeof ompProjectReadyInfoSchema>;

/** 项目目录会话摘要（list_sessions / create_session / resume_session 返回）。 */
export const ompProjectSessionSummarySchema = z
  .object({
    sessionId: z.string(),
    name: z.string().optional(),
    sessionFile: z.string().optional(),
    loadState: z.string().optional(),
    runState: z.string().optional(),
    sessionGeneration: z.string().optional(),
    createdAt: z.string().optional(),
    modifiedAt: z.string().optional(),
    messageCount: z.number().optional(),
    revision: z.string().optional(),
  })
  .passthrough();
export type OmpProjectSessionSummary = z.infer<typeof ompProjectSessionSummarySchema>;

/** 分页信封（list_sessions / get_subagents 共用）。
 * 修复（协议对比）：真实 omp list_sessions 返回 sessions 键、get_subagents 返回
 * items 键（rpc-project-sessions.ts / rpc-project-subagents.ts），两键都声明。 */
export const ompProjectPageSchema = <T extends z.ZodTypeAny>(item: T) =>
  z
    .object({
      items: z.array(item).optional(),
      sessions: z.array(item).optional(),
      nextCursor: z.union([z.string(), z.number()]).optional(),
    })
    .passthrough();

/** complete_command 候选（rpc-ui-protocol §14.5）。 */
export const ompProjectCompletionItemSchema = z
  .object({
    label: z.string(),
    insertText: z.string(),
    replaceStart: z.number(),
    replaceEnd: z.number(),
    kind: z.string().optional(),
    description: z.string().optional(),
    hint: z.string().optional(),
  })
  .passthrough();
export type OmpProjectCompletionItem = z.infer<typeof ompProjectCompletionItemSchema>;

export const ompProjectCompletionResultSchema = z
  .object({
    items: z.array(ompProjectCompletionItemSchema).default([]),
    revision: z.string().optional(),
  })
  .passthrough();

/** get_model_roles 的 role 行（rpc-ui-protocol §14.7 RoleDescriptor）。 */
export const ompProjectRoleDescriptorSchema = z
  .object({
    roleId: z.string(),
    name: z.string().optional(),
    description: z.string().optional(),
    configurable: z.boolean().optional(),
    nonConfigurableReason: z.string().optional(),
    explicitValue: z.string().optional(),
    effectiveModel: z
      .object({
        provider: z.string().optional(),
        modelId: z.string().optional(),
        thinkingLevel: z.string().optional(),
      })
      .passthrough()
      .optional(),
    unresolvedReason: z.string().optional(),
    source: z.string().optional(),
    writableScopes: z.array(z.string()).optional(),
    hidden: z.boolean().optional(),
    section: z.string().optional(),
    revision: z.string().optional(),
  })
  .passthrough();
export type OmpProjectRoleDescriptor = z.infer<typeof ompProjectRoleDescriptorSchema>;

/** get_subagents 的子代理摘要（rpc-ui-protocol §14.8）。 */
export const ompProjectSubagentSummarySchema = z
  .object({
    subagentId: z.string(),
    name: z.string().optional(),
    agentSource: z.string().optional(),
    description: z.string().optional(),
    task: z.string().optional(),
    status: z.string().optional(),
    recordReadable: z.boolean().optional(),
    sessionFile: z.string().optional(),
    parentToolCallId: z.string().optional(),
    index: z.number().optional(),
    lastUpdate: z.string().optional(),
    availableActions: z.array(z.string()).optional(),
  })
  .passthrough();
export type OmpProjectSubagentSummary = z.infer<typeof ompProjectSubagentSummarySchema>;

/** get_subagent_messages 返回（含记录衔接与超限语义）。 */
export const ompProjectSubagentMessagesSchema = z
  .object({
    subagentId: z.string().optional(),
    sessionFile: z.string().optional(),
    fromByte: z.number().optional(),
    nextByte: z.number().optional(),
    reset: z.boolean().optional(),
    hasMore: z.boolean().optional(),
    entries: z.array(z.unknown()).optional(),
    messages: z.array(z.unknown()).optional(),
    recordTooLarge: z.object({ byteLength: z.number() }).optional(),
  })
  .passthrough();
export type OmpProjectSubagentMessages = z.infer<typeof ompProjectSubagentMessagesSchema>;

/** get_available_commands 目录行（项目级；ompCommands 投影消费其 name/source/input）。 */
export const ompProjectCommandDescriptorSchema = z
  .object({
    name: z.string(),
    aliases: z.array(z.string()).optional(),
    description: z.string().optional(),
    inputHint: z.string().optional(),
    subcommands: z.array(z.unknown()).optional(),
    source: z.string().optional(),
    execution: z.string().optional(),
    scope: z.string().optional(),
    availability: z.unknown().optional(),
  })
  .passthrough();
export type OmpProjectCommandDescriptor = z.infer<typeof ompProjectCommandDescriptorSchema>;

/** 项目级命令（我们 → omp；id 由适配器关联）。 */
export type OmpProjectCommand =
  | { type: "create_session"; name?: string }
  | { type: "list_sessions"; cursor?: string | number; limit?: number }
  | { type: "resume_session"; sessionId: string }
  | { type: "close_session"; sessionId: string; cancelRunning?: boolean }
  | { type: "rename_session"; sessionId: string; name: string; expectedRevision?: string }
  | {
      type: "delete_session";
      sessionId: string;
      cancelRunning?: boolean;
      expectedRevision?: string;
    }
  | { type: "get_available_commands"; sessionId?: string }
  | {
      type: "complete_command";
      text: string;
      cursor: number;
      sessionId?: string;
      catalogRevision?: string;
    }
  | {
      type: "execute_command";
      text: string;
      sessionId?: string;
      sessionGeneration?: string;
      catalogRevision?: string;
    }
  | {
      type: "list_skills";
      view: "management" | "effective";
      sessionId?: string;
      cursor?: number;
      limit?: number;
    }
  | {
      type: "set_skill_enabled";
      skillId: string;
      enabled: boolean;
      scope: "user" | "project";
      expectedRevision?: string;
    }
  | {
      type: "copy_skill";
      skillId: string;
      targetScope: "user" | "project";
      targetName: string;
      expectedRevision?: string;
    }
  | { type: "delete_skill"; skillId: string; expectedRevision?: string }
  | { type: "reload_skills"; scope: "user" | "project" }
  | { type: "get_model_roles"; sessionId?: string }
  | {
      type: "set_model_role";
      roleId: string;
      scope: "user";
      selection:
        | { kind: "model"; model: { provider: string; modelId: string; thinkingLevel?: string } }
        | { kind: "auto" }
        | null;
      expectedRevision?: string;
    }
  | { type: "get_available_models" }
  | { type: "get_available_thinking_levels" }
  | {
      type: "get_subagents";
      sessionId?: string;
      status?: "running" | "finished";
      cursor?: string | number;
      limit?: number;
    }
  | {
      type: "get_subagent_messages";
      sessionId: string;
      subagentId: string;
      fromByte?: number;
      maxBytes?: number;
    }
  | {
      type: "control_subagent";
      sessionId: string;
      subagentId: string;
      action: "send_message" | "stop";
      message?: string;
    };

/** 项目模式服务端事件帧（无会话归属的目录类事件）。 */
export const ompProjectEventFrameSchema = z.discriminatedUnion("type", [
  z.object({ type: z.literal("sessions_changed"), revision: z.string().optional() }),
  z.object({
    type: z.literal("skills_changed"),
    scope: z.string().optional(),
    revision: z.string().optional(),
  }),
  z.object({ type: z.literal("command_catalog_changed"), revision: z.string().optional() }),
  z.object({
    type: z.literal("operation_result"),
    operationId: z.string().optional(),
    requestId: z.string().optional(),
    status: z.string().optional(),
    error: z.string().optional(),
  }),
]);
export type OmpProjectEventFrame = z.infer<typeof ompProjectEventFrameSchema>;

/** 子代理只读详情的 UI 地址：`omp-subagent:<subagentId>@<parentSessionId>`。 */
export const OMP_SUBAGENT_VIEW_PREFIX = "omp-subagent:";
export function buildOmpSubagentViewId(parentSessionId: string, subagentId: string): string {
  return `${OMP_SUBAGENT_VIEW_PREFIX}${subagentId}@${parentSessionId}`;
}
export function parseOmpSubagentViewId(
  viewId: string,
): { parentSessionId: string; subagentId: string } | null {
  if (!viewId.startsWith(OMP_SUBAGENT_VIEW_PREFIX)) return null;
  const rest = viewId.slice(OMP_SUBAGENT_VIEW_PREFIX.length);
  const at = rest.lastIndexOf("@");
  if (at <= 0 || at >= rest.length - 1) return null;
  return { subagentId: rest.slice(0, at), parentSessionId: rest.slice(at + 1) };
}

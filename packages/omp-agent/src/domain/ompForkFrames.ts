// omp rpc-ui 协议 v3 fork surface（最小目录能力面）。
// 契约来源：oh-my-pi packages/coding-agent/src/modes/rpc/rpc-fork-types.ts
// （v18.8.0+fork.298 起，commit 52c88ca「slim to minimal upstream deltas」收敛）：
// 仅 negotiate_protocol v3 协商成功后 omp 才接受这些命令；未协商二进制回
// "Unknown command: <type>" 错误响应，调用方按能力缺失（-32601 语义）降级。
// v3 能力组：commandCompletion / modelRoleConfig / sessionDirectory。
// 富 ask 与审批已并入上游 extension_ui_request 载体（ompFrames.ts），不再有独立旁路帧。

import { z } from "zod";
import type { OmpExtensionUiResponseFrame } from "./ompFrames.js";

/** v3 协商响应的能力旗标（RPC_FORK_CAPABILITIES）。 */
export const ompForkCapabilitiesSchema = z.object({
  commandCompletion: z.boolean(),
  modelRoleConfig: z.boolean(),
  sessionDirectory: z.boolean(),
});
export type OmpForkCapabilities = z.infer<typeof ompForkCapabilitiesSchema>;

// ── 命令目录（v3 富目录：get_available_commands 协商 v3 后的响应形状）──
export const ompDirectoryCommandDescriptorSchema = z
  .object({
    name: z.string(),
    aliases: z.array(z.string()).optional(),
    description: z.string().optional(),
    /** v3 顶层输入提示（v1 形状是 input:{hint}，ompCommands 投影两形状兼容解析）。 */
    inputHint: z.string().optional(),
    subcommands: z.array(z.unknown()).optional(),
    source: z.string().optional(),
    /** "omp" = omp 可执行；"tui" = 仅终端运行时可执行（宿主不可执行）。 */
    execution: z.string().optional(),
    /** {available:true} 或 {available:false, reason:"tui_only"|"unsupported"|string}。 */
    availability: z.unknown().optional(),
  })
  .passthrough();
export type OmpDirectoryCommandDescriptor = z.infer<typeof ompDirectoryCommandDescriptorSchema>;

export const ompAvailableCommandsV3ResultSchema = z
  .object({
    commands: z.array(ompDirectoryCommandDescriptorSchema).default([]),
    revision: z.string().optional(),
  })
  .passthrough();
export type OmpAvailableCommandsV3Result = z.infer<typeof ompAvailableCommandsV3ResultSchema>;

// ── complete_command（动态补全，零执行副作用）──
export const ompCompletionItemSchema = z
  .object({
    label: z.string(),
    insertText: z.string(),
    /** 替换区间（UTF-16 码元，左闭右开）。 */
    replaceStart: z.number(),
    replaceEnd: z.number(),
    kind: z.string().optional(),
    description: z.string().optional(),
    hint: z.string().optional(),
  })
  .passthrough();
export type OmpCompletionItem = z.infer<typeof ompCompletionItemSchema>;

export const ompCompletionResultSchema = z
  .object({
    items: z.array(ompCompletionItemSchema).default([]),
    revision: z.string().optional(),
  })
  .passthrough();
export type OmpCompletionResult = z.infer<typeof ompCompletionResultSchema>;

// ── 模型角色（get_model_roles / set_model_role）──
export const ompModelRoleDescriptorSchema = z
  .object({
    roleId: z.string(),
    name: z.string().optional(),
    description: z.string().optional(),
    /** false 仅用于 omp 声明不可配置的内部 role。 */
    configurable: z.boolean().optional(),
    nonConfigurableReason: z.string().optional(),
    /** 显式配置值（`provider/modelId[:level]`、`*`），undefined = 未配置。 */
    explicitValue: z.string().optional(),
    userValue: z.string().nullable().optional(),
    projectValue: z.string().nullable().optional(),
    candidateModels: z
      .array(
        z
          .object({
            provider: z.string().optional(),
            modelId: z.string().optional(),
            thinkingLevel: z.string().optional(),
          })
          .passthrough(),
      )
      .optional(),
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
export type OmpModelRoleDescriptor = z.infer<typeof ompModelRoleDescriptorSchema>;

export const ompModelRolesResultSchema = z
  .object({
    roles: z.array(ompModelRoleDescriptorSchema).default([]),
    sessionModel: z.unknown().optional(),
  })
  .passthrough();
export type OmpModelRolesResult = z.infer<typeof ompModelRolesResultSchema>;

export type OmpModelRoleSelection =
  | { kind: "model"; model: { provider: string; modelId: string; thinkingLevel?: string } }
  | { kind: "auto" }
  | null;

export const ompSetModelRoleResultSchema = z
  .object({
    role: ompModelRoleDescriptorSchema,
    persisted: z.literal(true),
    effectiveNote: z.string().optional(),
  })
  .passthrough();
export type OmpSetModelRoleResult = z.infer<typeof ompSetModelRoleResultSchema>;

// ── 会话目录（list_sessions / rename_session / delete_session；按 cwd 过滤）──
export const ompSessionSummarySchema = z
  .object({
    sessionId: z.string(),
    name: z.string().optional(),
    sessionFile: z.string().optional(),
    /** true = 该条目是本进程承载的会话（目录进程 --no-session 恒 false）。 */
    current: z.boolean().optional(),
    createdAt: z.string().optional(),
    modifiedAt: z.string().optional(),
    messageCount: z.number().optional(),
    revision: z.string().optional(),
  })
  .passthrough();
export type OmpSessionSummary = z.infer<typeof ompSessionSummarySchema>;

export const ompListSessionsResultSchema = z
  .object({
    sessions: z.array(ompSessionSummarySchema).default([]),
  })
  .passthrough();
export type OmpListSessionsResult = z.infer<typeof ompListSessionsResultSchema>;

// ── v3 目录命令（我们 → omp；id 由适配器关联）──
export type OmpDirectoryCommand =
  | { type: "complete_command"; text: string; cursor: number }
  | { type: "get_model_roles" }
  | {
      type: "set_model_role";
      roleId: string;
      scope: "user";
      selection: OmpModelRoleSelection;
      expectedRevision?: string;
    }
  | { type: "list_sessions" }
  | { type: "rename_session"; sessionId: string; name: string; expectedRevision?: string }
  | { type: "delete_session"; sessionId: string; expectedRevision?: string };

/** 全部客户端 → omp 即时分发旁路帧（extension_ui_response 各变体，含富 ask 应答）。 */
export type OmpBypassFrame = OmpExtensionUiResponseFrame;

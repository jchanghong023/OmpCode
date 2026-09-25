// omp RPC 线协议帧 schema（对端 = 内嵌 omp 二进制，`omp --mode rpc`）。
// 契约来源：oh-my-pi 仓库 docs/rpc.md 与 packages/coding-agent/src/modes/rpc/rpc-types.ts。
// 事件载荷允许透传未知字段（omp 自身演进不应导致适配器拒帧），但我们消费的字段全部显式声明。

import { z } from "zod";

// ── 启动帧 ──
export const ompReadyFrameSchema = z.object({
  type: z.literal("ready"),
  protocolVersion: z.number(),
  supportedProtocolVersions: z.array(z.number()).optional(),
  maxFrameBytes: z.number().optional(),
  maxReassembledFrameBytes: z.number().optional(),
});
export type OmpReadyFrame = z.infer<typeof ompReadyFrameSchema>;

// ── v2 无损分片 ──
export const ompRpcChunkFrameSchema = z.object({
  type: z.literal("rpc_chunk"),
  chunkId: z.string(),
  index: z.number().int().nonnegative(),
  count: z.number().int().positive(),
  byteLength: z.number().int().positive(),
  data: z.string(),
});
export type OmpRpcChunkFrame = z.infer<typeof ompRpcChunkFrameSchema>;

// ── 响应 ──
export const ompResponseFrameSchema = z.object({
  id: z.string().nullable().optional(),
  type: z.literal("response"),
  command: z.string(),
  success: z.boolean(),
  data: z.unknown().optional(),
  error: z.string().optional(),
  code: z.string().optional(),
});
export type OmpResponseFrame = z.infer<typeof ompResponseFrameSchema>;

// ── 扩展 UI 请求（审批 select / 确认 / 输入 / 打开 URL）──
export const ompExtensionUiRequestFrameSchema = z.object({
  type: z.literal("extension_ui_request"),
  id: z.string(),
  method: z.enum(["select", "confirm", "input", "editor", "cancel", "notify", "setStatus", "setWidget", "setTitle", "set_editor_text", "open_url"]),
  title: z.string().optional(),
  message: z.string().optional(),
  prompt: z.string().optional(),
  placeholder: z.string().optional(),
  options: z.array(z.string()).optional(),
  optionDetails: z.array(z.object({ description: z.string().optional() })).optional(),
  url: z.string().optional(),
  launchUrl: z.string().optional(),
  instructions: z.string().optional(),
  timeout: z.number().optional(),
});
export type OmpExtensionUiRequestFrame = z.infer<typeof ompExtensionUiRequestFrameSchema>;

export type OmpExtensionUiResponseFrame =
  | { type: "extension_ui_response"; id: string; value: string }
  | { type: "extension_ui_response"; id: string; confirmed: boolean }
  | { type: "extension_ui_response"; id: string; cancelled: true; timedOut?: boolean };

// ── host tool / host uri（omp 回调宿主工具；当前适配器不注册 host 工具，仅容错识别）──
export const ompHostToolCallFrameSchema = z.object({
  type: z.literal("host_tool_call"),
  id: z.string(),
  toolCallId: z.string().optional(),
  toolName: z.string(),
  arguments: z.unknown().optional(),
});

// ── 会话事件（AgentSessionEvent 原样转发）──
const ompContentBlockSchema = z.object({
  type: z.string(),
  text: z.string().optional(),
  thinking: z.string().optional(),
  id: z.string().optional(),
  name: z.string().optional(),
  arguments: z.unknown().optional(),
}).passthrough();

export const ompAgentMessageSchema = z.object({
  role: z.string(),
  content: z.array(ompContentBlockSchema).optional(),
  usage: z
    .object({
      input: z.number().optional(),
      output: z.number().optional(),
      cacheRead: z.number().optional(),
      cacheWrite: z.number().optional(),
      inputTokens: z.number().optional(),
      outputTokens: z.number().optional(),
    })
    .passthrough()
    .optional(),
  provider: z.string().optional(),
  model: z.string().optional(),
  // 供应商失败事实（stopReason=error 时携带）；成功消息不带。
  stopReason: z.string().optional(),
  errorStatus: z.number().optional(),
  errorMessage: z.string().optional(),
}).passthrough();
export type OmpAgentMessage = z.infer<typeof ompAgentMessageSchema>;

export const ompAssistantMessageEventSchema = z.object({
  type: z.string(),
  contentIndex: z.number().optional(),
  delta: z.string().optional(),
  partial: ompAgentMessageSchema.optional(),
  toolCall: ompContentBlockSchema.optional(),
}).passthrough();
export type OmpAssistantMessageEvent = z.infer<typeof ompAssistantMessageEventSchema>;

export const ompAgentToolResultSchema = z.object({
  content: z.array(z.object({ type: z.string(), text: z.string().optional() }).passthrough()).optional(),
  isError: z.boolean().optional(),
}).passthrough();

export const ompSessionEventFrameSchema = z.discriminatedUnion("type", [
  z.object({ type: z.literal("agent_start") }),
  z.object({ type: z.literal("agent_end"), messages: z.array(ompAgentMessageSchema).optional(), isTerminal: z.boolean().optional() }),
  z.object({ type: z.literal("turn_start") }),
  z.object({ type: z.literal("turn_end"), message: ompAgentMessageSchema.optional() }),
  z.object({ type: z.literal("message_start"), message: ompAgentMessageSchema }),
  z.object({ type: z.literal("message_end"), message: ompAgentMessageSchema }),
  z.object({
    type: z.literal("message_update"),
    message: ompAgentMessageSchema,
    assistantMessageEvent: ompAssistantMessageEventSchema,
  }),
  z.object({
    type: z.literal("tool_execution_start"),
    toolCallId: z.string(),
    toolName: z.string(),
    args: z.unknown(),
    intent: z.string().optional(),
  }),
  z.object({
    type: z.literal("tool_execution_update"),
    toolCallId: z.string(),
    toolName: z.string(),
    args: z.unknown().optional(),
    partialResult: ompAgentToolResultSchema.optional(),
  }),
  z.object({
    type: z.literal("tool_execution_end"),
    toolCallId: z.string(),
    toolName: z.string(),
    result: ompAgentToolResultSchema.optional(),
    isError: z.boolean().optional(),
  }),
  z.object({ type: z.literal("auto_compaction_start") }),
  z.object({ type: z.literal("auto_compaction_end") }),
  z.object({ type: z.literal("model_changed"), model: z.object({ provider: z.string().optional(), id: z.string().optional() }).passthrough().optional() }),
  z.object({ type: z.literal("thinking_level_changed"), thinkingLevel: z.string().optional() }),
  z.object({ type: z.literal("notice"), level: z.string().optional(), message: z.string().optional() }),
]);
export type OmpSessionEventFrame = z.infer<typeof ompSessionEventFrameSchema>;

export const ompPromptResultFrameSchema = z.object({
  type: z.literal("prompt_result"),
  id: z.string().optional(),
  agentInvoked: z.boolean().optional(),
});
export type OmpPromptResultFrame = z.infer<typeof ompPromptResultFrameSchema>;

// ── 内置斜杠命令侧信道（docs/rpc.md「Builtin slash-command side channels」）──
// 本地命令（/help、/title 等）不产生 agent 生命周期事件：输出走 command_output，
// 结果经 prompt 响应的 data.agentInvoked:false 或异步 prompt_result 收口；
// /title、/model 等命令随后用 session_info_update / config_update 回投状态。
export const ompCommandOutputFrameSchema = z.object({
  type: z.literal("command_output"),
  text: z.string(),
});
export type OmpCommandOutputFrame = z.infer<typeof ompCommandOutputFrameSchema>;

export const ompSessionInfoUpdateFrameSchema = z.object({
  type: z.literal("session_info_update"),
  title: z.string().optional(),
  sessionId: z.string().optional(),
});
export type OmpSessionInfoUpdateFrame = z.infer<typeof ompSessionInfoUpdateFrameSchema>;

export const ompConfigUpdateFrameSchema = z.object({
  type: z.literal("config_update"),
  model: z.object({ provider: z.string().optional(), id: z.string().optional() }).passthrough().optional(),
  thinkingLevel: z.string().optional(),
});
export type OmpConfigUpdateFrame = z.infer<typeof ompConfigUpdateFrameSchema>;

export const ompAvailableCommandsFrameSchema = z.object({
  type: z.literal("available_commands_update"),
  commands: z.array(
    z.object({
      name: z.string(),
      source: z.string().optional(),
      aliases: z.array(z.string()).optional(),
      description: z.string().optional(),
      input: z.object({ hint: z.string().optional() }).passthrough().optional(),
      subcommands: z.array(z.unknown()).optional(),
    }).passthrough(),
  ),
});
export type OmpAvailableCommandsFrame = z.infer<typeof ompAvailableCommandsFrameSchema>;

// omp task 子代理事件；保留扩展字段，但身份与状态必须校验后才能进入会话投影。
export const ompSubagentFrameSchema = z.discriminatedUnion("type", [
  z.object({ type: z.literal("subagent_lifecycle"), payload: z.object({
    id: z.string().min(1), agent: z.string().min(1), status: z.enum(["started", "completed", "failed", "aborted"]),
    description: z.string().optional(), sessionFile: z.string().optional(), parentToolCallId: z.string().optional(), index: z.number().int().optional(),
  }).passthrough() }),
  z.object({ type: z.literal("subagent_progress"), payload: z.object({
    agent: z.string().min(1), task: z.string().optional(), assignment: z.string().optional(),
    parentToolCallId: z.string().optional(), sessionFile: z.string().optional(),
    progress: z.object({ id: z.string().min(1), status: z.string().optional(), recentOutput: z.array(z.string()).optional() }).passthrough(),
  }).passthrough() }),
  z.object({ type: z.literal("subagent_event"), payload: z.object({ id: z.string().min(1), event: z.unknown() }).passthrough() }),
]);
export type OmpSubagentFrame = z.infer<typeof ompSubagentFrameSchema>;

export const ompSubagentSnapshotSchema = z.object({
  id: z.string().min(1), agent: z.string().min(1), status: z.string(),
  description: z.string().optional(), task: z.string().optional(), assignment: z.string().optional(),
  sessionFile: z.string().optional(), lastUpdate: z.number().optional(), parentToolCallId: z.string().optional(),
}).passthrough();
export type OmpSubagentSnapshot = z.infer<typeof ompSubagentSnapshotSchema>;

// ── 入站命令（我们 → omp）──
export type OmpCommandFrame =
  | { id?: string; type: "prompt"; message: string; images?: unknown[]; streamingBehavior?: "steer" | "followUp" }
  | { id?: string; type: "steer"; message: string; images?: unknown[] }
  | { id?: string; type: "follow_up"; message: string; images?: unknown[] }
  | { id?: string; type: "abort" }
  | { id?: string; type: "new_session" }
  | { id?: string; type: "negotiate_protocol"; protocolVersion: number }
  | { id?: string; type: "get_state" }
  | { id?: string; type: "set_model"; provider: string; modelId: string }
  | { id?: string; type: "get_available_models" }
  | { id?: string; type: "get_available_commands" }
  | { id?: string; type: "set_thinking_level"; level: string }
  | { id?: string; type: "get_available_thinking_levels" }
  | { id?: string; type: "compact"; customInstructions?: string }
  | { id?: string; type: "set_auto_compaction"; enabled: boolean }
  | { id?: string; type: "switch_session"; sessionPath: string }
  | { id?: string; type: "set_session_name"; name: string }
  | { id?: string; type: "abort_bash" }
  | { id?: string; type: "set_subagent_subscription"; level: "off" | "progress" | "events" }
  | { id?: string; type: "get_subagents" }
  | { id?: string; type: "get_subagent_messages"; subagentId?: string; sessionFile?: string; fromByte?: number };

// ── get_state 响应载荷 ──
export const ompStateDataSchema = z.object({
  model: z.object({ provider: z.string().optional(), id: z.string().optional() }).passthrough().optional(),
  thinkingLevel: z.string().optional(),
  isStreaming: z.boolean().optional(),
  isCompacting: z.boolean().optional(),
  // omp 未创建会话文件或尚未命名时返回 null；拒绝整份 get_state 会丢失模型与自动压缩状态。
  sessionFile: z.string().nullable().optional(),
  sessionId: z.string().optional(),
  sessionName: z.string().nullable().optional(),
  messageCount: z.number().optional(),
  autoCompactionEnabled: z.boolean().optional(),
  contextUsage: z.object({ tokens: z.number().optional(), contextWindow: z.number().optional(), percent: z.number().optional() }).passthrough().optional(),
}).passthrough();
export type OmpStateData = z.infer<typeof ompStateDataSchema>;

export const ompModelCatalogEntrySchema = z.object({
  provider: z.string().optional(),
  id: z.string().optional(),
  name: z.string().optional(),
}).passthrough();
export type OmpModelCatalogEntry = z.infer<typeof ompModelCatalogEntrySchema>;

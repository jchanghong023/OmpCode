// omp 会话事件类帧 schema（自 ompFrames.ts 抽出，架构 maxFileLines=400）：本轮新增的
// 事件型 union 成员（auto_compaction_end 扩列、queue_update）、既有 prompt_result 终态帧
// （本轮 A1 扩列 status/sessionSettled/error）独立成模块；ompFrames 经 `export *` 保转出，
// 消费方 import 路径不变。
// 契约来源同 ompFrames：oh-my-pi docs/rpc.md 与 rpc-types.ts；载荷允许透传未知字段。

import { z } from "zod";

// omp agent-session-events.ts（v18.6）：auto_compaction_end 携带结果事实
// result/aborted/willRetry/errorMessage/skipped。全部 optional 兼容旧核无载荷帧；
// result 只判存在性，不深度解析（CompactionResult 形状随 omp 演进）。
export const ompAutoCompactionEndEventSchema = z
  .object({
    type: z.literal("auto_compaction_end"),
    aborted: z.boolean().optional(),
    willRetry: z.boolean().optional(),
    errorMessage: z.string().optional(),
    skipped: z.boolean().optional(),
    result: z.unknown().optional(),
  })
  .passthrough();

// omp 队列快照（agent-session-events.ts QueuedMessagesSnapshot：steering/followUp/
// liveSteered，enqueue/dequeue/remove 等变化时发出）。字段全部 optional（旧核无此事件、
// 新核也可能演进），消费侧按队列对账触发器使用，字段缺失时跳过对账。
export const ompQueueUpdateEventSchema = z
  .object({
    type: z.literal("queue_update"),
    steering: z.array(z.string()).optional(),
    followUp: z.array(z.string()).optional(),
    liveSteered: z.number().optional(),
  })
  .passthrough();

export const ompPromptResultFrameSchema = z
  .object({
    type: z.literal("prompt_result"),
    id: z.string().optional(),
    agentInvoked: z.boolean().optional(),
    // v18.3.1 起 prompt_result 携带终态（rpc-types.ts RpcPromptResultFrame）：
    // status ∈ completed/aborted/error、sessionSettled、error（结构化 {message,...}）。
    // status 用 z.string() 宽松接受未知枚举值（omp 演进不拒帧），消费侧只认已知值；
    // error 同时接受字符串与对象形态（协议定义是 RpcPromptError 对象）。
    status: z.string().optional(),
    sessionSettled: z.boolean().optional(),
    error: z
      .union([z.string(), z.object({ message: z.string().optional() }).passthrough()])
      .optional(),
  })
  .passthrough();
export type OmpPromptResultFrame = z.infer<typeof ompPromptResultFrameSchema>;

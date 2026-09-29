// omp rpc-ui 协议 v3 fork surface 帧（结构化审批 + 富 ask）。
// 契约来源：oh-my-pi packages/coding-agent/src/modes/rpc/rpc-fork-{types,permission,ask}.ts
// 与该仓库 docs-zh-CN/requirements/rpc-ui-protocol.md（4.1/4.3）。
// 仅 negotiate_protocol v3 协商成功后 omp 才下发这些帧；v1/v2 路径不接触本文件。

import { z } from "zod";

// ── 结构化工具审批（rpc-ui-protocol 4.1）──
export const ompPermissionRequestFrameSchema = z.object({
  type: z.literal("permission_request"),
  id: z.string(),
  toolCallId: z.string(),
  toolName: z.string(),
  tier: z.enum(["read", "write", "exec"]),
  reason: z.string().optional(),
  approvalMode: z.enum(["always-ask", "write", "yolo"]),
  details: z.array(z.string()),
  input: z.unknown(),
  origin: z.object({ subagentId: z.string(), agentType: z.string() }).optional(),
  prefixSuggestion: z.string().optional(),
});
export type OmpPermissionRequestFrame = z.infer<typeof ompPermissionRequestFrameSchema>;

export type OmpPermissionOptionId =
  | "allow_once"
  | "allow_session"
  | "allow_always"
  | "allow_always_prefix"
  | "reject_once"
  | "reject_always";

/** 客户端 → omp 旁路帧：审批应答（同 extension_ui_response 即时分发车道）。 */
export type OmpPermissionResponseFrame = {
  type: "permission_response";
  id: string;
  option: OmpPermissionOptionId;
  feedback?: string;
};

// ── 富 ask 答疑（rpc-ui-protocol 4.3）──
const ompAskOptionSchema = z.object({
  label: z.string(),
  description: z.string().optional(),
  preview: z.string().optional(),
});
const ompAskQuestionSchema = z.object({
  id: z.string(),
  question: z.string(),
  header: z.string().optional(),
  options: z.array(ompAskOptionSchema),
  multi: z.boolean().optional(),
  recommended: z.number().optional(),
});
export const ompAskRequestFrameSchema = z.object({
  type: z.literal("ask_request"),
  id: z.string(),
  questions: z.array(ompAskQuestionSchema).min(1),
  note: z.string().optional(),
  timeoutMs: z.number().optional(),
  deadlineAt: z.number().optional(),
});
export type OmpAskRequestFrame = z.infer<typeof ompAskRequestFrameSchema>;

export type OmpAskAnswer = { questionId: string; selected: string[]; other?: string };

/** 客户端 → omp 旁路帧：按题应答 / 转为对话 / 取消。 */
export type OmpAskResponseFrame =
  | { type: "ask_response"; id: string; answers: OmpAskAnswer[] }
  | { type: "ask_response"; id: string; chat: string | boolean }
  | { type: "ask_response"; id: string; cancelled: true };

/** 客户端 → omp 旁路帧：幂等暂停服务端倒计时（首次交互后发送）。 */
export type OmpAskPauseFrame = { type: "ask_pause"; targetId: string };

/** 全部客户端 → omp 即时分发旁路帧（写入口共用 respondUi 车道）。 */
export type OmpBypassFrame =
  | { type: "extension_ui_response"; id: string; value: string }
  | { type: "extension_ui_response"; id: string; confirmed: boolean }
  | { type: "extension_ui_response"; id: string; cancelled: true; timedOut?: boolean }
  | OmpPermissionResponseFrame
  | OmpAskResponseFrame
  | OmpAskPauseFrame;

// ── 工作区级查询命令（rpc-ui-protocol 5.6 A/B 档中本适配器消费的子集）──
// 客户端 → omp 常规命令（非旁路帧）；仅协商 v3 后 omp 才接受，未协商二进制回
// Unknown command 错误响应，调用方按能力缺失降级。
export type OmpForkQueryCommand =
  | { id?: string; type: "test_model"; provider: string; modelId: string }
  | { id?: string; type: "list_mcp_servers" };

/** test_model 响应（RpcForkModelTestResult）：六类失败归因。 */
export const ompModelTestResultSchema = z.object({
  ok: z.boolean(),
  latencyMs: z.number(),
  error: z
    .object({
      category: z.enum([
        "auth_failed",
        "model_not_found",
        "rate_limited",
        "network",
        "server",
        "endpoint_not_configured",
      ]),
      message: z.string(),
      httpStatus: z.number().optional(),
    })
    .optional(),
});
export type OmpModelTestResult = z.infer<typeof ompModelTestResultSchema>;

/** list_mcp_servers 响应行：配置事实 + 尽力连接状态缓存（unknown = 尚无事件）。 */
export const ompMcpServerRowSchema = z.object({
  name: z.string(),
  scope: z.enum(["user", "project"]),
  config: z.unknown().optional(),
  disabled: z.boolean(),
  connection: z.enum(["connected", "failed", "reconnecting", "unknown"]),
  error: z.string().optional(),
});
export type OmpMcpServerRow = z.infer<typeof ompMcpServerRowSchema>;

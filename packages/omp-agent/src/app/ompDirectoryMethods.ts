// Fork（omp-core-integration.md）：OMP 目录能力 legacy 方法处理器。
// workspace/completeOmpCommand、workspace/ompModelRoles、workspace/ompSetModelRole 走
// 工作区目录进程（v3）；session/controlSubagent 走父会话进程（cancel/steer_subagent）。
// v3 能力缺失（旧核，-32601）与目录进程暂时不可用（-32000 可重试）语义不同，不冒充：
// 宿主 UI 对 -32601 会永久停用动态补全，一次瞬时失败不应造成该后果。

import {
  zcodeControlSubagentParamsSchema,
  zcodeOmpCompleteCommandParamsSchema,
  zcodeOmpModelRolesParamsSchema,
  zcodeOmpSetModelRoleParamsSchema,
} from "@zcode/shared";
import { ProtocolError } from "./errors.js";
import type { OmpDirectoryGatewayPort } from "./ports.js";
import type { SessionRegistry } from "./sessionRegistry.js";

export interface OmpDirectoryMethodDeps {
  registry: SessionRegistry;
  directory: OmpDirectoryGatewayPort;
  workspaceKey: string;
}

/**
 * 修复（G4）：命令失败消息尾部附 omp 错误码 `[code]`（存在时），宿主 UI 可据此
 * 归因具体失败类别，而不是只看到无类别的 error 文案。
 */
function outcomeMessage(outcome: { error?: string; code?: string }, fallback: string): string {
  return `${outcome.error ?? fallback}${outcome.code ? ` [${outcome.code}]` : ""}`;
}

export function createOmpDirectoryMethodHandlers(
  deps: OmpDirectoryMethodDeps,
): Record<string, (params: unknown) => Promise<unknown>> {
  return {
    "workspace/completeOmpCommand": async (params: unknown): Promise<unknown> => {
      const parsed = zcodeOmpCompleteCommandParamsSchema.safeParse(params);
      if (!parsed.success || parsed.data.workspace.workspaceKey !== deps.workspaceKey) {
        throw new ProtocolError(-32602, "invalid completion request target");
      }
      const outcome = await deps.directory.sendDirectory({
        type: "complete_command",
        text: parsed.data.text,
        cursor: parsed.data.cursor,
      });
      if (!outcome.success) {
        throwDirectoryError(outcome, "complete_command failed");
      }
      const record = (outcome.data ?? {}) as { items?: unknown[]; revision?: unknown };
      return {
        items: Array.isArray(record.items) ? record.items : [],
        ...(typeof record.revision === "string" ? { revision: record.revision } : {}),
      };
    },
    "workspace/ompModelRoles": async (params: unknown): Promise<unknown> => {
      const parsed = zcodeOmpModelRolesParamsSchema.safeParse(params);
      if (!parsed.success || parsed.data.workspace.workspaceKey !== deps.workspaceKey) {
        throw new ProtocolError(-32602, "invalid model roles request target");
      }
      const outcome = await deps.directory.sendDirectory({ type: "get_model_roles" });
      if (!outcome.success) {
        throwDirectoryError(outcome, "get_model_roles failed");
      }
      const record = (outcome.data ?? {}) as {
        roles?: unknown[];
        sessionModel?: unknown;
      };
      return {
        roles: Array.isArray(record.roles) ? record.roles : [],
        ...(record.sessionModel ? { sessionModel: record.sessionModel } : {}),
      };
    },
    "workspace/ompSetModelRole": async (params: unknown): Promise<unknown> => {
      const parsed = zcodeOmpSetModelRoleParamsSchema.safeParse(params);
      if (!parsed.success || parsed.data.workspace.workspaceKey !== deps.workspaceKey) {
        throw new ProtocolError(-32602, "invalid model role save target");
      }
      const outcome = await deps.directory.sendDirectory({
        type: "set_model_role",
        roleId: parsed.data.roleId,
        scope: parsed.data.scope,
        selection: parsed.data.selection,
        ...(parsed.data.expectedRevision !== undefined
          ? { expectedRevision: parsed.data.expectedRevision }
          : {}),
      });
      if (!outcome.success) {
        throwDirectoryError(outcome, "set_model_role failed");
      }
      return outcome.data ?? {};
    },
    "session/controlSubagent": async (params: unknown): Promise<unknown> => {
      const parsed = zcodeControlSubagentParamsSchema.safeParse(params);
      if (!parsed.success || parsed.data.workspace.workspaceKey !== deps.workspaceKey) {
        throw new ProtocolError(-32602, "invalid subagent control target");
      }
      const outcome = await deps.registry.controlSubagent(
        parsed.data.sessionId,
        parsed.data.subagentId,
        parsed.data.action,
        parsed.data.message,
      );
      if (!outcome.success) {
        throw new ProtocolError(-32000, outcomeMessage(outcome, "control_subagent failed"));
      }
      const record = (outcome.data ?? {}) as Record<string, unknown>;
      // 状态词对齐上游真值：stop→"stopping"、send_message→"sent"（subagentControl）；
      // receipts（send_message 送达回执）上游无对应面，不伪造。
      return {
        subagentId:
          typeof record.subagentId === "string" ? record.subagentId : parsed.data.subagentId,
        action: parsed.data.action,
        status: (["sent", "queued", "stopping", "accepted"] as const).includes(
          record.status as never,
        )
          ? (record.status as "sent" | "queued" | "stopping" | "accepted")
          : "accepted",
        ...(typeof record.detail === "string" ? { detail: record.detail } : {}),
      };
    },
  };
}

/** 目录命令失败的两种语义：能力缺失（旧核，-32601）与暂时不可用/执行失败（-32000）。 */
function throwDirectoryError(outcome: { error?: string; code?: string }, fallback: string): never {
  if (outcome.code === "omp_capability_missing") {
    throw new ProtocolError(
      -32601,
      outcome.error ?? `method not supported by omp core: ${fallback}`,
    );
  }
  throw new ProtocolError(-32000, outcomeMessage(outcome, fallback));
}

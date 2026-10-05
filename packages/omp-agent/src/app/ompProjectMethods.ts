// Fork（omp-project-mode.md）：OMP 项目模式 legacy 方法处理器。
// workspace/completeOmpCommand、workspace/ompModelRoles、workspace/ompSetModelRole、
// session/controlSubagent；omp 未提供项目模式时按能力缺失显式报错（-32601），不伪造。
// 项目进程暂时不可用（启动失败/退避窗口）与「核不支持」语义不同：报 -32000 可重试错误，
// 不冒充能力缺失——宿主 UI 对 -32601 会永久停用动态补全，一次瞬时失败不应造成该后果。

import {
  zcodeControlSubagentParamsSchema,
  zcodeOmpCompleteCommandParamsSchema,
  zcodeOmpModelRolesParamsSchema,
  zcodeOmpSetModelRoleParamsSchema,
} from "@zcode/shared";
import { ProtocolError } from "./errors.js";
import type { OmpProjectGatewayPort } from "./ports.js";
import type { SessionRegistry } from "./sessionRegistry.js";

export interface OmpProjectMethodDeps {
  registry: SessionRegistry;
  project?: OmpProjectGatewayPort | null;
  workspaceKey: string;
}

async function requireProject(
  deps: OmpProjectMethodDeps,
  method: string,
): Promise<OmpProjectGatewayPort> {
  // 网关未注入 = 本端点根本未启用项目模式，等价于永久不支持。
  if (!deps.project) {
    throw new ProtocolError(-32601, `method not supported by omp core: ${method}`);
  }
  const availability = await deps.registry.projectAvailability();
  if (availability === "available") {
    return deps.project;
  }
  if (availability === "unsupported") {
    throw new ProtocolError(-32601, `method not supported by omp core: ${method}`);
  }
  throw new ProtocolError(-32000, `omp project process unavailable: ${method}`);
}

/**
 * 修复（G4）：命令失败消息尾部附 omp 错误码 `[code]`（存在时），宿主 UI 可据此
 * 归因具体失败类别，而不是只看到无类别的 error 文案。
 */
function outcomeMessage(outcome: { error?: string; code?: string }, fallback: string): string {
  return `${outcome.error ?? fallback}${outcome.code ? ` [${outcome.code}]` : ""}`;
}

export function createOmpProjectMethodHandlers(
  deps: OmpProjectMethodDeps,
): Record<string, (params: unknown) => Promise<unknown>> {
  return {
    "workspace/completeOmpCommand": async (params: unknown): Promise<unknown> => {
      const parsed = zcodeOmpCompleteCommandParamsSchema.safeParse(params);
      if (!parsed.success || parsed.data.workspace.workspaceKey !== deps.workspaceKey) {
        throw new ProtocolError(-32602, "invalid completion request target");
      }
      const project = await requireProject(deps, "workspace/completeOmpCommand");
      const outcome = await project.sendProject({
        type: "complete_command",
        text: parsed.data.text,
        cursor: parsed.data.cursor,
        ...(parsed.data.sessionId ? { sessionId: parsed.data.sessionId } : {}),
      });
      if (!outcome.success) {
        throw new ProtocolError(-32000, outcomeMessage(outcome, "complete_command failed"));
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
      const project = await requireProject(deps, "workspace/ompModelRoles");
      const outcome = await project.sendProject({
        type: "get_model_roles",
        ...(parsed.data.sessionId ? { sessionId: parsed.data.sessionId } : {}),
      });
      if (!outcome.success) {
        throw new ProtocolError(-32000, outcomeMessage(outcome, "get_model_roles failed"));
      }
      const record = (outcome.data ?? {}) as {
        roles?: unknown[];
        revision?: unknown;
        sessionModel?: unknown;
      };
      return {
        roles: Array.isArray(record.roles) ? record.roles : [],
        ...(typeof record.revision === "string" ? { revision: record.revision } : {}),
        ...(record.sessionModel ? { sessionModel: record.sessionModel } : {}),
      };
    },
    "workspace/ompSetModelRole": async (params: unknown): Promise<unknown> => {
      const parsed = zcodeOmpSetModelRoleParamsSchema.safeParse(params);
      if (!parsed.success || parsed.data.workspace.workspaceKey !== deps.workspaceKey) {
        throw new ProtocolError(-32602, "invalid model role save target");
      }
      const project = await requireProject(deps, "workspace/ompSetModelRole");
      const outcome = await project.sendProject({
        type: "set_model_role",
        roleId: parsed.data.roleId,
        scope: parsed.data.scope,
        selection: parsed.data.selection,
        ...(parsed.data.expectedRevision !== undefined
          ? { expectedRevision: parsed.data.expectedRevision }
          : {}),
      });
      if (!outcome.success) {
        throw new ProtocolError(-32000, outcomeMessage(outcome, "set_model_role failed"));
      }
      return outcome.data ?? {};
    },
    "session/controlSubagent": async (params: unknown): Promise<unknown> => {
      const parsed = zcodeControlSubagentParamsSchema.safeParse(params);
      if (!parsed.success || parsed.data.workspace.workspaceKey !== deps.workspaceKey) {
        throw new ProtocolError(-32602, "invalid subagent control target");
      }
      await requireProject(deps, "session/controlSubagent");
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
      // 状态白名单对齐真值（rpc-project-subagents.control）：stop→"stopping"、send_message→
      // "sent"；未知词回落 "accepted"（适配器不得伪造同步完成的 "stopped"）。
      // receipts（send_message 送达回执，Delivery ≠ processing）最小透传，供宿主呈现送达详情。
      const receipts = Array.isArray(record.receipts)
        ? record.receipts.filter(
            (item): item is { to: string; outcome: string; error?: string } => {
              if (typeof item !== "object" || item === null) return false;
              const row = item as { to?: unknown; outcome?: unknown };
              return typeof row.to === "string" && typeof row.outcome === "string";
            },
          )
        : undefined;
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
        ...(receipts && receipts.length > 0 ? { receipts } : {}),
      };
    },
  };
}

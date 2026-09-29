// Fork（omp-project-mode.md）：OMP 项目模式 legacy 方法处理器。
// workspace/completeOmpCommand、workspace/ompModelRoles、workspace/ompSetModelRole、
// session/controlSubagent；omp 未提供项目模式时按能力缺失显式报错（-32601），不伪造。

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

function requireProject(deps: OmpProjectMethodDeps, method: string): OmpProjectGatewayPort {
  void deps.registry.projectAvailable();
  if (!deps.project) {
    throw new ProtocolError(-32601, `method not supported by omp core: ${method}`);
  }
  return deps.project;
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
      const project = requireProject(deps, "workspace/completeOmpCommand");
      if (!(await deps.registry.projectAvailable())) {
        throw new ProtocolError(
          -32601,
          "method not supported by omp core: workspace/completeOmpCommand",
        );
      }
      const outcome = await project.sendProject({
        type: "complete_command",
        text: parsed.data.text,
        cursor: parsed.data.cursor,
        ...(parsed.data.sessionId ? { sessionId: parsed.data.sessionId } : {}),
      });
      if (!outcome.success) {
        throw new ProtocolError(-32000, outcome.error ?? "complete_command failed");
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
      const project = requireProject(deps, "workspace/ompModelRoles");
      if (!(await deps.registry.projectAvailable())) {
        throw new ProtocolError(
          -32601,
          "method not supported by omp core: workspace/ompModelRoles",
        );
      }
      const outcome = await project.sendProject({
        type: "get_model_roles",
        ...(parsed.data.sessionId ? { sessionId: parsed.data.sessionId } : {}),
      });
      if (!outcome.success) {
        throw new ProtocolError(-32000, outcome.error ?? "get_model_roles failed");
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
      const project = requireProject(deps, "workspace/ompSetModelRole");
      if (!(await deps.registry.projectAvailable())) {
        throw new ProtocolError(
          -32601,
          "method not supported by omp core: workspace/ompSetModelRole",
        );
      }
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
        throw new ProtocolError(-32000, outcome.error ?? "set_model_role failed");
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
        throw new ProtocolError(-32000, outcome.error ?? "control_subagent failed");
      }
      const record = (outcome.data ?? {}) as Record<string, unknown>;
      return {
        subagentId:
          typeof record.subagentId === "string" ? record.subagentId : parsed.data.subagentId,
        action: parsed.data.action,
        status: (["sent", "queued", "stopped", "stopping", "accepted"] as const).includes(
          record.status as never,
        )
          ? (record.status as "sent" | "queued" | "stopped" | "stopping" | "accepted")
          : "accepted",
        ...(typeof record.detail === "string" ? { detail: record.detail } : {}),
      };
    },
  };
}

// fake omp 项目模式的项目级命令（从 fakeOmpProject.mjs 拆出，架构 max-file-lines）：
// 会话生命周期、目录/补全/执行、技能、模型角色、子代理目录与控制。

import {
  createSubagentEntries,
  DURABLE_SUBAGENTS,
  handleSubagentMessagesCommand,
} from "./fakeOmpProjectSubagentRecords.mjs";

export function createProjectCommandHandler(deps) {
  const {
    sessions,
    revision,
    sessionOut,
    ensureSession,
    sessionFileOf,
    facts,
    streamAssistantTurn,
  } = deps;

  function response(id, command, success, data, error, code) {
    const frame = { id, type: "response", command, success };
    if (data !== undefined) frame.data = data;
    if (error !== undefined) frame.error = error;
    if (code !== undefined) frame.code = code;
    return frame;
  }

  function emitSessionsChanged() {
    process.stdout.write(`${JSON.stringify({ type: "sessions_changed", revision })}\n`);
  }

  const COMMAND_CATALOG = [
    {
      name: "help",
      description: "Show help",
      inputHint: "[topic]",
      source: "builtin",
      execution: "omp",
      scope: "session",
      availability: { available: true },
    },
    {
      name: "model",
      description: "Show or switch model",
      inputHint: "[provider/model]",
      source: "builtin",
      execution: "omp",
      scope: "session",
      availability: { available: true },
    },
    {
      name: "skill:greet",
      description: "Greeting skill",
      source: "skill",
      execution: "omp",
      scope: "session",
      availability: { available: true },
    },
  ];

  const MODEL_ROLES = [
    {
      roleId: "default",
      name: "Default",
      configurable: true,
      effectiveModel: { provider: "fake", modelId: "fake-model" },
      source: "default",
      writableScopes: ["user"],
      hidden: false,
      section: "chat",
      revision,
    },
    {
      roleId: "smol",
      name: "Smol",
      configurable: true,
      unresolvedReason: "no model configured",
      source: "default",
      writableScopes: ["user"],
      hidden: false,
      section: "chat",
      revision,
    },
  ];

  const subagentEntries = createSubagentEntries(facts);

  return function handleProjectCommand(command) {
    const id = command.id;
    switch (command.type) {
      case "negotiate_protocol":
        return response(id, command.type, true, { protocolVersion: command.protocolVersion });
      case "create_session": {
        const sessionId = `fake-session-${sessions.size + 1}-${Math.random().toString(36).slice(2, 8)}`;
        const session = ensureSession(sessionId);
        if (typeof command.name === "string") session.name = command.name;
        emitSessionsChanged();
        return response(id, command.type, true, {
          sessionId,
          name: session.name ?? undefined,
          sessionFile: sessionFileOf(sessionId),
          loadState: "loaded",
          runState: "idle",
          sessionGeneration: "g1",
          revision,
        });
      }
      case "list_sessions":
        // 真实核只回 sessions 键（rpc-project-sessions.ts RpcProjectSessionListResult），
        // 不带 items；载荷结构与分页修订不变。
        return response(id, command.type, true, {
          sessions: [...sessions.entries()].map(([sessionId, session]) => ({
            sessionId,
            loadState: "loaded",
            runState: session.streaming ? "streaming" : "idle",
            sessionGeneration: "g1",
            revision,
          })),
          revision,
        });
      case "resume_session": {
        if (!sessions.has(command.sessionId)) {
          return response(
            id,
            command.type,
            false,
            undefined,
            `Unknown session: ${command.sessionId}`,
            "not_found",
          );
        }
        return response(id, command.type, true, {
          sessionId: command.sessionId,
          loadState: "loaded",
          sessionGeneration: "g1",
          sessionFile: sessionFileOf(command.sessionId),
          revision,
        });
      }
      case "close_session":
        return response(id, command.type, true, {
          sessionId: command.sessionId,
          state: "unloaded",
          revision,
        });
      case "delete_session": {
        sessions.delete(command.sessionId);
        emitSessionsChanged();
        return response(id, command.type, true, {
          sessionId: command.sessionId,
          deleted: true,
          revision,
        });
      }
      case "rename_session": {
        // 真实语义（rpc-project-sessions.rename）：按稳定 ID 改名，loaded 与未 loaded 都支持；
        // 未知会话 not_found。记录事实供 E2E 断言冷会话改名确实下发了 rename_session。
        facts.renames.push({ sessionId: command.sessionId, name: command.name });
        if (!sessions.has(command.sessionId)) {
          return response(
            id,
            command.type,
            false,
            undefined,
            `Unknown session: ${command.sessionId}`,
            "not_found",
          );
        }
        const session = ensureSession(command.sessionId);
        if (typeof command.name === "string") session.name = command.name;
        return response(id, command.type, true, {
          sessionId: command.sessionId,
          name: command.name,
          loadState: "loaded",
          revision,
        });
      }
      case "get_available_commands":
        return response(id, command.type, true, { commands: COMMAND_CATALOG, revision });
      case "complete_command": {
        const text = String(command.text ?? "");
        const cursor = typeof command.cursor === "number" ? command.cursor : text.length;
        if (/^\/[^ ]* $/.test(text)) {
          const name = text.trim().split(/\s+/)[0] ?? "";
          if (name === "/help") {
            return response(id, command.type, true, {
              items: [
                {
                  label: "commands",
                  insertText: "commands",
                  replaceStart: cursor,
                  replaceEnd: cursor,
                  kind: "argument",
                  description: "list commands",
                },
              ],
              revision,
            });
          }
          return response(id, command.type, true, { items: [], revision });
        }
        const prefix = text.startsWith("/") ? text.slice(1) : "";
        const items = COMMAND_CATALOG.filter((entry) => entry.name.startsWith(prefix)).map(
          (entry) => ({
            label: `/${entry.name}`,
            insertText: `/${entry.name}`,
            replaceStart: 0,
            replaceEnd: cursor,
            kind: entry.source === "skill" ? "skill" : "command",
            description: entry.description,
            hint: entry.inputHint,
          }),
        );
        return response(id, command.type, true, { items, revision });
      }
      case "execute_command": {
        facts.executes.push({ sessionId: command.sessionId, text: command.text });
        const name = String(command.text ?? "")
          .trim()
          .split(/\s+/)[0];
        // 本地命令（/help、/model）与真实核同构：侧信道帧（command_output/config_update）
        // 先于 response 同步输出（参照单会话 fakeOmp.mjs），response 以 data.agentInvoked=false
        // 同步收口，不补发 prompt_result（真实核仅 completeLocal 在 response 无 data 时异步发）。
        if (name === "/help") {
          sessionOut(command.sessionId, {
            type: "command_output",
            text: "fake help: try /model, /skill:greet",
          });
          return response(id, command.type, true, { agentInvoked: false });
        }
        if (name === "/model") {
          const session = ensureSession(command.sessionId);
          sessionOut(command.sessionId, {
            type: "config_update",
            model: session.model,
            thinkingLevel: "low",
          });
          return response(id, command.type, true, { agentInvoked: false });
        }
        if (name === "/skill:greet") {
          setImmediate(() => streamAssistantTurn(command.sessionId, id, "greet skill invoked"));
          return response(id, command.type, true, { agentInvoked: true });
        }
        return response(
          id,
          command.type,
          false,
          undefined,
          `Unknown command: ${name}`,
          "invalid_params",
        );
      }
      case "list_skills":
        return response(id, command.type, true, {
          items: [
            {
              skillId: "native:user/greet",
              name: "greet",
              description: "Greeting skill",
              source: "native:user",
              scope: "user",
              state: "enabled",
              effective: true,
              actions: ["disable", "copy", "delete"],
              revision,
            },
          ],
          warnings: [],
          revision,
        });
      case "get_model_roles":
        return response(id, command.type, true, { roles: MODEL_ROLES, revision });
      case "set_model_role": {
        const role = MODEL_ROLES.find((entry) => entry.roleId === command.roleId);
        if (!role)
          return response(
            id,
            command.type,
            false,
            undefined,
            `Unknown role: ${command.roleId}`,
            "invalid_params",
          );
        const updated = {
          ...role,
          explicitValue:
            command.selection && command.selection.kind === "model"
              ? `${command.selection.model.provider}/${command.selection.model.modelId}`
              : undefined,
          effectiveModel:
            command.selection && command.selection.kind === "model"
              ? command.selection.model
              : role.effectiveModel,
          source: "global",
          revision: "r2",
        };
        const index = MODEL_ROLES.indexOf(role);
        MODEL_ROLES[index] = updated;
        return response(id, command.type, true, { role: updated, revision: "r2", persisted: true });
      }
      case "get_available_models":
        return response(id, command.type, true, {
          models: [
            {
              provider: "fake",
              id: "fake-model",
              name: "Fake Model",
              thinking: { efforts: ["low", "high"], defaultLevel: "low" },
            },
            {
              provider: "fake",
              id: "fake-pro",
              name: "Fake Pro",
              thinking: { efforts: ["low"], defaultLevel: "low" },
            },
          ],
        });
      case "get_subagents": {
        if (command.sessionId === undefined) {
          return response(
            id,
            command.type,
            false,
            undefined,
            "get_subagents requires sessionId in project mode",
            "invalid_params",
          );
        }
        // 事实记录：E2E 在 fake 进程退出后读 facts.json，断言适配器透传的 status/cursor/limit。
        facts.subagentLists.push({
          sessionId: command.sessionId,
          status: command.status ?? null,
          cursor: command.cursor ?? null,
          limit: command.limit ?? null,
        });
        // 真实语义（rpc-project-subagents.list）：status="running" 只回 live 行（fake 无项目级
        // live 注册表，恒空）；status="finished" 或缺省回 durable 目录（live+durable 合并目录
        // 的 durable 部分）。durable 目录支持 cursor/limit 分页（默认页 20，返回 nextCursor）。
        if (command.status === "running") {
          return response(id, command.type, true, { items: [], revision });
        }
        const offset =
          Number.isFinite(Number(command.cursor)) && Number(command.cursor) > 0
            ? Math.trunc(Number(command.cursor))
            : 0;
        const limit =
          Number.isFinite(Number(command.limit)) && Number(command.limit) > 0
            ? Math.trunc(Number(command.limit))
            : 20;
        const page = DURABLE_SUBAGENTS.finished.slice(offset, offset + limit);
        const hasMore = offset + page.length < DURABLE_SUBAGENTS.finished.length;
        return response(id, command.type, true, {
          items: page,
          ...(hasMore ? { nextCursor: String(offset + page.length) } : {}),
          revision,
        });
      }
      case "get_subagent_messages":
        return handleSubagentMessagesCommand({
          id,
          command,
          response,
          facts,
          subagentEntries,
          sessionFileOf,
        });
      case "control_subagent": {
        facts.controls.push({
          sessionId: command.sessionId,
          subagentId: command.subagentId,
          action: command.action,
          message: command.message,
        });
        // 真值（rpc-project-subagents.control）：stop → "stopping"（中止已请求，非同步完成）；
        // send_message → "sent" + receipts（送达回执；送达 ≠ 已处理）。
        return response(id, command.type, true, {
          subagentId: command.subagentId,
          action: command.action,
          status: command.action === "stop" ? "stopping" : "sent",
          detail: command.action === "stop" ? "abort requested" : undefined,
          receipts:
            command.action === "send_message"
              ? [{ to: command.subagentId, outcome: "delivered" }]
              : undefined,
        });
      }
      default:
        return response(
          id,
          String(command.type),
          false,
          undefined,
          `Unknown command: ${String(command.type)}`,
        );
    }
  };
}

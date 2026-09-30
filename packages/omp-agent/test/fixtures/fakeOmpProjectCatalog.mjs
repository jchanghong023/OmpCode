// fake omp 项目模式的项目级命令（从 fakeOmpProject.mjs 拆出，架构 max-file-lines）：
// 会话生命周期、目录/补全/执行、技能、模型角色、子代理目录与控制。

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

  const SUBAGENTS = {
    finished: [
      {
        subagentId: "sa-done",
        name: "scout",
        description: "finished scout",
        task: "scan",
        status: "completed",
        recordReadable: true,
        parentToolCallId: "tc-0",
        lastUpdate: "2026-09-29T00:00:00.000Z",
        availableActions: [],
      },
    ],
  };

  function subagentEntries() {
    // 条目带固定时间戳：真实 omp 记录携带时间戳；缺时间戳会让 rowsFromOmpEntries 回退
    // Date.now()，使全量重读的确定性重建产生 createdAt 漂移（重读即触发全量 upsert）。
    const entries = [
      {
        type: "message",
        message: {
          role: "user",
          timestamp: 1727500000000,
          content: [{ type: "text", text: "scan the repo" }],
        },
      },
      {
        type: "message",
        message: {
          role: "assistant",
          timestamp: 1727500000001,
          content: [{ type: "text", text: "scanned 3 files" }],
        },
      },
    ];
    // 同一 subagentId 的第 2+ 轮运行各追加一条尾记录（确定性内容）：驱动子代理详情视图
    // 的实时重读合并断言——重读返回的行数必须随记录增长，且旧行内容保持不变。
    for (let run = 2; run <= (facts.subagentSpawns ?? 0); run += 1) {
      entries.push({
        type: "message",
        message: {
          role: "assistant",
          timestamp: 1727500000000 + run,
          content: [{ type: "text", text: `scanned ${1 + run} files in run ${run}` }],
        },
      });
    }
    return entries;
  }

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
        return response(id, command.type, true, {
          items: [...sessions.entries()].map(([sessionId, session]) => ({
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
      case "rename_session":
        return response(id, command.type, true, {
          sessionId: command.sessionId,
          name: command.name,
          loadState: sessions.has(command.sessionId) ? "loaded" : "not_loaded",
          revision,
        });
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
        if (command.status === "finished") {
          return response(id, command.type, true, { items: SUBAGENTS.finished, revision });
        }
        return response(id, command.type, true, { items: [], revision });
      }
      case "get_subagent_messages":
        return response(id, command.type, true, {
          subagentId: command.subagentId,
          sessionFile: sessionFileOf(`${command.sessionId}-${command.subagentId}`),
          fromByte: 0,
          nextByte: 512,
          reset: false,
          hasMore: false,
          entries: subagentEntries(),
          messages: subagentEntries().map((entry) => entry.message),
        });
      case "control_subagent": {
        facts.controls.push({
          sessionId: command.sessionId,
          subagentId: command.subagentId,
          action: command.action,
          message: command.message,
        });
        return response(id, command.type, true, {
          subagentId: command.subagentId,
          action: command.action,
          status: command.action === "stop" ? "stopped" : "sent",
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

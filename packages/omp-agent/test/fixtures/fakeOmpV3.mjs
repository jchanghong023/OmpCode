// fake omp v3 fork surface 行为模块（rpc-ui-protocol 4.0/4.1/4.3 + 5.6 A）。
// 从 fakeOmp.mjs 拆出（架构 maxFileLines=400）：结构化审批、富 ask、fork 查询命令。
// 仅当宿主协商 v3（negotiatedVersion >= 3）后启用；未协商时镜像真实 omp 的
// Unknown command 拒绝与 legacy extension_ui select 降级。

/** prompt 消息 → 工具审批场景（工具名/参数/子代理来源）。 */
export const PROMPT_SCENARIOS = {
  default: { toolName: "write", args: { path: "greeting.txt", content: "line1\nline2\n" } },
  RUN_BASH: { toolName: "bash", args: { command: "npm install" } },
  SUBAGENT_WRITE: {
    toolName: "write",
    args: { path: "greeting.txt", content: "line1\nline2\n" },
    origin: { subagentId: "fake-child-9", agentType: "scout" },
  },
};

export function createV3Surface({ out, nextId }) {
  const permissionResponses = [];
  const askReports = { responses: [], pauses: [] };
  const pendingPermission = new Map();
  const pendingAsk = new Map();
  let negotiatedVersion = 1;

  /** 未协商 v3 时对 fork 命令的拒绝（镜像真实 omp `Unknown command` 顶层 error 形状）。 */
  function respondUnknownForkCommand(command) {
    out({
      id: command.id,
      type: "response",
      command: command.type,
      success: false,
      error: `Unknown command: ${command.type}`,
    });
  }

  return {
    announce: () => [1, 2, 3],
    isV3: () => negotiatedVersion >= 3,
    setNegotiatedVersion(version) {
      negotiatedVersion = version;
    },

    /** 客户端 → omp 即时分发旁路帧；消费返回 true。 */
    handleBypassFrame(command) {
      if (command.type === "permission_response") {
        const entry = pendingPermission.get(command.id);
        if (entry) {
          pendingPermission.delete(command.id);
          permissionResponses.push({
            id: command.id,
            option: command.option,
            ...(typeof command.feedback === "string" ? { feedback: command.feedback } : {}),
          });
          entry(!String(command.option).startsWith("reject"));
        }
        return true;
      }
      if (command.type === "ask_response") {
        const entry = pendingAsk.get(command.id);
        if (entry) {
          pendingAsk.delete(command.id);
          if (command.cancelled === true) {
            askReports.responses.push({ id: command.id, cancelled: true });
            entry({ kind: "cancelled" });
          } else if (command.chat !== undefined) {
            askReports.responses.push({ id: command.id, chat: command.chat });
            entry({ kind: "chat", chat: command.chat });
          } else {
            askReports.responses.push({ id: command.id, answers: command.answers });
            entry({ kind: "answers", answers: command.answers });
          }
        }
        return true;
      }
      if (command.type === "ask_pause") {
        askReports.pauses.push({ targetId: command.targetId });
        return true;
      }
      return false;
    },

    /** v3 结构化审批（rpc-ui-protocol 4.1）：permission_request + 六档 permission_response。 */
    requestApproval(toolCallId, scenario) {
      return new Promise((resolve) => {
        const id = nextId();
        pendingPermission.set(id, resolve);
        out({
          type: "permission_request",
          id,
          toolCallId,
          toolName: scenario.toolName,
          tier: scenario.toolName === "bash" ? "exec" : "write",
          reason: `Approve ${scenario.toolName} to continue`,
          approvalMode: "write",
          details: [
            typeof scenario.args.path === "string"
              ? `path: ${scenario.args.path}`
              : `${scenario.toolName} call`,
          ],
          input: scenario.args,
          ...(scenario.toolName === "bash" ? { prefixSuggestion: "npm " } : {}),
          ...(scenario.origin ? { origin: scenario.origin } : {}),
        });
      });
    },

    /** v3 富 ask（rpc-ui-protocol 4.3）：完整问题集一次下发，等 ask_response。 */
    runAskTurn(emitTextTurn) {
      const askId = nextId();
      pendingAsk.set(askId, (answer) => {
        let text;
        if (answer.kind === "cancelled") text = "Ask was cancelled";
        else if (answer.kind === "chat") text = `Ask moved to chat: ${answer.chat}`;
        else text = `ASK RESULT: ${JSON.stringify(answer.answers)}`;
        emitTextTurn(text);
      });
      out({
        type: "ask_request",
        id: askId,
        questions: [
          {
            id: "q-db",
            question: "Which database?",
            header: "Database",
            options: [
              { label: "Postgres", description: "relational", preview: "SELECT 1;" },
              { label: "SQLite", description: "embedded" },
            ],
            multi: true,
            recommended: 0,
          },
          {
            id: "q-cache",
            question: "Enable cache?",
            options: [{ label: "Yes" }, { label: "No" }],
          },
        ],
        note: "Choose wisely",
        timeoutMs: 60000,
        deadlineAt: Date.now() + 60000,
      });
    },

    /** 本地报告命令（/permission-report、/ask-report）；返回命令结果或 null。 */
    localReport(message) {
      if (message === "/permission-report") {
        out({
          type: "command_output",
          text: `permission-report:${JSON.stringify(permissionResponses)}`,
        });
        return { agentInvoked: false };
      }
      if (message === "/ask-report") {
        out({ type: "command_output", text: `ask-report:${JSON.stringify(askReports)}` });
        return { agentInvoked: false };
      }
      return null;
    },

    /** v3 fork 查询命令（rpc-ui-protocol 5.6 A 消费子集）；消费返回 true。 */
    forkCommand(command) {
      if (command.type === "test_model") {
        if (command.modelId === "boom-model") {
          out({
            id: command.id,
            type: "response",
            command: "test_model",
            success: true,
            data: {
              ok: false,
              latencyMs: 5,
              error: {
                category: "rate_limited",
                message: "429 too many requests",
                httpStatus: 429,
              },
            },
          });
        } else {
          out({
            id: command.id,
            type: "response",
            command: "test_model",
            success: true,
            data: { ok: true, latencyMs: 7 },
          });
        }
        return true;
      }
      if (command.type === "list_mcp_servers") {
        out({
          id: command.id,
          type: "response",
          command: "list_mcp_servers",
          success: true,
          data: {
            servers: [
              { name: "context7", scope: "user", disabled: false, connection: "connected" },
              {
                name: "broken",
                scope: "project",
                disabled: false,
                connection: "failed",
                error: "spawn failed",
              },
              { name: "off", scope: "user", disabled: true, connection: "unknown" },
            ],
          },
        });
        return true;
      }
      return false;
    },

    /** 未协商 v3 时的 fork 命令拒绝入口。 */
    rejectForkCommand(command) {
      respondUnknownForkCommand(command);
    },
  };
}

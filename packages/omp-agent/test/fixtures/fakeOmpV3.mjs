// fake omp v3 fork surface 行为模块（v18.8.0+fork.298 起：最小目录能力面）。
// 从 fakeOmp.mjs 拆出（架构 maxFileLines=400）：富 ask（extension_ui_request method:"ask"）、
// 审批（extension runner select Approve/Deny）、v3 目录命令（complete_command / 模型角色 /
// 会话目录）、set_ask_dialog 门控。仅当宿主协商 v3（negotiatedVersion >= 3）后启用；
// 未协商时镜像真实 omp 的 Unknown command 拒绝。

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
  const approvalResponses = [];
  const askReports = { responses: [] };
  const pendingApproval = new Map();
  const pendingAsk = new Map();
  let negotiatedVersion = 1;
  let askDialogEnabled = false;
  /** v3 会话目录（list/rename/delete 的 fake 状态；sessionId → name）。 */
  const directorySessions = new Map();

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
    isAskDialogEnabled: () => askDialogEnabled,

    /** 客户端 → omp 即时分发旁路帧；消费返回 true。 */
    handleBypassFrame(command) {
      if (command.type !== "extension_ui_response") return false;
      if (Array.isArray(command.answers)) {
        const entry = pendingAsk.get(command.id);
        if (entry) {
          pendingAsk.delete(command.id);
          askReports.responses.push({ id: command.id, answers: command.answers });
          entry({ kind: "answers", answers: command.answers });
        }
        return true;
      }
      if (command.cancelled === true) {
        // ask 与 select 共用 cancelled 变体：先按 ask 收口，未命中再按审批收口；
        // 都未命中交回 legacy pendingUi 车道（返回 false）。
        const askEntry = pendingAsk.get(command.id);
        if (askEntry) {
          pendingAsk.delete(command.id);
          askReports.responses.push({ id: command.id, cancelled: true });
          askEntry({ kind: "cancelled" });
          return true;
        }
        const approvalEntry = pendingApproval.get(command.id);
        if (approvalEntry) {
          pendingApproval.delete(command.id);
          approvalResponses.push({ id: command.id, option: "cancelled" });
          approvalEntry(false);
          return true;
        }
        return false;
      }
      if (typeof command.value === "string") {
        const entry = pendingApproval.get(command.id);
        if (entry) {
          pendingApproval.delete(command.id);
          approvalResponses.push({ id: command.id, option: command.value });
          entry(command.value === "Approve");
          return true;
        }
        return false;
      }
      return false;
    },

    /**
     * 工具审批（extension runner 路径，oh-my-pi wrapper.ts）：
     * extension_ui_request{method:"select"} + options ["Approve","Deny"]，提示为
     * formatApprovalPrompt 形态（Allow tool: <name> / Reason / details）。
     */
    requestApproval(toolCallId, scenario) {
      return new Promise((resolve) => {
        const id = nextId();
        pendingApproval.set(id, resolve);
        const details =
          typeof scenario.args.path === "string"
            ? `path: ${scenario.args.path}`
            : `${scenario.toolName} call`;
        out({
          type: "extension_ui_request",
          id,
          method: "select",
          title: "Tool approval",
          message: `Allow tool: ${scenario.toolName}\nReason: approval mode\n${details}`,
          options: ["Approve", "Deny"],
        });
      });
    },

    /**
     * 富 ask（set_ask_dialog 启用后；oh-my-pi requestRpcAskDialog）：
     * extension_ui_request{method:"ask"} 携带完整问题集，等 answers/cancelled。
     */
    runAskTurn(emitTextTurn) {
      const askId = nextId();
      pendingAsk.set(askId, (answer) => {
        let text;
        if (answer.kind === "cancelled") text = "Ask was cancelled";
        else text = `ASK RESULT: ${JSON.stringify(answer.answers)}`;
        emitTextTurn(text);
      });
      out({
        type: "extension_ui_request",
        id: askId,
        method: "ask",
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
        timeout: 60000,
      });
    },

    /** 本地报告命令（/approval-report、/ask-report）；返回命令结果或 null。 */
    localReport(message) {
      if (message === "/approval-report") {
        out({
          type: "command_output",
          text: `approval-report:${JSON.stringify(approvalResponses)}`,
        });
        return { agentInvoked: false };
      }
      if (message === "/ask-report") {
        out({ type: "command_output", text: `ask-report:${JSON.stringify(askReports)}` });
        return { agentInvoked: false };
      }
      return null;
    },

    /** 会话目录 fake 状态注入（测试用）。 */
    setDirectorySessions(entries) {
      directorySessions.clear();
      for (const [id, name] of entries) directorySessions.set(id, name);
    },
    directorySessionNames() {
      return [...directorySessions.entries()];
    },

    /** v3 fork 目录命令（rpc-fork-types 最小面）；消费返回 true。 */
    forkCommand(command) {
      if (command.type === "set_ask_dialog") {
        askDialogEnabled = command.enabled === true;
        out({
          id: command.id,
          type: "response",
          command: "set_ask_dialog",
          success: true,
          data: { enabled: askDialogEnabled },
        });
        return true;
      }
      if (command.type === "complete_command") {
        const text = String(command.text ?? "");
        const known = ["/model", "/models", "/modelpreset", "/security", "/skill:greet"];
        const items = known
          .filter((name) => name.startsWith(text))
          .map((name) => ({
            label: name.slice(1),
            insertText: `${name} `,
            replaceStart: 0,
            replaceEnd: text.length,
            kind: "command",
            description: `fake ${name}`,
          }));
        out({
          id: command.id,
          type: "response",
          command: "complete_command",
          success: true,
          data: { items, revision: "fake-cmd-r0" },
        });
        return true;
      }
      if (command.type === "get_model_roles") {
        out({
          id: command.id,
          type: "response",
          command: "get_model_roles",
          success: true,
          data: {
            roles: [
              {
                roleId: "default",
                name: "Default",
                configurable: true,
                explicitValue: "fake-provider/fake-model:high",
                userValue: "fake-provider/fake-model:high",
                projectValue: null,
                candidateModels: [
                  { provider: "fake-provider", modelId: "fake-model", thinkingLevel: "high" },
                ],
                source: "user",
                writableScopes: ["user"],
                hidden: false,
                section: "chat",
                revision: "fake-role-r0",
              },
              {
                roleId: "smol",
                name: "Smol",
                configurable: true,
                userValue: null,
                projectValue: null,
                candidateModels: [],
                source: "default",
                writableScopes: ["user"],
                hidden: false,
                section: "chat",
                revision: "fake-role-r0",
              },
            ],
          },
        });
        return true;
      }
      if (command.type === "set_model_role") {
        out({
          id: command.id,
          type: "response",
          command: "set_model_role",
          success: true,
          data: {
            role: {
              roleId: command.roleId,
              name: command.roleId,
              configurable: true,
              explicitValue:
                command.selection === null || command.selection?.kind === "auto"
                  ? undefined
                  : `${command.selection.model.provider}/${command.selection.model.modelId}`,
              userValue: null,
              projectValue: null,
              candidateModels: [],
              source: "user",
              writableScopes: ["user"],
              hidden: false,
              section: "chat",
              revision: "fake-role-r1",
            },
            persisted: true,
          },
        });
        return true;
      }
      if (command.type === "list_sessions") {
        out({
          id: command.id,
          type: "response",
          command: "list_sessions",
          success: true,
          data: {
            sessions: [...directorySessions.entries()].map(([sessionId, name]) => ({
              sessionId,
              ...(name ? { name } : {}),
              current: false,
              revision: "fake-session-r0",
            })),
          },
        });
        return true;
      }
      if (command.type === "rename_session") {
        if (!directorySessions.has(command.sessionId)) {
          out({
            id: command.id,
            type: "response",
            command: "rename_session",
            success: false,
            code: "not_found",
            error: `Session not found: ${command.sessionId}`,
          });
          return true;
        }
        directorySessions.set(command.sessionId, command.name);
        out({
          id: command.id,
          type: "response",
          command: "rename_session",
          success: true,
          data: {
            sessionId: command.sessionId,
            name: command.name,
            current: false,
            revision: "fake-session-r1",
          },
        });
        return true;
      }
      if (command.type === "delete_session") {
        if (!directorySessions.delete(command.sessionId)) {
          out({
            id: command.id,
            type: "response",
            command: "delete_session",
            success: false,
            code: "not_found",
            error: `Session not found: ${command.sessionId}`,
          });
          return true;
        }
        out({
          id: command.id,
          type: "response",
          command: "delete_session",
          success: true,
          data: { sessionId: command.sessionId, deleted: true },
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

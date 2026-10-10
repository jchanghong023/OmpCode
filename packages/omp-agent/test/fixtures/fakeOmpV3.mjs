// fake omp v3：协议协商、真实 select(Approve/Deny) 工具审批及本地回执读取。
// set_ask_dialog 保留为会话启动必经的 opt-in ACK；富问答行为由离线交互测试覆盖。
export const PROMPT_SCENARIOS = {
  default: { toolName: "write", args: { path: "greeting.txt", content: "line1\nline2\n" } },
};

export function createV3Surface({ out, nextId }) {
  const approvalResponses = [];
  const pendingApproval = new Map();
  let negotiatedVersion = 1;
  let askDialogEnabled = false;

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
      if (command.type !== "extension_ui_response") return false;
      if (command.cancelled === true) {
        // 未命中的审批取消交回 legacy pendingUi 车道。
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

    /** 本地审批回执报告；返回命令结果或 null。 */
    localReport(message) {
      if (message === "/approval-report") {
        out({
          type: "command_output",
          text: `approval-report:${JSON.stringify(approvalResponses)}`,
        });
        return { agentInvoked: false };
      }
      return null;
    },

    /** 会话启动 opt-in；消费返回 true。 */
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
      return false;
    },

    /** 未协商 v3 时的 fork 命令拒绝入口。 */
    rejectForkCommand(command) {
      respondUnknownForkCommand(command);
    },
  };
}

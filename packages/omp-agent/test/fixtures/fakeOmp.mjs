// fake omp：讲 omp RPC 的最小假核心，供适配器集成测试使用。
// 行为脚本：prompt → 流式文本 → write 工具（先 select 审批）→ 完成收口。

import { createInterface } from "node:readline";

const out = (frame) => process.stdout.write(`${JSON.stringify(frame)}\n`);
let counter = 0;
const nextId = () => `fake-${++counter}`;
let sessionFile = null;
const deniedTools = new Set();

out({
  type: "ready",
  protocolVersion: 1,
  supportedProtocolVersions: [1, 2],
  maxFrameBytes: 1048576,
  maxReassembledFrameBytes: 67108864,
});

function respond(id, command, success, data) {
  out({ ...(id ? { id } : {}), type: "response", command, success, ...(data !== undefined ? { data } : {}) });
}

async function runPromptTurn(message) {
  out({ type: "agent_start" });
  out({ type: "message_start", message: { role: "assistant", content: [] } });
  for (const delta of ["Hello", " wor", "ld!"]) {
    out({
      type: "message_update",
      message: { role: "assistant", content: [] },
      assistantMessageEvent: { type: "text_delta", contentIndex: 0, delta, partial: { role: "assistant", content: [] } },
    });
  }
  const toolCallId = `toolu-${nextId()}`;
  if (!sessionFile) {
    sessionFile = `${process.cwd()}/.fake-omp-sessions/session-1.jsonl`;
  }
  out({
    type: "tool_execution_start",
    toolCallId,
    toolName: "write",
    args: { path: "greeting.txt", content: "line1\nline2\n" },
  });
  const approved = await requestApproval(toolCallId);
  if (approved) {
    out({
      type: "tool_execution_end",
      toolCallId,
      toolName: "write",
      result: { content: [{ type: "text", text: "wrote 2 lines" }] },
      isError: false,
    });
    out({
      type: "message_update",
      message: { role: "assistant", content: [] },
      assistantMessageEvent: { type: "text_delta", contentIndex: 1, delta: " Done.", partial: { role: "assistant", content: [] } },
    });
  } else {
    out({
      type: "tool_execution_end",
      toolCallId,
      toolName: "write",
      result: { content: [{ type: "text", text: "denied by user" }] },
      isError: true,
    });
    deniedTools.add(toolCallId);
  }
  out({
    type: "message_end",
    message: { role: "assistant", content: [{ type: "text", text: "Hello world! Done." }], usage: { input: 120, output: 30 } },
  });
  out({ type: "agent_end", messages: [], isTerminal: true });
}

function requestApproval(toolCallId) {
  return new Promise((resolve) => {
    const id = nextId();
    pendingUi.set(id, resolve);
    out({
      type: "extension_ui_request",
      id,
      method: "select",
      title: "Tool approval",
      message: `Approve write to greeting.txt? (toolCallId=${toolCallId})`,
      options: ["Approve", "Deny"],
    });
  });
}

const pendingUi = new Map();

const readline = createInterface({ input: process.stdin });
readline.on("line", (line) => {
  let command;
  try {
    command = JSON.parse(line.trim());
  } catch {
    return;
  }
  if (command.type === "extension_ui_response") {
    const resolve = pendingUi.get(command.id);
    if (resolve) {
      pendingUi.delete(command.id);
      resolve(command.value === "Approve");
    }
    return;
  }
  switch (command.type) {
    case "negotiate_protocol":
      respond(command.id, "negotiate_protocol", true, { protocolVersion: command.protocolVersion });
      return;
    case "get_state":
      respond(command.id, "get_state", true, {
        model: { provider: "mock", id: "mock-1" },
        thinkingLevel: "medium",
        isStreaming: false,
        sessionFile,
        sessionId: "fake-session-1",
        sessionName: null,
        contextUsage: { tokens: 512, contextWindow: 200000, percent: 0.25 },
      });
      return;
    case "get_available_models":
      respond(command.id, "get_available_models", true, {
        models: [{ provider: "mock", id: "mock-1", name: "Mock Model" }],
      });
      return;
    case "get_available_thinking_levels":
      respond(command.id, "get_available_thinking_levels", true, { levels: ["off", "medium", "high"] });
      return;
    case "prompt":
    case "follow_up":
      respond(command.id, command.type, true, { agentInvoked: true });
      setTimeout(() => {
        void runPromptTurn(command.message);
      }, 10);
      return;
    case "abort":
      respond(command.id, "abort", true, {});
      out({ type: "agent_end", messages: [], isTerminal: true });
      return;
    case "set_model":
      respond(command.id, "set_model", true, {});
      out({ type: "model_changed", model: { provider: command.provider, id: command.modelId } });
      return;
    case "set_thinking_level":
      respond(command.id, "set_thinking_level", true, {});
      out({ type: "thinking_level_changed", thinkingLevel: command.level });
      return;
    case "compact":
      respond(command.id, "compact", true, {});
      return;
    case "set_session_name":
      respond(command.id, "set_session_name", true, {});
      return;
    default:
      respond(command.id, command.type ?? "unknown", false, { error: `unsupported: ${command.type}` });
      return;
  }
});

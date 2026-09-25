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

// HOLD 前缀：进入流式保持态（agent_start + 首段文本，不收口），用于测试 steer/follow_up 路由。
let holding = false;
let setModelCalls = 0;
let currentModel = { provider: "mock", id: "mock-1" };
let autoCompactionEnabled = true;
let subagentSubscription = "off";
let subagents = [];

function runLocalCommand(message) {
  if (message === "/model-report") {
    out({ type: "command_output", text: `set_model calls: ${setModelCalls}` });
    return { agentInvoked: false };
  }
  if (message.startsWith("/title ")) {
    const title = message.slice("/title ".length).trim();
    out({ type: "session_info_update", title, sessionId: "fake-session-1" });
    out({ type: "command_output", text: `title set to ${title}` });
    return { agentInvoked: false };
  }
  if (message === "/config-new") {
    out({ type: "config_update", model: { provider: "mock", id: "mock-9" }, thinkingLevel: "high" });
    out({ type: "command_output", text: "config updated" });
    return { agentInvoked: false };
  }
  if (message === "/install-ship2") {
    out({ type: "command_output", text: "installed ship2" });
    out({
      type: "available_commands_update",
      commands: [
        { name: "help", source: "builtin", description: "Show help" },
        { name: "ship", source: "extension", description: "Ship changes", input: { hint: "target" } },
        { name: "ship2", source: "extension", description: "Ship twice" },
      ],
    });
    return { agentInvoked: false };
  }
  return null;
}

async function runPromptTurn(message) {
  out({ type: "agent_start" });
  if (message === "SUBAGENT_REPORT") {
    const agent = { id: "fake-child-1", index: 0, agent: "scout", agentSource: "bundled", description: "Inspect project", status: "active", lastUpdate: Date.now(), parentToolCallId: "task-parent" };
    subagents = [agent];
    if (subagentSubscription !== "off") {
      out({ type: "subagent_lifecycle", payload: { ...agent, status: "started" } });
      out({ type: "subagent_progress", payload: { index: 0, agent: "scout", agentSource: "bundled", task: "Inspect project", parentToolCallId: "task-parent", progress: { id: agent.id, status: "running", recentOutput: ["reading files"] } } });
    }
    await new Promise((resolve) => setTimeout(resolve, 30));
    subagents = [{ ...agent, status: "completed", lastUpdate: Date.now() }];
    if (subagentSubscription !== "off") {
      out({ type: "subagent_lifecycle", payload: { ...agent, status: "completed" } });
      out({ type: "subagent_lifecycle", payload: { ...agent, status: "completed" } });
    }
    out({ type: "message_end", message: { role: "assistant", content: [{ type: "text", text: "Subagent done" }] } });
    out({ type: "agent_end", messages: [], isTerminal: true });
    return;
  }
  if (message === "/failmodel") {
    out({ type: "message_start", message: { role: "assistant", content: [] } });
    out({
      type: "message_end",
      message: { role: "assistant", content: [], stopReason: "error", errorStatus: 401, errorMessage: "401 Model not supported" },
    });
    out({ type: "agent_end", messages: [], isTerminal: true });
    return;
  }
  if (typeof message === "string" && message.startsWith("HOLD")) {
    holding = true;
    out({ type: "message_start", message: { role: "assistant", content: [] } });
    out({
      type: "message_update",
      message: { role: "assistant", content: [] },
      assistantMessageEvent: { type: "text_delta", contentIndex: 0, delta: "holding", partial: { role: "assistant", content: [] } },
    });
    return;
  }
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
        model: currentModel,
        thinkingLevel: "max",
        autoCompactionEnabled,
        isStreaming: false,
        sessionFile,
        sessionId: "fake-session-1",
        sessionName: null,
        contextUsage: { tokens: 512, contextWindow: 200000, percent: 0.25 },
      });
      return;
    case "set_subagent_subscription":
      if (process.env.FAKE_OMP_SUBAGENT_SUBSCRIBE_FAIL === "1") {
        respond(command.id, "set_subagent_subscription", false, { error: "subscription unavailable" });
        return;
      }
      subagentSubscription = command.level;
      respond(command.id, "set_subagent_subscription", true, { level: command.level });
      return;
    case "get_subagents":
      respond(command.id, "get_subagents", true, { subagents });
      return;
    case "get_subagent_messages":
      respond(command.id, "get_subagent_messages", true, { sessionFile: "fake-child.jsonl", fromByte: 0, nextByte: 1, reset: false, entries: [], messages: [{ role: "assistant", content: [{ type: "text", text: "Read README and reported findings." }] }] });
      return;
    case "get_available_models":
      respond(command.id, "get_available_models", true, {
        models: [{ provider: "mock", id: "mock-1", name: "Mock Model", thinking: { mode: "effort", efforts: ["low", "high", "max"], defaultLevel: "high" } }],
      });
      return;
    case "get_available_commands":
      respond(command.id, "get_available_commands", true, {
        commands: [
          { name: "help", source: "builtin", description: "Show help" },
          { name: "ship", source: "extension", description: "Ship changes", input: { hint: "target" } },
        ],
      });
      return;
    case "get_available_thinking_levels":
      respond(command.id, "get_available_thinking_levels", true, { levels: ["off", "low", "high", "max"] });
      return;
    case "prompt": {
      if (command.message === "/context") {
        out({ type: "command_output", text: "Context window: 200000 tokens (0% used)\n  System prompt [░░░░] 0%  200 tokens\n  Messages [░░░░] 0%  312 tokens\n  Free [████] 84%  169488 tokens\n  Auto-compact buf [████] 15%  30000 tokens" });
        respond(command.id, "prompt", true, { agentInvoked: false });
        return;
      }
      if (command.message.startsWith("/image-report ")) {
        const label = command.message.slice("/image-report ".length);
        out({
          type: "command_output",
          text: `IMAGE_REPORT:${label}:${JSON.stringify({ hasImages: Object.hasOwn(command, "images"), images: command.images ?? [] })}`,
        });
        respond(command.id, "prompt", true, { agentInvoked: false });
        return;
      }
      if (command.message.startsWith("/text-report ")) {
        out({ type: "command_output", text: `TEXT_REPORT:${JSON.stringify({ message: command.message, images: command.images ?? [] })}` });
        respond(command.id, "prompt", true, { agentInvoked: false });
        return;
      }
      const local = runLocalCommand(command.message);
      if (local) {
        respond(command.id, "prompt", true, local);
        return;
      }
      if (command.message === "/help") {
        out({ type: "command_output", text: "Fake help output" });
        respond(command.id, "prompt", true, { agentInvoked: false });
        return;
      }
      if (command.message === "/later") {
        respond(command.id, "prompt", true, {});
        setTimeout(() => {
          out({ type: "command_output", text: "Delayed output" });
          out({ type: "prompt_result", id: command.id, agentInvoked: false });
        }, 10);
        return;
      }
      respond(command.id, "prompt", true, { agentInvoked: true });
      setTimeout(() => {
        void runPromptTurn(command.message);
      }, 10);
      return;
    }
    case "steer":
      respond(command.id, "steer", true, { agentInvoked: true });
      if (holding) {
        const steeredText = `STEERED:${command.message}${command.images?.length ? `|IMAGES:${JSON.stringify(command.images)}` : ""}`;
        holding = false;
        out({ type: "message_start", message: { role: "assistant", content: [] } });
        out({
          type: "message_update",
          message: { role: "assistant", content: [] },
          assistantMessageEvent: { type: "text_delta", contentIndex: 0, delta: steeredText, partial: { role: "assistant", content: [] } },
        });
        out({
          type: "message_end",
          message: { role: "assistant", content: [{ type: "text", text: steeredText }] },
        });
        out({ type: "agent_end", messages: [], isTerminal: true });
      }
    case "follow_up":
      if (holding) {
        const followedText = `FOLLOWEDUP:${command.message}${command.images?.length ? `|IMAGES:${JSON.stringify(command.images)}` : ""}`;
        respond(command.id, "follow_up", true, {});
        holding = false;
        out({ type: "message_start", message: { role: "assistant", content: [] } });
        out({
          type: "message_update",
          message: { role: "assistant", content: [] },
          assistantMessageEvent: { type: "text_delta", contentIndex: 0, delta: followedText, partial: { role: "assistant", content: [] } },
        });
        out({
          type: "message_end",
          message: { role: "assistant", content: [{ type: "text", text: followedText }] },
        });
        out({ type: "agent_end", messages: [], isTerminal: true });
        return;
      }
      respond(command.id, "follow_up", true, { agentInvoked: true });
      setTimeout(() => {
        void runPromptTurn(command.message);
      }, 10);
      return;
    case "abort":
      respond(command.id, "abort", true, {});
      out({ type: "agent_end", messages: [], isTerminal: true });
      return;
    case "set_model":
      setModelCalls += 1;
      currentModel = { provider: command.provider, id: command.modelId };
      respond(command.id, "set_model", true, {});
      out({ type: "model_changed", model: currentModel });
      return;
    case "set_thinking_level":
      respond(command.id, "set_thinking_level", true, {});
      out({ type: "thinking_level_changed", thinkingLevel: command.level });
      return;
    case "compact":
      respond(command.id, "compact", true, {});
      return;
    case "set_auto_compaction":
      autoCompactionEnabled = command.enabled;
      respond(command.id, "set_auto_compaction", true, {});
      return;
    case "set_session_name":
      respond(command.id, "set_session_name", true, {});
      return;
    default:
      respond(command.id, command.type ?? "unknown", false, { error: `unsupported: ${command.type}` });
      return;
  }
});

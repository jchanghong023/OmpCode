// fake omp：讲 omp RPC-UI 的最小假核心，供适配器集成测试使用。
// 行为脚本：prompt → 流式文本 → write 工具（先 select 审批）→ 完成收口。
// v3 fork surface 行为（结构化审批/富 ask/fork 查询）在 fakeOmpV3.mjs。

import { createInterface } from "node:readline";
import { createV3Surface, PROMPT_SCENARIOS } from "./fakeOmpV3.mjs";

if (process.argv.slice(2).join(" ") !== "--mode rpc-ui") {
  throw new Error(`fake omp requires --mode rpc-ui, got: ${process.argv.slice(2).join(" ")}`);
}

const out = (frame) => process.stdout.write(`${JSON.stringify(frame)}\n`);
let counter = 0;
const nextId = () => `fake-${++counter}`;
let sessionFile = null;
const deniedTools = new Set();

// v3 fork surface 模式（rpc-ui-protocol 4.0）：ready 公告 [1,2,3]，协商成功后审批走
// permission_request、ask 走 ask_request、fork 查询命令可用；未协商时镜像真实 omp 的
// Unknown command 拒绝与 legacy extension_ui select 降级。
const v3Announced = process.env.FAKE_OMP_PROTOCOL_V3 === "1";
const v3 = createV3Surface({ out, nextId });

out({ type: "ready", protocolVersion: 1, supportedProtocolVersions: v3Announced ? v3.announce() : [1, 2], maxFrameBytes: 1048576, maxReassembledFrameBytes: 67108864 });

/** 文本轮：流式 delta（message_update）→ message_end 收口（投影器文本只来自 delta）。 */
function emitTextTurn(text) {
  out({ type: "message_start", message: { role: "assistant", content: [] } });
  out({
    type: "message_update",
    message: { role: "assistant", content: [] },
    assistantMessageEvent: { type: "text_delta", contentIndex: 0, delta: text, partial: { role: "assistant", content: [] } },
  });
  out({ type: "message_end", message: { role: "assistant", content: [{ type: "text", text }] } });
  out({ type: "agent_end", messages: [], isTerminal: true });
}

function respond(id, command, success, data) {
  out({ ...(id ? { id } : {}), type: "response", command, success, ...(data !== undefined ? { data } : {}) });
}

// HOLD 前缀：进入流式保持态（agent_start + 首段文本，不收口），用于测试 steer/follow_up 路由。
let holding = false;
// SLOW_TOOL_HOLD：工具在途保持态（tool_execution_start 后不收口），abort 时镜像真实 omp
// v18.3.5+fork.265 的中断序列（P2 验收 D1）：end(isError) → 尾随 update → agent_end。
let slowToolCallId = null;
let setModelCalls = 0;
let currentModel = { provider: "mock", id: "mock-1" };
let autoCompactionEnabled = true;
let subagentSubscription = "off";
let subagents = [];

function runLocalCommand(message) {
  const report = v3.localReport(message);
  if (report) return report;
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

async function runPromptTurn(message, promptId) {
  out({ type: "agent_start" });
  if (message === "ASK_ME") {
    if (v3.isV3()) {
      await v3.runAskTurn(emitTextTurn);
      return;
    }
    // 未协商 v3：ask 降级路径（4.0/4.3）——真实 omp 走逐题 select，这里以文本收口即可。
    emitTextTurn("legacy ask degraded");
    return;
  }
  if (message === "SECRET_INPUT") {
    if (v3.isV3()) {
      const token = await new Promise((resolve) => {
        const id = nextId();
        pendingUi.set(id, (cmd) => resolve(cmd.value));
        out({ type: "extension_ui_request", id, method: "input", title: "Login", message: "Enter access token", sensitive: true });
      });
      emitTextTurn(`token received: ${token}`);
      return;
    }
    // v1/v2 不携带 sensitive（4.3：login secret 输入 v3 解禁）；回落普通文本轮。
    emitTextTurn("legacy secret rejected");
    return;
  }
  if (message === "CUSTOM_TERMINAL_MESSAGE") {
    out({ type: "message_start", message: { role: "assistant", content: [] } });
    out({ type: "message_end", message: { role: "assistant", content: [{ type: "text", text: "Skill completed" }] } });
    out({
      type: "agent_end",
      messages: [
        { role: "custom", content: "Skill invocation context" },
        { role: "assistant", content: [{ type: "text", text: "Skill completed" }] },
      ],
      isTerminal: true,
    });
    return;
  }
  if (message === "SUBAGENT_REPORT") {
    const agent = { id: "fake-child-1", index: 0, agent: "scout", agentSource: "bundled", description: "Inspect project", status: "active", lastUpdate: Date.now(), parentToolCallId: "task-parent" };
    subagents = [agent];
    if (subagentSubscription !== "off") {
      out({ type: "subagent_lifecycle", payload: { ...agent, status: "started" } });
      out({
        type: "subagent_progress",
        payload: {
          index: 0,
          agent: "scout",
          agentSource: "bundled",
          task: "Inspect project",
          parentToolCallId: "task-parent",
          progress: { id: agent.id, status: "running", recentOutput: ["reading files"] },
        },
      });
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
    out({ type: "message_end", message: { role: "assistant", content: [], stopReason: "error", errorStatus: 401, errorMessage: "401 Model not supported" } });
    out({ type: "agent_end", messages: [], isTerminal: true });
    out({ type: "prompt_result", id: promptId, agentInvoked: true });
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
  if (message === "SLOW_TOOL_HOLD") {
    slowToolCallId = `toolu-${nextId()}`;
    out({ type: "tool_execution_start", toolCallId: slowToolCallId, toolName: "bash", args: { command: "sleep 60" } });
    return;
  }
  if (typeof message === "string" && message.startsWith("FOLLOWEDUP:")) {
    out({ type: "message_start", message: { role: "assistant", content: [] } });
    out({ type: "message_update", message: { role: "assistant", content: [] }, assistantMessageEvent: { type: "text_delta", contentIndex: 0, delta: message } });
    out({ type: "message_end", message: { role: "assistant", content: [{ type: "text", text: message }] } });
    out({ type: "agent_end", messages: [], isTerminal: true });
    return;
  }
  const scenario = PROMPT_SCENARIOS[message] ?? PROMPT_SCENARIOS.default;
  out({ type: "message_start", message: { role: "assistant", content: [] } });
  for (const delta of ["Hello", " wor", "ld!"]) {
    out({ type: "message_update", message: { role: "assistant", content: [] }, assistantMessageEvent: { type: "text_delta", contentIndex: 0, delta, partial: { role: "assistant", content: [] } } });
  }
  const toolCallId = `toolu-${nextId()}`;
  if (!sessionFile) {
    sessionFile = `${process.cwd()}/.fake-omp-sessions/session-1.jsonl`;
  }
  out({ type: "tool_execution_start", toolCallId, toolName: scenario.toolName, args: scenario.args });
  const approved = await requestApproval(toolCallId, scenario);
  if (approved) {
    out({ type: "tool_execution_end", toolCallId, toolName: scenario.toolName, result: { content: [{ type: "text", text: "wrote 2 lines" }] }, isError: false });
    out({
      type: "message_update",
      message: { role: "assistant", content: [] },
      assistantMessageEvent: { type: "text_delta", contentIndex: 1, delta: " Done.", partial: { role: "assistant", content: [] } },
    });
  } else {
    out({ type: "tool_execution_end", toolCallId, toolName: scenario.toolName, result: { content: [{ type: "text", text: "denied by user" }] }, isError: true });
    deniedTools.add(toolCallId);
  }
  out({ type: "message_end", message: { role: "assistant", content: [{ type: "text", text: "Hello world! Done." }], usage: { input: 120, output: 30 } } });
  out({ type: "agent_end", messages: [], isTerminal: true });
}

function requestApproval(toolCallId, scenario) {
  if (v3.isV3()) {
    return v3.requestApproval(toolCallId, scenario);
  }
  return requestLegacyApproval(toolCallId);
}

function requestLegacyApproval(toolCallId) {
  return new Promise((resolve) => {
    const id = nextId();
    pendingUi.set(id, (cmd) => resolve(cmd.value === "Approve"));
    out({ type: "extension_ui_request", id, method: "select", title: "Tool approval", message: `Approve write to greeting.txt? (toolCallId=${toolCallId})`, options: ["Approve", "Deny"] });
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
      resolve(command);
    }
    return;
  }
  if (v3.handleBypassFrame(command)) {
    return;
  }
  switch (command.type) {
    case "negotiate_protocol":
      v3.setNegotiatedVersion(command.protocolVersion);
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
      respond(command.id, "get_subagent_messages", true, {
        sessionFile: "fake-child.jsonl",
        fromByte: 0,
        nextByte: 1,
        reset: false,
        entries: [],
        messages: [{ role: "assistant", content: [{ type: "text", text: "Read README and reported findings." }] }],
      });
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
          { name: "skill:agent-browser", source: "skill", description: "Browse websites" },
          { name: "skill:architecture-governance", source: "skill", description: "Check architecture" },
        ],
      });
      return;
    case "get_available_thinking_levels":
      respond(command.id, "get_available_thinking_levels", true, { levels: ["off", "low", "high", "max"] });
      return;
    case "prompt": {
      if (command.message === "/context") {
        out({
          type: "command_output",
          text: "Context window: 200000 tokens (0% used)\n  System prompt [░░░░] 0%  200 tokens\n  Messages [░░░░] 0%  312 tokens\n  Free [████] 84%  169488 tokens\n  Auto-compact buf [████] 15%  30000 tokens",
        });
        respond(command.id, "prompt", true, { agentInvoked: false });
        return;
      }
      if (command.message.startsWith("/image-report ")) {
        const label = command.message.slice("/image-report ".length);
        out({ type: "command_output", text: `IMAGE_REPORT:${label}:${JSON.stringify({ hasImages: Object.hasOwn(command, "images"), images: command.images ?? [] })}` });
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
        void runPromptTurn(command.message, command.id);
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
        out({ type: "message_end", message: { role: "assistant", content: [{ type: "text", text: steeredText }] } });
        out({ type: "agent_end", messages: [], isTerminal: true });
      }
      return;
    case "follow_up":
      if (holding) {
        respond(command.id, "follow_up", true, {});
        holding = false;
        out({ type: "agent_end", messages: [], isTerminal: true });
        setTimeout(() => {
          void runPromptTurn(`FOLLOWEDUP:${command.message}${command.images?.length ? `|IMAGES:${JSON.stringify(command.images)}` : ""}`);
        }, 10);
        return;
      }
      respond(command.id, "follow_up", true, { agentInvoked: true });
      setTimeout(() => {
        void runPromptTurn(command.message);
      }, 10);
      return;
    case "abort":
      respond(command.id, "abort", true, {});
      if (slowToolCallId) {
        // 镜像真实 omp v18.3.5+fork.265 中断序列（P2 验收 D1）：
        // 先 end(isError:true)，再补一条带 partialResult 的尾随 tool_execution_update。
        out({ type: "tool_execution_end", toolCallId: slowToolCallId, toolName: "bash", result: { content: [{ type: "text", text: "Command aborted" }] }, isError: true });
        out({
          type: "tool_execution_update",
          toolCallId: slowToolCallId,
          toolName: "bash",
          args: { command: "sleep 60" },
          partialResult: { content: [{ type: "text", text: "[Command cancelled]\n" }] },
        });
        slowToolCallId = null;
      }
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
    case "test_model":
    case "list_mcp_servers":
      if (v3.isV3()) {
        v3.forkCommand(command);
      } else {
        v3.rejectForkCommand(command);
      }
      return;
    default:
      respond(command.id, command.type ?? "unknown", false, { error: `unsupported: ${command.type}` });
      return;
  }
});

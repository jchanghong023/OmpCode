// fake omp：讲 omp RPC-UI 的最小假核心，供适配器集成测试使用。
// 行为脚本：prompt → 流式文本 → write 工具（先 select 审批）→ 完成收口。
// v3 fork surface 行为（富 ask/审批 select/v3 目录命令）在 fakeOmpV3.mjs。
// 目录进程拉起形态 --mode rpc-ui --no-session 亦由本 fake 承载（get_state 等命令照常）。

import { createInterface } from "node:readline";
import { newStateFields } from "./fakeOmpNewCoreFrames.mjs";
import { localCommandMessage, out, pendingUi, respond, runLocalCommand, runPromptTurn, shared, v3 } from "./fakeOmpHelpers.mjs";

// 镜像真实 omp cli 的 flag 解析形状（args.ts reportUnrecognizedFlags → main.ts exit 2）：
// 本 fake 识别 --mode rpc-ui [--no-session] [--resume <path>]（目录进程/会话进程两种拉起形态）。
// 已删除的 fork 旗标（如 --rpc-project）按真实新核：stderr 报 unknown flag 并 exit 2。
const fakeArgv = process.argv.slice(2);
const knownValueFlags = new Set(["--resume"]);
const knownBareFlags = new Set(["--mode", "--no-session"]);
const unknownFlag = fakeArgv.find((arg, index) => arg.startsWith("--") && !knownBareFlags.has(arg) && !(knownValueFlags.has(arg) && typeof fakeArgv[index + 1] === "string"));
if (unknownFlag) {
  process.stderr.write(`Error: unknown flag: ${unknownFlag}\n`);
  process.stderr.write("Run `omp --help` for available flags.\n");
  process.exit(2);
}
if (!fakeArgv.includes("--mode") || fakeArgv[fakeArgv.indexOf("--mode") + 1] !== "rpc-ui") {
  throw new Error(`fake omp requires --mode rpc-ui, got: ${fakeArgv.join(" ")}`);
}

const v3Announced = process.env.FAKE_OMP_PROTOCOL_V3 === "1";

out({ type: "ready", protocolVersion: 1, supportedProtocolVersions: v3Announced ? v3.announce() : [1, 2], maxFrameBytes: 1048576, maxReassembledFrameBytes: 67108864 });

const readline = createInterface({ input: process.stdin });
readline.on("line", (line) => {
  let command;
  try {
    command = JSON.parse(line.trim());
  } catch {
    return;
  }
  if (v3.handleBypassFrame(command)) {
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
  switch (command.type) {
    case "negotiate_protocol":
      v3.setNegotiatedVersion(command.protocolVersion);
      respond(command.id, "negotiate_protocol", true, { protocolVersion: command.protocolVersion });
      return;
    case "get_state":
      respond(command.id, "get_state", true, {
        model: shared.currentModel,
        thinkingLevel: "max",
        autoCompactionEnabled: shared.autoCompactionEnabled,
        isStreaming: false,
        sessionFile: shared.sessionFile,
        sessionId: "fake-session-1",
        sessionName: null,
        contextUsage: { tokens: 512, contextWindow: 200000, percent: 0.25 },
        // D1 新帧容忍：新核 get_state 新字段（queuedMessages/goal）由
        // fakeOmpNewCoreFrames.mjs 按 FAKE_OMP_GET_STATE_NEW_FIELDS 注入。
        ...newStateFields(),
      });
      return;
    case "set_subagent_subscription":
      if (process.env.FAKE_OMP_SUBAGENT_SUBSCRIBE_FAIL === "1") {
        respond(command.id, "set_subagent_subscription", false, { error: "subscription unavailable" });
        return;
      }
      shared.subagentSubscription = command.level;
      respond(command.id, "set_subagent_subscription", true, { level: command.level });
      return;
    case "get_subagents":
      respond(command.id, "get_subagents", true, { subagents: shared.subagents });
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
          // fake 专属本地命令（严格分发按目录判定，必须随目录下发）：
          { name: "later", source: "builtin", description: "Delayed output" },
          { name: "title", source: "builtin", description: "Set session title", input: { hint: "<title>" } },
          { name: "model-report", source: "builtin", description: "Report set_model calls" },
          { name: "config-new", source: "builtin", description: "Emit config_update" },
          { name: "install-ship2", source: "builtin", description: "Emit available_commands_update" },
          { name: "failmodel", source: "builtin", description: "Fail a model turn" },
          { name: "image-report", source: "builtin", description: "Report prompt images", input: { hint: "<label>" } },
          { name: "text-report", source: "builtin", description: "Report prompt text" },
          { name: "approval-report", source: "builtin", description: "Report approval responses" },
          { name: "ask-report", source: "builtin", description: "Report ask responses" },
          { name: "context", source: "builtin", description: "Context report" },
        ],
      });
      return;
    case "get_available_thinking_levels":
      respond(command.id, "get_available_thinking_levels", true, { levels: ["off", "low", "high", "max"] });
      return;
    case "prompt": {
      const commandText = localCommandMessage(command.message);
      if (commandText === "/context") {
        out({
          type: "command_output",
          text: "Context window: 200000 tokens (0% used)\n  System prompt [░░░░] 0%  200 tokens\n  Messages [░░░░] 0%  312 tokens\n  Free [████] 84%  169488 tokens\n  Auto-compact buf [████] 15%  30000 tokens",
        });
        respond(command.id, "prompt", true, { agentInvoked: false });
        return;
      }
      const imageReportMatch = /^\/?image-report /.exec(commandText);
      if (imageReportMatch) {
        const label = commandText.slice(imageReportMatch[0].length);
        out({ type: "command_output", text: `IMAGE_REPORT:${label}:${JSON.stringify({ hasImages: Object.hasOwn(command, "images"), images: command.images ?? [] })}` });
        respond(command.id, "prompt", true, { agentInvoked: false });
        return;
      }
      if (/^\/?text-report /.test(commandText)) {
        out({ type: "command_output", text: `TEXT_REPORT:${JSON.stringify({ message: command.message, images: command.images ?? [] })}` });
        respond(command.id, "prompt", true, { agentInvoked: false });
        return;
      }
      const local = runLocalCommand(commandText);
      if (local) {
        respond(command.id, "prompt", true, local);
        return;
      }
      if (commandText === "/help") {
        out({ type: "command_output", text: "Fake help output" });
        respond(command.id, "prompt", true, { agentInvoked: false });
        return;
      }
      if (commandText === "/later") {
        respond(command.id, "prompt", true, {});
        setTimeout(() => {
          out({ type: "command_output", text: "Delayed output" });
          out({ type: "prompt_result", id: command.id, agentInvoked: false });
        }, 10);
        return;
      }
      if (command.message === "ABORT_AT_START") {
        // 协议条款 §14.4 / rpc-prompt-results.ts：被输入门取消的 prompt（abort 抢先于
        // dispatch，Idle with no run since acceptance）——success ACK 后不启动模型回合，
        // 仅补发恰一个 prompt_result{status:"aborted", agentInvoked:true, sessionSettled}。
        respond(command.id, "prompt", true);
        setTimeout(() => {
          out({ type: "prompt_result", id: command.id, agentInvoked: true, status: "aborted", sessionSettled: true });
        }, 10);
        return;
      }
      // 真实核（rpc-session-host.ts success(id,"prompt")）：agent 回合的 prompt 成功响应
      // 不带 data（本地命令才回 data.agentInvoked）。
      respond(command.id, "prompt", true);
      setTimeout(() => {
        void runPromptTurn(command.message, command.id);
      }, 10);
      return;
    }
    case "steer":
      // 真实核 steer 成功响应不带 data。
      respond(command.id, "steer", true);
      if (shared.holding) {
        const steeredText = `STEERED:${command.message}${command.images?.length ? `|IMAGES:${JSON.stringify(command.images)}` : ""}`;
        shared.holding = false;
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
      if (shared.holding) {
        respond(command.id, "follow_up", true);
        shared.holding = false;
        out({ type: "agent_end", messages: [], isTerminal: true });
        setTimeout(() => {
          void runPromptTurn(`FOLLOWEDUP:${command.message}${command.images?.length ? `|IMAGES:${JSON.stringify(command.images)}` : ""}`);
        }, 10);
        return;
      }
      respond(command.id, "follow_up", true);
      setTimeout(() => {
        void runPromptTurn(command.message);
      }, 10);
      return;
    case "abort":
      // 真实核 abort 成功响应不带 data。
      respond(command.id, "abort", true);
      if (shared.slowToolCallId) {
        // 镜像真实 omp v18.3.5+fork.265 中断序列（P2 验收 D1）：
        // 先 end(isError:true)，再补一条带 partialResult 的尾随 tool_execution_update。
        out({ type: "tool_execution_end", toolCallId: shared.slowToolCallId, toolName: "bash", result: { content: [{ type: "text", text: "Command aborted" }] }, isError: true });
        out({
          type: "tool_execution_update",
          toolCallId: shared.slowToolCallId,
          toolName: "bash",
          args: { command: "sleep 60" },
          partialResult: { content: [{ type: "text", text: "[Command cancelled]\n" }] },
        });
        shared.slowToolCallId = null;
      }
      out({ type: "agent_end", messages: [], isTerminal: true });
      return;
    case "set_model":
      shared.setModelCalls += 1;
      shared.currentModel = { provider: command.provider, id: command.modelId };
      respond(command.id, "set_model", true, {});
      out({ type: "model_changed", model: shared.currentModel });
      return;
    case "set_thinking_level":
      respond(command.id, "set_thinking_level", true, {});
      out({ type: "thinking_level_changed", thinkingLevel: command.level });
      return;
    case "compact":
      respond(command.id, "compact", true, {});
      return;
    case "set_auto_compaction":
      shared.autoCompactionEnabled = command.enabled;
      respond(command.id, "set_auto_compaction", true, {});
      return;
    case "set_session_name":
      respond(command.id, "set_session_name", true, {});
      return;
    case "set_ask_dialog":
      // 上游 v1 命令（rpc.md）：任何协商状态都接受，无 v3 门控。
      if (!v3.forkCommand(command)) {
        respond(command.id, "set_ask_dialog", true, { enabled: command.enabled === true });
      }
      return;
    case "complete_command":
    case "get_model_roles":
    case "set_model_role":
    case "list_sessions":
    case "rename_session":
    case "delete_session":
      if (v3.isV3()) {
        if (!v3.forkCommand(command)) {
          respond(command.id, command.type, false, { error: `unsupported: ${command.type}` });
        }
      } else {
        v3.rejectForkCommand(command);
      }
      return;
    case "cancel_subagent":
      respond(command.id, "cancel_subagent", true, { cancelled: true });
      return;
    case "steer_subagent":
      if (!command.message || String(command.message).length === 0) {
        respond(command.id, "steer_subagent", false, { error: "steer_subagent requires a message" });
        return;
      }
      respond(command.id, "steer_subagent", true);
      return;
    case "test_model":
    case "list_mcp_servers":
    case "execute_command":
      // v18.8.0+fork.298 起已删除的 fork 命令：镜像真实核的 Unknown command 拒绝。
      v3.rejectForkCommand(command);
      return;
    default:
      respond(command.id, command.type ?? "unknown", false, { error: `unsupported: ${command.type}` });
      return;
  }
});

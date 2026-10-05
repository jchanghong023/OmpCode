// fake omp 项目模式核心（rpc-ui-protocol.md §4/§13）：以 `node fakeOmpProject.mjs --mode
// rpc-ui --rpc-project` 拉起，实现项目模式 wire 协议的最小真实行为，供 omp-agent 的
// 项目拓扑 E2E 使用。不落盘真实会话；sessionFile 指向 env FAKE_OMP_SESSION_DIR 下
// 的占位 JSONL（测试可预写以驱动冷历史）。项目级目录/命令实现在 fakeOmpProjectCatalog.mjs。

import { mkdirSync, appendFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { createInterface } from "node:readline";
import { createProjectCommandHandler } from "./fakeOmpProjectCatalog.mjs";

const processInstanceId = `fake-proc-${Date.now().toString(36)}-${process.pid.toString(36)}`;
const markerPath = process.env.FAKE_OMP_MARKER;
const sessionDir = process.env.FAKE_OMP_SESSION_DIR ?? join(process.cwd(), ".fake-omp-sessions");
mkdirSync(sessionDir, { recursive: true });
if (markerPath) appendFileSync(markerPath, `start ${process.pid}\n`);

const generation = "g1";
const revision = "r1";
/** sessionId → {model, name, streaming, file} */
const sessions = new Map();
/** 最近一次用户输入文本（prompt/steer/follow_up，供 queuedMessages「同文本」变体回显）。 */
let lastInputText = null;

// D1 新帧容忍（仿 fakeOmp.mjs 的 FAKE_OMP_GET_STATE_NEW_FIELDS 先例）：get_state 注入
// 新核 queuedMessages 字段，形状与真实核一致（rpc-types.ts v18.4.8+fork.278
// RpcSessionState.queuedMessages = { steering: string[]; followUp: string[] }）。
// 「same」回显最近排队输入文本（与本地轮相同文本）；「diff」注入无关文本。默认不启用。
const queuedVariant = process.env.FAKE_OMP_GET_STATE_NEW_FIELDS ?? "";
function injectedQueuedMessages() {
  if (queuedVariant !== "same" && queuedVariant !== "diff") return undefined;
  if (queuedVariant === "same") {
    const text = lastInputText ?? "queued";
    return { steering: [text], followUp: [text] };
  }
  return { steering: ["stale unrelated steer"], followUp: ["stale unrelated follow-up"] };
}

/** 控制操作与命令执行的事实记录（测试断言用）。 */
const facts = {
  controls: [],
  executes: [],
  setModels: [],
  renames: [],
  subagentLists: [],
  subagentMessages: [],
  promptsBySession: new Map(),
};

function out(frame) {
  process.stdout.write(`${JSON.stringify(frame)}\n`);
}

function stamp(frame, sessionId) {
  return sessionId === undefined
    ? { ...frame, processInstanceId }
    : { ...frame, processInstanceId, sessionId, sessionGeneration: generation };
}

function sessionOut(sessionId, frame) {
  out(stamp(frame, sessionId));
}

function response(id, command, success, data, error, code) {
  const frame = { id, type: "response", command, success };
  if (data !== undefined) frame.data = data;
  if (error !== undefined) frame.error = error;
  if (code !== undefined) frame.code = code;
  return frame;
}

function sessionFileOf(sessionId) {
  return join(sessionDir, `${sessionId}.jsonl`);
}

function ensureSession(id) {
  if (!sessions.has(id)) {
    sessions.set(id, {
      model: { provider: "fake", id: "fake-model" },
      name: null,
      streaming: false,
    });
  }
  return sessions.get(id);
}

function streamAssistantTurn(sessionId, promptId, text, emitPromptResult = true) {
  const session = ensureSession(sessionId);
  session.streaming = true;
  sessionOut(sessionId, { type: "agent_start" });
  sessionOut(sessionId, { type: "message_start", message: { role: "assistant", content: [] } });
  const parts = text.match(/.{1,4}/g) ?? [text];
  for (const part of parts) {
    sessionOut(sessionId, {
      type: "message_update",
      message: { role: "assistant", content: [] },
      assistantMessageEvent: {
        type: "text_delta",
        contentIndex: 0,
        delta: part,
        partial: { role: "assistant", content: [] },
      },
    });
  }
  sessionOut(sessionId, {
    type: "message_end",
    message: { role: "assistant", content: [{ type: "text", text }] },
  });
  sessionOut(sessionId, { type: "agent_end", messages: [], isTerminal: true });
  session.streaming = false;
  // 真实核仅 prompt/abort_and_prompt 开 prompt ticket（rpc-prompt-results.ts）：steer/
  // follow_up 等非 ticket 路径不以命令 id 补发 prompt_result，轮次完成以流式事件为准。
  if (emitPromptResult) {
    sessionOut(sessionId, { type: "prompt_result", id: promptId, agentInvoked: true });
  }
}

function streamSubagentTurn(sessionId, promptId) {
  // 每轮 spawn 计数：get_subagent_messages 的记录随之增长（见 fakeOmpProjectCatalog.subagentEntries），
  // 供「详情视图实时增长」用例在第二轮 spawn 后断言新增行。
  facts.subagentSpawns = (facts.subagentSpawns ?? 0) + 1;
  const session = ensureSession(sessionId);
  session.streaming = true;
  sessionOut(sessionId, { type: "agent_start" });
  sessionOut(sessionId, {
    type: "subagent_lifecycle",
    payload: {
      id: "sa-1",
      agent: "scout",
      status: "started",
      description: "scan files",
      parentToolCallId: "tc-1",
      sessionFile: sessionFileOf(`${sessionId}-sa-1`),
    },
  });
  sessionOut(sessionId, {
    type: "subagent_progress",
    payload: {
      agent: "scout",
      assignment: "scan files",
      parentToolCallId: "tc-1",
      progress: { id: "sa-1", status: "running", recentOutput: ["scanning"] },
    },
  });
  sessionOut(sessionId, {
    type: "subagent_event",
    payload: {
      id: "sa-1",
      event: { type: "message_start", message: { role: "assistant", content: [] } },
    },
  });
  sessionOut(sessionId, {
    type: "subagent_event",
    payload: {
      id: "sa-1",
      event: {
        type: "message_update",
        message: { role: "assistant", content: [] },
        assistantMessageEvent: {
          type: "text_delta",
          contentIndex: 0,
          delta: "subagent streaming detail",
          partial: { role: "assistant", content: [] },
        },
      },
    },
  });
  sessionOut(sessionId, {
    type: "subagent_event",
    payload: {
      id: "sa-1",
      event: {
        type: "message_end",
        message: {
          role: "assistant",
          content: [{ type: "text", text: "subagent streaming detail" }],
        },
      },
    },
  });
  sessionOut(sessionId, {
    type: "message_end",
    message: { role: "assistant", content: [{ type: "text", text: "subagent finished" }] },
  });
  sessionOut(sessionId, { type: "agent_end", messages: [], isTerminal: true });
  sessionOut(sessionId, {
    type: "subagent_lifecycle",
    payload: {
      id: "sa-1",
      agent: "scout",
      status: "completed",
      description: "scan files",
      parentToolCallId: "tc-1",
    },
  });
  session.streaming = false;
  sessionOut(sessionId, { type: "prompt_result", id: promptId, agentInvoked: true });
}

function handleSessionCommand(command) {
  const id = command.id;
  const sessionId = command.sessionId;
  if (typeof sessionId !== "string" || !sessionId) {
    return response(
      id,
      String(command.type),
      false,
      undefined,
      "This command requires a sessionId in project mode",
      "invalid_params",
    );
  }
  if (!sessions.has(sessionId)) {
    return response(
      id,
      String(command.type),
      false,
      undefined,
      `Unknown session: ${sessionId}`,
      "not_found",
    );
  }
  const session = ensureSession(sessionId);
  switch (command.type) {
    case "prompt": {
      const count = (facts.promptsBySession.get(sessionId) ?? 0) + 1;
      facts.promptsBySession.set(sessionId, count);
      const message = String(command.message ?? "");
      lastInputText = message;
      if (
        command.inputMode !== undefined &&
        command.inputMode !== "text" &&
        command.inputMode !== "auto"
      ) {
        return response(id, command.type, false, undefined, "invalid inputMode", "invalid_params");
      }
      if (message.includes("spawn subagent")) {
        setImmediate(() => streamSubagentTurn(sessionId, id));
        return response(id, command.type, true);
      }
      setImmediate(() => streamAssistantTurn(sessionId, id, `echo:${message}`));
      return response(id, command.type, true);
    }
    case "steer":
    case "follow_up":
      // 真实核（rpc-session-host.ts）：steer/follow_up 成功响应不带 data，也从不补发
      // prompt_result（不开 prompt ticket）；轮次完成以流式事件/terminal agent_end 为准。
      lastInputText = String(command.message ?? "");
      setImmediate(() =>
        streamAssistantTurn(sessionId, null, `queued:${String(command.message ?? "")}`, false),
      );
      return response(id, command.type, true);
    case "abort":
      return response(id, command.type, true);
    case "get_state": {
      const queuedMessages = injectedQueuedMessages();
      return response(id, command.type, true, {
        model: session.model,
        thinkingLevel: "low",
        isStreaming: session.streaming,
        sessionFile: sessionFileOf(sessionId),
        sessionId,
        sessionName: session.name,
        messageCount: facts.promptsBySession.get(sessionId) ?? 0,
        autoCompactionEnabled: true,
        contextUsage: { tokens: 100, contextWindow: 1000, percent: 10 },
        ...(queuedMessages !== undefined ? { queuedMessages } : {}),
      });
    }
    case "set_model": {
      const provider = String(command.provider ?? "");
      const modelId = String(command.modelId ?? "");
      if (!provider || !modelId) {
        return response(id, command.type, false, undefined, "invalid model", "invalid_params");
      }
      session.model = { provider, id: modelId };
      facts.setModels.push({ sessionId, provider, modelId });
      sessionOut(sessionId, { type: "model_changed" });
      // 真实核 set_model ACK 携带解析后的模型对象（rpc-session-host success(id,"set_model",model)）。
      return response(id, command.type, true, { provider, id: modelId });
    }
    case "set_thinking_level":
      return response(id, command.type, true);
    case "set_subagent_subscription":
      return response(id, command.type, true, { level: command.level });
    case "get_entries":
      return response(id, command.type, true, { entries: [] });
    case "get_messages":
      return response(id, command.type, true, { messages: [] });
    case "set_session_name":
      session.name = String(command.name ?? "");
      return response(id, command.type, true);
    case "get_available_thinking_levels":
      return response(id, command.type, true, { levels: ["off", "low", "high"] });
    case "set_auto_compaction":
      return response(id, command.type, true);
    case "compact":
      // 真实核 compact ACK 携带 CompactionResult（summary/firstKeptEntryId/tokensBefore 等）。
      return response(id, command.type, true, {
        summary: "compact",
        shortSummary: "compact",
        firstKeptEntryId: null,
        tokensBefore: 0,
        details: [],
        preserveData: null,
      });
    default:
      return response(
        id,
        String(command.type),
        false,
        undefined,
        `Unknown session command: ${String(command.type)}`,
      );
  }
}

const handleProjectCommand = createProjectCommandHandler({
  sessions,
  revision,
  sessionOut,
  ensureSession,
  sessionFileOf,
  facts,
  streamAssistantTurn,
});

const PROJECT_COMMANDS = new Set([
  "negotiate_protocol",
  "create_session",
  "list_sessions",
  "resume_session",
  "close_session",
  "rename_session",
  "delete_session",
  "get_available_commands",
  "complete_command",
  "execute_command",
  "list_skills",
  "get_model_roles",
  "set_model_role",
  "get_available_models",
  "get_subagents",
  "get_subagent_messages",
  "control_subagent",
]);

// FAKE_OMP_NO_PROJECT_MODE=1：模拟旧内嵌核（ready 无 rpc-ui-project）——网关应整体
// 永久回落旧拓扑，项目方法按 -32601 能力缺失报错（区别于启动失败的 -32000 可重试）。
const noProjectMode = process.env.FAKE_OMP_NO_PROJECT_MODE === "1";

out({
  type: "ready",
  protocolVersion: 1,
  supportedProtocolVersions: [1, 2, 3],
  maxFrameBytes: 2_097_152,
  maxReassembledFrameBytes: 16_777_216,
  ...(noProjectMode ? {} : { mode: "rpc-ui-project" }),
  projectIdentity: { projectRoot: process.cwd() },
  processInstanceId,
  capabilities: {
    projectMode: !noProjectMode,
    multiSession: true,
    commandCompletion: true,
    executeCommand: true,
    skillManagement: true,
    subagentHistory: true,
    subagentControl: true,
    modelRoleConfig: true,
  },
});

const readline = createInterface({ input: process.stdin });
readline.on("line", (line) => {
  if (line.trim().length === 0) return;
  let command;
  try {
    command = JSON.parse(line);
  } catch {
    return;
  }
  if (command.type === "dump_facts") {
    out({ type: "facts", facts });
    return;
  }
  const result = PROJECT_COMMANDS.has(command.type)
    ? handleProjectCommand(command)
    : handleSessionCommand(command);
  // 真实 omp 的会话 response 不带 sessionId 戳；客户端进程层按发送记录（命令
  // id→sessionId）路由回会话通道（见 OmpProjectProcess.dispatchFrame）。
  out(result);
});
readline.once("close", () => {
  if (markerPath) appendFileSync(markerPath, `exit ${process.pid}\n`);
  writeFileSync(join(sessionDir, "facts.json"), JSON.stringify(facts));
  process.exit(0);
});

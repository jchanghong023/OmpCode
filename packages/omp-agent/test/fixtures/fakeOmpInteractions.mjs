// 真实 stdout 协议形状（Main、write agent://、嵌套 task 与 irc_message）；无模型调用。
import { createInterface } from "node:readline";
import { appendFile, mkdir, writeFile } from "node:fs/promises";
import { join } from "node:path";
const out = (frame) => process.stdout.write(`${JSON.stringify(frame)}\n`);
const respond = (command, data = {}) =>
  out({ type: "response", id: command.id, command: command.type, success: true, data });
const rootFile = process.env.FAKE_INTERACTION_SESSION_FILE;
const at = 1_800_000_000_000;
const call = (id, name, args) => ({
  type: "message",
  message: {
    role: "assistant",
    timestamp: at,
    content: [{ type: "toolCall", id, name, arguments: args }],
  },
});
const result = (id, name, details) => ({
  type: "message",
  message: { role: "toolResult", toolCallId: id, toolName: name, timestamp: at + 30, details },
});
const custom = (id, from, body) => ({
  role: "custom",
  customType: "irc:incoming",
  display: true,
  content: body,
  timestamp: at + 10,
  details: { id, from, message: body, replyTo: "prior-message" },
});
out({
  type: "ready",
  protocolVersion: 1,
  supportedProtocolVersions: [1, 2],
  maxFrameBytes: 1048576,
  maxReassembledFrameBytes: 67108864,
});
createInterface({ input: process.stdin }).on("line", async (line) => {
  const command = JSON.parse(line);
  switch (command.type) {
    case "get_state":
      respond(command, {
        sessionFile: rootFile,
        sessionId: process.env.FAKE_INTERACTION_SESSION_ID,
        model: { provider: "mock", id: "mock-1" },
        isStreaming: false,
        thinkingLevel: "high",
      });
      return;
    case "get_available_models":
      respond(command, {
        models: [
          {
            provider: "mock",
            id: "mock-1",
            name: "Mock",
            thinking: { mode: "effort", efforts: ["high"], defaultLevel: "high" },
          },
        ],
      });
      return;
    case "get_available_commands":
      respond(command, { commands: [] });
      return;
    case "get_subagents":
      respond(command, { subagents: [] });
      return;
    case "get_subagent_messages":
      respond(command, { entries: [], messages: [], fromByte: 0, nextByte: 0, reset: false });
      return;
    case "prompt": {
      if (command.message === "/context") {
        respond(command, { agentInvoked: false });
        return;
      }
      await appendFile(process.env.FAKE_INTERACTION_PROMPT_LOG, "prompt\n");
      respond(command);
      out({ type: "agent_start" });
      const task = result("spawn", "task", {
        progress: [
          { id: "Alpha", agent: "task", assignment: "inspect", status: "running" },
          { id: "Beta", agent: "task", assignment: "review", status: "running" },
        ],
      });
      const sendCall = call("root-send", "write", {
        path: "agent://Alpha",
        content: "main-to-alpha",
      });
      const sendResult = result("root-send", "write", {
        message: {
          op: "send",
          from: "Main",
          to: "Alpha",
          receipts: [{ to: "Alpha", outcome: "injected" }],
        },
      });
      const reply = custom("reply-id", "Alpha", "alpha-to-main");
      const rootEntries = [task, sendCall, sendResult, { type: "message", message: reply }];
      const alphaEntries = [
        { type: "message", message: custom("root-send-id", "Main", "main-to-alpha") },
        result("nested-spawn", "task", {
          progress: [
            { id: "Alpha.Gamma", agent: "task", assignment: "nested-inspect", status: "running" },
          ],
        }),
      ];
      const betaEntries = [
        { type: "message", message: custom("peer-id", "Alpha", "alpha-to-beta") },
      ];
      const gammaEntries = [
        { type: "message", message: custom("nested-id", "Beta", "beta-to-gamma") },
      ];
      const rootStem = rootFile.slice(0, -6);
      await mkdir(join(rootStem, "Alpha"), { recursive: true });
      await appendFile(rootFile, `${rootEntries.map(JSON.stringify).join("\n")}\n`);
      await writeFile(
        join(rootStem, "Alpha.jsonl"),
        `${alphaEntries.map(JSON.stringify).join("\n")}\n`,
      );
      await writeFile(
        join(rootStem, "Beta.jsonl"),
        `${betaEntries.map(JSON.stringify).join("\n")}\n`,
      );
      await writeFile(
        join(rootStem, "Alpha", "Alpha.Gamma.jsonl"),
        `${gammaEntries.map(JSON.stringify).join("\n")}\n`,
      );
      for (const entry of rootEntries) out({ type: "message_end", message: entry.message });
      out({ type: "irc_message", message: reply });
      out({
        type: "subagent_event",
        payload: { id: "Alpha", event: { type: "irc_message", message: alphaEntries[0].message } },
      });
      out({
        type: "irc_message",
        message: {
          role: "custom",
          customType: "irc:relay",
          content: "relay",
          display: true,
          timestamp: at + 10,
          details: { from: "Alpha", to: "Beta", body: "alpha-to-beta" },
        },
      });
      out({
        type: "subagent_event",
        payload: { id: "Beta", event: { type: "irc_message", message: betaEntries[0].message } },
      });
      out({ type: "agent_end", messages: [], isTerminal: true });
      return;
    }
    default:
      respond(command);
      return;
  }
});

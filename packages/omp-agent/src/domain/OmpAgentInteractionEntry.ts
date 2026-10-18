import { interactionObject } from "./OmpAgentInteractionRecords.js";

/** live 只保留与交互相关的原始结构，不复制普通对话、thinking 或用户输入。 */
export function interactionEntryFromEvent(value: unknown): unknown | null {
  const event = interactionObject(value);
  if (!event) return null;
  if (event.type === "irc_message" || event.type === "message_end") {
    const message = interactionObject(event.message);
    if (
      message?.role === "custom" &&
      (String(message.customType).startsWith("irc:") || message.customType === "async-result")
    )
      return { type: "message", message };
    if (message?.role === "assistant") {
      const content = (Array.isArray(message.content) ? message.content : []).filter((value) => {
        const block = interactionObject(value);
        const args = interactionObject(block?.arguments);
        return (
          block?.type === "toolCall" &&
          (["irc", "task", "wait"].includes(String(block.name)) ||
            (block.name === "write" &&
              typeof args?.path === "string" &&
              args.path.startsWith("agent://")))
        );
      });
      return content.length
        ? { type: "message", message: { role: "assistant", timestamp: message.timestamp, content } }
        : null;
    }
    const details = interactionObject(message?.details);
    if (
      message?.role === "toolResult" &&
      (["irc", "task", "wait"].includes(String(message.toolName)) ||
        (message.toolName === "write" && interactionObject(details?.message)?.op === "send"))
    )
      return { type: "message", message };
  }
  if (!["irc", "task", "wait", "write"].includes(String(event.toolName))) return null;
  if (event.toolName === "write" && event.type === "tool_execution_start") {
    const args = interactionObject(event.args);
    if (typeof args?.path !== "string" || !args.path.startsWith("agent://")) return null;
  }
  if (event.type === "tool_execution_start")
    return {
      type: "message",
      message: {
        role: "assistant",
        content: [
          { type: "toolCall", id: event.toolCallId, name: event.toolName, arguments: event.args },
        ],
      },
    };
  if (event.type === "tool_execution_update" || event.type === "tool_execution_end") {
    const result = interactionObject(
      event.type === "tool_execution_end" ? event.result : event.partialResult,
    );
    const details = interactionObject(result?.details);
    if (event.toolName === "write" && interactionObject(details?.message)?.op !== "send")
      return null;
    return result
      ? {
          type: "message",
          message: {
            role: "toolResult",
            toolName: event.toolName,
            toolCallId: event.toolCallId,
            ...result,
          },
        }
      : null;
  }
  return null;
}

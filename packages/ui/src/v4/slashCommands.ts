export type V4VisibleSlashCommand =
  | {
      kind: "compact";
      displayText: string;
    }
  | {
      kind: "sendGoalCommand";
      objective: string;
      displayText: string;
    }
  | {
      kind: "resumeGoal";
      displayText: string;
    }
  | {
      kind: "emptyGoal";
      displayText: string;
    }
  | {
      kind: "unsupportedGoal";
      action: string;
      displayText: string;
    };

export interface V4VisibleSlashCommandParseOptions {
  contextAttachmentCount?: number;
  /** 仅由 OMP 启动事实和实际目录提供；null 表示原生已知但目录尚不可判定，旧 Agent 不传。 */
  nativeCommandNames?: readonly string[] | null;
}

export interface SelectionSideSlashCommand {
  command: "side" | "btw";
  text: string;
  displayText: string;
}

export interface SelectionSideSlashCommandParseOptions {
  contextAttachmentCount?: number;
  /** CLI catalog 中已经注册的同名命令；同名 CLI 命令优先，不由 App 消费。 */
  enabledCommandNames?: readonly string[];
}

const GOAL_COMMAND_RE = /^\/(?:goal|target)(?:\s|$)/i;

/** 只识别名称归属，不解析参数；原生目录未就绪时保留 slash 输入交给原生判定。 */
export function isRegisteredNativeSlashCommand(
  content: string,
  nativeCommandNames: readonly string[] | null = [],
): boolean {
  const name = /^\s*\/([^\s]+)/.exec(content)?.[1]?.toLowerCase();
  return (
    name !== undefined &&
    (nativeCommandNames === null ||
      nativeCommandNames.some((candidate) => candidate.replace(/^\/+/, "").toLowerCase() === name))
  );
}

export function parseV4VisibleSlashCommand(
  content: string,
  attachments: readonly unknown[] = [],
  options: V4VisibleSlashCommandParseOptions = {},
): V4VisibleSlashCommand | null {
  // Bug 原因：旧 goal/compact parser 会拒绝合法 OMP 子操作并丢弃参数；已注册命令交回原生。
  if (isRegisteredNativeSlashCommand(content, options.nativeCommandNames)) return null;
  const displayText = content.trim();
  if (!displayText.startsWith("/")) return null;
  const match = /^\/([^\s]+)(?:\s+([\s\S]*))?$/.exec(displayText);
  if (!match) return null;
  const commandName = match[1]?.toLowerCase() ?? "";
  const args = match[2]?.trim() ?? "";

  if (attachments.length > 0 || (options.contextAttachmentCount ?? 0) > 0) {
    return null;
  }

  if (commandName === "compact" || commandName === "compress") {
    return { kind: "compact", displayText };
  }
  if (commandName !== "goal" && commandName !== "target") {
    return null;
  }
  if (!args) return { kind: "emptyGoal", displayText };

  const action = args.split(/\s+/, 1)[0]?.toLowerCase() ?? "";
  if (action === "resume") return { kind: "resumeGoal", displayText };
  if (action === "pause" || action === "clear" || action === "show") {
    return { kind: "unsupportedGoal", action, displayText };
  }
  const objective = action === "replace" ? args.replace(/^replace\s*/i, "").trim() : args;
  if (!objective) return { kind: "emptyGoal", displayText };
  return { kind: "sendGoalCommand", objective, displayText };
}

/**
 * 解析带首条输入的选择副屏命令。
 *
 * 这是 App 层的完整输入消费门：只接受整条文本，且只在没有附件/结构化上下文时
 * 命中。参数只去除首尾空白，保留正文内部的空格和换行，避免改写用户原文。
 */
export function parseSelectionSideSlashCommand(
  content: string,
  attachments: readonly unknown[] = [],
  options: SelectionSideSlashCommandParseOptions = {},
): SelectionSideSlashCommand | null {
  if (attachments.length > 0 || (options.contextAttachmentCount ?? 0) > 0) return null;
  const displayText = content.trim();
  const match = /^\/(side|btw)(?:\s+([\s\S]*))?$/i.exec(displayText);
  if (!match) return null;
  const command = match[1]?.toLowerCase() as SelectionSideSlashCommand["command"] | undefined;
  const enabledNames = options.enabledCommandNames;
  if (
    enabledNames &&
    !enabledNames.some((name) => name.trim().replace(/^\/+/, "").toLowerCase() === command)
  ) {
    return null;
  }
  const text = match[2]?.trim() ?? "";
  if (!text || !command) return null;
  return { command, text, displayText };
}

export function v4QueuedCommandText(kind: "sendText" | "sendGoalCommand", text: string): string {
  if (kind !== "sendGoalCommand") return text;
  const trimmed = text.trim();
  if (!trimmed) return text;
  return GOAL_COMMAND_RE.test(trimmed) ? text : `/goal ${trimmed}`;
}

export function extractV4GoalObjective(text: string): string {
  const parsed = parseV4VisibleSlashCommand(v4QueuedCommandText("sendGoalCommand", text));
  return parsed?.kind === "sendGoalCommand" ? parsed.objective : text.trim();
}

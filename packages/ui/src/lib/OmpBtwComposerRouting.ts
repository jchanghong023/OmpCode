import type { AppSlashCommand } from "../slashCommandHelpers.js";
import type { PromptInputSuggestionItem } from "./promptInputTriggers.js";
import {
  parseSelectionSideSlashCommand,
  type SelectionSideSlashCommand,
} from "../v4/slashCommands.js";

const commandName = (value: string): string => value.trim().replace(/^\/+/, "").toLowerCase();
const isSideAlias = (value: string): boolean => value === "side" || value === "btw";

/** 原生 btw 目录保留 tui-only 事实；GUI 中已提供的两个本地业务别名优先，不改其它目录命令。 */
export function mergeOmpBtwSlashSuggestions(
  nativeItems: PromptInputSuggestionItem[],
  appItems: PromptInputSuggestionItem[],
): PromptInputSuggestionItem[] {
  if (!appItems.length) return nativeItems;
  const nativeNames = new Set(nativeItems.map((item) => commandName(item.value)));
  const localSideNames = new Set(
    appItems.map((item) => commandName(item.value)).filter(isSideAlias),
  );
  return [
    ...nativeItems.filter((item) => !localSideNames.has(commandName(item.value))),
    ...appItems.filter((item) => {
      const name = commandName(item.value);
      return isSideAlias(name) || !nativeNames.has(name);
    }),
  ];
}

export function resolveOmpBtwComposerCommand(
  text: string,
  appCommands: readonly AppSlashCommand[] | undefined,
): SelectionSideSlashCommand | null {
  if (!appCommands?.length) return null;
  const command = parseSelectionSideSlashCommand(text);
  return command && appCommands.some((item) => commandName(item.value) === command.command)
    ? command
    : null;
}

/** 富输入与普通 text 共用此消费门；在主会话配置/排队路由前决定，不向普通 prompt 放行附件别名。 */
export function routeOmpBtwComposerInput(
  text: string,
  appCommands: readonly AppSlashCommand[] | undefined,
  options:
    | {
        attachments?: readonly unknown[];
        contextAttachmentCount?: number;
      }
    | undefined,
  open: (question: string) => Promise<boolean>,
): Promise<"sent" | "blocked"> | null {
  const command = resolveOmpBtwComposerCommand(text, appCommands);
  if (!command) return null;
  if (options?.attachments?.length || options?.contextAttachmentCount) {
    return Promise.reject(new Error("辅助对话只支持文本，不支持附件或结构化上下文"));
  }
  return open(command.text).then<"sent" | "blocked">((created) => (created ? "sent" : "blocked"));
}

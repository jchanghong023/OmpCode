// 斜杠命令目录解析器（omp-core-integration.md「斜杠输入严格分发」）。
// omp v18.8.0 起无 execute_command：未知 "/xxx" 会被 omp 当普通文本送入模型，严格分发
// （未知命令报错、绝不发给模型）由适配层按目录本地判定。目录事实源 = 工作区目录进程的
// get_available_commands（v3 协商后为富目录，携带 execution/availability 判定；
// v1 形状无判定字段，按「在目录内即可执行」处理——v1 目录本就只含 ACP 可执行命令）。
// available_commands_update（v1 形状）到达即失效缓存；unknown 命中时重读一次目录复核，
// 防止目录变化窗口内误拒新装命令。

import {
  ompAvailableCommandsV3ResultSchema,
  type OmpDirectoryCommandDescriptor,
} from "../domain/ompForkFrames.js";
import type { OmpDirectoryGatewayPort } from "./ports.js";
import type { SlashCommandResolution, SlashCommandResolver } from "./ompPromptDispatch.js";

/** 从输入文本取命令名段（首个空白前的 token，含 "skill:name" 形态）。 */
function commandNameOf(text: string): string {
  const token = text.trim().split(/\s+/)[0] ?? "";
  return token.replace(/^\/+/, "");
}

/** 目录内判定：name/aliases 命中且 omp 可执行（execution!="tui"、availability 未拒绝）。 */
function resolveAgainst(
  descriptors: readonly OmpDirectoryCommandDescriptor[],
  text: string,
): SlashCommandResolution {
  const name = commandNameOf(text);
  if (!name) return { kind: "reject", reason: "unknown", commandName: name };
  const descriptor = descriptors.find(
    (candidate) => candidate.name === name || candidate.aliases?.includes(name),
  );
  if (!descriptor) return { kind: "reject", reason: "unknown", commandName: name };
  if (descriptor.execution === "tui") {
    return { kind: "reject", reason: "tui_only", commandName: name };
  }
  const availability = descriptor.availability;
  if (
    typeof availability === "object" &&
    availability !== null &&
    (availability as { available?: unknown }).available === false
  ) {
    return { kind: "reject", reason: "tui_only", commandName: name };
  }
  return { kind: "dispatch" };
}

export function createSlashCommandResolver(directory: OmpDirectoryGatewayPort): {
  resolve: SlashCommandResolver;
  invalidate: () => void;
} {
  let descriptors: OmpDirectoryCommandDescriptor[] | null = null;
  let refreshing: Promise<void> | null = null;

  async function refresh(): Promise<void> {
    if (refreshing) return refreshing;
    refreshing = (async () => {
      const outcome = await directory.send({ type: "get_available_commands" }).catch(() => null);
      if (outcome?.success) {
        const parsed = ompAvailableCommandsV3ResultSchema.safeParse(outcome.data);
        if (parsed.success) descriptors = parsed.data.commands;
      }
    })().finally(() => {
      refreshing = null;
    });
    return refreshing;
  }

  return {
    async resolve(text: string): Promise<SlashCommandResolution> {
      if (!descriptors) await refresh();
      let resolution = resolveAgainst(descriptors ?? [], text);
      if (resolution.kind === "reject" && resolution.reason === "unknown") {
        // unknown 复核一次：目录变化窗口内的新命令不得误拒（重读失败保持原判定）。
        await refresh();
        resolution = resolveAgainst(descriptors ?? [], text);
      }
      return resolution;
    },
    invalidate(): void {
      descriptors = null;
    },
  };
}

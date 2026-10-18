import type { OmpSessionProcess } from "./ports.js";
import { applyEngineModelSelection } from "./ompEngineProcess.js";

/** ompAttachmentInput 拼接文本附件的段落前缀（同包产出，格式由其定义）。 */
const TEXT_ATTACHMENT_MARKER = "\n\n<attached_file ";

/**
 * 斜杠命令目录解析结果：可执行（目录内且 omp 可执行）→ dispatch；其余 → 本地拒绝。
 * 解析器由引擎注入（目录进程 v3 富目录；omp v18.8.0 起无 execute_command，严格分发改在
 * 适配层本地判定：未知命令报错，绝不发给模型——omp 会把未知 "/xxx" 当普通文本送入模型）。
 */
export type SlashCommandResolver = (text: string) => Promise<SlashCommandResolution>;

export type SlashCommandResolution =
  | { kind: "dispatch" }
  | { kind: "reject"; reason: "unknown" | "tui_only"; commandName: string };

export async function dispatchOmpText(input: {
  process: OmpSessionProcess;
  sourceCommandId: string;
  text: string;
  /** 原始用户文本：合并附件正文不得绕过斜杠判定。 */
  originalText?: string;
  images: { type: "image"; data: string; mimeType: string }[];
  streaming: boolean;
  /** owner 租约在每个 await 后复核，Stop/失败/退出后的续体不得投递旧输入。 */
  isCurrent: () => boolean;
  modelSelection?: { provider: string; model: string; thought?: string };
  currentConfig: { provider: string; model: string; thought: string };
  /** 斜杠命令目录解析器（引擎注入；缺省时不做严格分发，按普通文本发送）。 */
  resolveSlashCommand?: SlashCommandResolver;
}): Promise<{ success: boolean; data?: unknown; code?: string; error?: string }> {
  const { text, images } = input;
  if (!input.isCurrent())
    return { success: false, code: "omp_input_cancelled", error: "input dispatch cancelled" };
  // 修复（G9）：被拒输入不得先改写会话模型——「斜杠命令 + 附件」守卫前置于
  // applyEngineModelSelection，模型选择只在输入被接受后执行。
  const originalText = input.originalText ?? text;
  const mergedTextAttachment = text !== originalText || text.includes(TEXT_ATTACHMENT_MARKER);
  const slashCommand = originalText.trimStart().startsWith("/");
  if (slashCommand) {
    // 修复（F8/A6）：斜杠命令无附件载体（目录内命令走 prompt 本地执行，images 被忽略），
    // 带图片时不能静默丢弃附件，必须明确失败让用户改用无附件命令或把图片说明写入命令参数；
    // 文本附件由 v4Commands 经 ompAttachmentInput 拼进文本，按拼接标记识别并拒绝。
    if (images.length > 0 || mergedTextAttachment) {
      return {
        success: false,
        code: "omp_command_attachments_unsupported",
        error:
          images.length > 0
            ? "斜杠命令暂不支持同时发送图片附件；请去掉附件后重发，或把图片说明写入命令参数"
            : "斜杠命令暂不支持同时发送文本附件；请去掉附件后重发，或把附件说明写入命令参数",
      };
    }
    if (input.resolveSlashCommand) {
      // 斜杠严格分发（omp-core-integration.md）：适配层按命令目录本地判定——目录内且 omp
      // 可执行 → 以 prompt 文本发送（omp 本地执行，agentInvoked:false + command_output
      // 收口）；未知或仅 TUI 可执行 → 明确报错，绝不发给模型（omp 会把未知 "/xxx" 当普通
      // 文本送入模型）。
      const resolution = await input.resolveSlashCommand(originalText.trimStart());
      if (!input.isCurrent())
        return { success: false, code: "omp_input_cancelled", error: "input dispatch cancelled" };
      if (resolution.kind === "reject") {
        return {
          success: false,
          code: resolution.reason === "unknown" ? "omp_command_unknown" : "omp_command_tui_only",
          error:
            resolution.reason === "unknown"
              ? `未知命令：${resolution.commandName}（omp 命令目录中不存在）`
              : `命令 ${resolution.commandName} 需要终端运行时，当前宿主不可执行`,
        };
      }
    }
  }
  if (input.modelSelection) {
    const failure = await applyEngineModelSelection(
      input.process,
      input.modelSelection,
      input.currentConfig,
      input.isCurrent,
    );
    if (failure) return { success: false, code: failure.code, error: failure.message };
  }
  if (!input.isCurrent())
    return { success: false, code: "omp_input_cancelled", error: "input dispatch cancelled" };
  const attachment = images.length > 0 ? { images } : {};
  // 仅 native guide 会在运行中投递；queue 由 owner 在成功终态后一项一项发普通 prompt。
  const outcome = await input.process.send(
    input.streaming && !slashCommand
      ? { id: input.sourceCommandId, type: "steer", message: text, ...attachment }
      : { id: input.sourceCommandId, type: "prompt", message: text, ...attachment },
  );
  return outcome.success ? outcome : { ...outcome, code: "omp_prompt_failed" };
}

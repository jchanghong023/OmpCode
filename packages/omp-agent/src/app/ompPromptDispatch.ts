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

/**
 * steer/follow_up 分发 success ACK 的 seen 登记出口（F2b-P1）。
 * 依据（omp v18.4.8 源码核对）：#queueUserMessage（agent-session.ts:8053-8170）在
 * `await session.followUp()/steer(userMessage)` 完成后才返回，rpc handler 在 await 之后才回
 * success ACK ⇒ ACK 到达即该文本已入 omp 队列；而 agent-loop.ts:1754-1763 的停止边界
 * drain 可在入队后短于 250ms debounce 窗口内消费该消息（queue_update 被 debounce 合并、
 * terminal agent_end 的去重还会清掉未触发的 debounce 定时器），队列快照可能从未携带它。
 * 引擎在进程创建时按进程注册出口（registerQueueDispatchAckSink，见 conversationEngine
 * 接线），分发成功时把分发文本作为单元素快照回传，由引擎经对账器 markOnly 路径立即
 * 登记 seen。
 * 边界备查（新核输入门，v18.4.10+）：输入门取消的 steer/follow_up 同样回 success 但未入队
 * （rpc-ui-protocol §14.4「success≠入队」），该场景「ACK 即 seen」会把门取消误判为合并
 * 消费（宽限 interrupted 被抬升为 success）。升级内嵌核时必须随备查项复查本出口。
 */
export type QueueDispatchAckSink = (text: string) => void;

/** 每进程一个登记出口（WeakMap 弱引用随进程回收；各会话引擎持有各自独立的进程对象）。 */
const queueDispatchAckSinks = new WeakMap<OmpSessionProcess, QueueDispatchAckSink>();

/** 引擎接线入口：注册进程的分发 success ACK 出口（重复注册覆盖旧出口）。 */
export function registerQueueDispatchAckSink(
  process: OmpSessionProcess,
  sink: QueueDispatchAckSink,
): void {
  queueDispatchAckSinks.set(process, sink);
}

export async function dispatchOmpText(input: {
  process: OmpSessionProcess;
  text: string;
  /** 原始用户文本：合并附件正文不得绕过斜杠判定。 */
  originalText?: string;
  images: { type: "image"; data: string; mimeType: string }[];
  streaming: boolean;
  followupMode: "queue" | "guide";
  modelSelection?: { provider: string; model: string; thought?: string };
  currentConfig: { provider: string; model: string; thought: string };
  /** 斜杠命令目录解析器（引擎注入；缺省时不做严格分发，按普通文本发送）。 */
  resolveSlashCommand?: SlashCommandResolver;
}): Promise<{ success: boolean; data?: unknown; code?: string; error?: string }> {
  const { text, images } = input;
  // 修复（G9）：被拒输入不得先改写会话模型——「斜杠命令 + 附件」守卫前置于
  // applyEngineModelSelection，模型选择只在输入被接受后执行。
  const originalText = input.originalText ?? text;
  const mergedTextAttachment = text !== originalText || text.includes(TEXT_ATTACHMENT_MARKER);
  if (!input.streaming && originalText.trimStart().startsWith("/")) {
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
    );
    if (failure) return { success: false, code: failure.code, error: failure.message };
  }
  const attachment = images.length > 0 ? { images } : {};
  if (input.streaming) {
    // 流式中的补充输入始终按文本（steer 引导本轮 / follow_up 入队），不做命令分发，
    // 附件守卫也不适用（steer/follow_up 的 images 载荷完整支持）。
    const command =
      input.followupMode === "guide"
        ? { type: "steer" as const, message: text, ...attachment }
        : { type: "follow_up" as const, message: text, ...attachment };
    const outcome = await input.process.send(command);
    if (outcome.success) {
      // 修复（F2b-P1）：success ACK ⇒ 该分发文本已入 omp 队列。立即以 markOnly 登记 seen，
      // 消除「停止边界 drain 快于 250ms debounce、快照从未携带」时序窗口内的宽限误判
      // interrupted；未注册出口（如纯分发层测试）静默跳过。
      queueDispatchAckSinks.get(input.process)?.(text);
    }
    // 修复（G15）：code 只表达失败类别，成功结果不携带。
    return outcome.success ? outcome : { ...outcome, code: "omp_prompt_failed" };
  }
  const outcome = await input.process.send({ type: "prompt", message: text, ...attachment });
  return outcome.success ? outcome : { ...outcome, code: "omp_prompt_failed" };
}

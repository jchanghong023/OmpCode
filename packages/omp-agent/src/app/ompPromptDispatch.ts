import type { OmpSessionProcess } from "./ports.js";
import { applyEngineModelSelection } from "./ompEngineProcess.js";

/** ompAttachmentInput 拼接文本附件的段落前缀（同包产出，格式由其定义）。 */
const TEXT_ATTACHMENT_MARKER = "\n\n<attached_file ";

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
 * 消费（宽限 interrupted 被抬升为 success）。当前内嵌核 v18.4.8 无输入门，「ACK ⇒ 已入队」
 * 判据成立；升级内嵌核时必须随备查项⑦复查本出口。
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
  images: { type: "image"; data: string; mimeType: string }[];
  streaming: boolean;
  followupMode: "queue" | "guide";
  modelSelection?: { provider: string; model: string; thought?: string };
  currentConfig: { provider: string; model: string; thought: string };
}): Promise<{ success: boolean; data?: unknown; code?: string; error?: string }> {
  const { text, images } = input;
  // 修复（G9）：被拒输入不得先改写会话模型——「项目模式 + 斜杠命令 + 附件」守卫
  // 前置于 applyEngineModelSelection，模型选择只在输入被接受后执行。
  // 修复（F8）：execute_command 协议无附件载体（domain/ompProjectFrames.ts），带图片时
  // 不能静默丢弃附件，必须明确失败让用户改用无附件命令或把图片说明写入命令参数。
  // 修复（A6）：文本附件由 v4Commands 经 ompAttachmentInput 拼进 prompt 文本（该层拿不到
  // projectMode），"/xxx"+文本附件会把 <attached_file> 块拼进 execute_command 的命令文本；
  // 在能拿到 projectMode 的最近层按拼接标记识别并拒绝，普通消息的拼接行为保持不变。
  const mergedTextAttachment = text.includes(TEXT_ATTACHMENT_MARKER);
  if (
    input.process.projectMode &&
    text.startsWith("/") &&
    (images.length > 0 || mergedTextAttachment)
  ) {
    return {
      success: false,
      code: "omp_command_attachments_unsupported",
      error:
        images.length > 0
          ? "斜杠命令暂不支持同时发送图片附件；请去掉附件后重发，或把图片说明写入命令参数"
          : "斜杠命令暂不支持同时发送文本附件；请去掉附件后重发，或把附件说明写入命令参数",
    };
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
    // 流式中的补充输入始终按文本（steer 引导本轮 / follow_up 入队），不做命令分发。
    const command =
      input.followupMode === "guide"
        ? { type: "steer" as const, message: text, ...attachment }
        : { type: "follow_up" as const, message: text, ...attachment };
    const outcome = await input.process.send(command);
    if (outcome.success) {
      // 修复（F2b-P1）：success ACK ⇒ 该分发文本已入 omp 队列（v18.4.8 事实，边界见
      // registerQueueDispatchAckSink 注释）。立即以 markOnly 登记 seen，消除「停止边界
      // drain 快于 250ms debounce、快照从未携带」时序窗口内的宽限误判 interrupted；
      // 未注册出口（如纯分发层测试）静默跳过。
      queueDispatchAckSinks.get(input.process)?.(text);
    }
    // 修复（G15）：code 只表达失败类别，成功结果不携带。
    return outcome.success ? outcome : { ...outcome, code: "omp_prompt_failed" };
  }
  if (input.process.projectMode && text.startsWith("/")) {
    // 项目模式（rpc-ui-protocol §14.4）：prompt 默认 inputMode text；"/xxx" 输入改走
    // execute_command 严格分发——未知命令报错，绝不发给模型。
    // （附件守卫已前置于模型选择，此处进入分支的输入必无附件。）
    const outcome = await input.process.send({ type: "execute_command", text });
    return outcome.success ? outcome : { ...outcome, code: "omp_command_failed" };
  }
  const command = input.process.projectMode
    ? { type: "prompt" as const, message: text, ...attachment, inputMode: "text" as const }
    : { type: "prompt" as const, message: text, ...attachment };
  const outcome = await input.process.send(command);
  return outcome.success ? outcome : { ...outcome, code: "omp_prompt_failed" };
}

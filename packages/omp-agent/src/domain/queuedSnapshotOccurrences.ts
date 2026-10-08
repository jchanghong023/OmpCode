// omp-agent/domain：投影宿主的文本快照 occurrence 对账，不持有第二份已接受输入队列。
// queuedTurns/inputTextByTurnId 仍由 ConversationProjection 唯一拥有；这里只保留真实快照的身份。
import type { TurnContext } from "./projectionRows.js";

// 仅声明匹配需要的只读出口；不能反向导入生命周期模块形成类型依赖环。
interface QueueSnapshotHost {
  queuedTurns: readonly TurnContext[];
  inputTextByTurnId: ReadonlyMap<string, string>;
}
/**
 * S4-1 seen 登记（「在场历史」）：omp 停止边界会把排队 follow_up 出队合并进同一 run 消费
 * 并回答（agent-loop.ts:1754-1763——任一 run 结束前 dequeue followUp 并 continue 同一 run，
 * 不产生新 agent_start，被消费文本的回复在同一 run 内流式输出），是主流路径。因此
 * 「terminal agent_end 快照缺席」不能一刀切 interrupted：只有曾在任一 omp 队列快照
 * （queue_update 事件载荷或空闲 get_state 的 queuedMessages，经 promptQueueReconciler
 * 传入，含流式 markOnly 调用）中「在场」过的排队轮，缺席才说明已被停止边界 drain
 * 消费。success ACK 可能来自输入门取消，不能构造队列事实。
 * 登记表以 TurnContext 对象身份为键；快照 occurrence 也保留其绑定身份，避免重复快照
 * 把同一文本事实重新分配给后来提交的同文命令。弱引用按投影宿主隔离，随宿主回收。
 */
export const queueSeenTurns = new WeakSet<TurnContext>();
// 流式 markOnly 可以证明旧项已经缺席，但暂不收口；下次新增 occurrence 必须交给下一轮。
export const queueDrainedTurns = new WeakSet<TurnContext>();

interface QueueSnapshotOccurrence {
  text: string;
  turn: TurnContext | null;
}
const queueSnapshotOccurrences = new WeakMap<QueueSnapshotHost, QueueSnapshotOccurrence[]>();
/**
 * 斜杠命令的命令名段：输入首个 ASCII 空白（空格、\t、\n、\v、\f、\r）前的段落
 * （"/deploy prod --yes" → "/deploy"，"/deploy" → "/deploy"）。不用正则匹配控制字符，
 * 逐字符扫描即可（omp 命令名不含这些字符之外的边界语义）。
 */
function slashCommandNameOf(inputText: string): string {
  for (let index = 0; index < inputText.length; index += 1) {
    const char = inputText[index];
    if (
      char === " " ||
      char === "\t" ||
      char === "\n" ||
      char === "\v" ||
      char === "\f" ||
      char === "\r"
    ) {
      return inputText.slice(0, index);
    }
  }
  return inputText;
}

/**
 * 排队文本与 omp 队列快照文本匹配（S4-4，F2b-P2 收紧）：先按原文全等；omp 队列 chip 文本
 * 是模板展开/改写后的内容（agent-session.ts queueChipText 返回「入队后内容首个 text 块」
 * 而非提交原文），原文全等会对斜杠命令假缺席。对 "/" 开头的排队文本按命令名段比对：
 * chip 等于命令名段（裸命令 chip）或以「命令名段 + 空格」开头（同命令参数 chip）才命中。
 * 修复（F2b-P2/XR-B）：此前的 chip 前缀匹配（ompText.startsWith(inputText)）会让
 * "/deploy" 误命中不同命令的 chip "/deploy-prod"，把未消费的 /deploy 轮误标 seen，
 * 随后空快照再把它误收口 success。
 */
function queueTextMatchesOf(inputText: string, ompText: string): boolean {
  if (ompText === inputText) return true;
  if (!inputText.startsWith("/")) return false;
  const commandName = slashCommandNameOf(inputText);
  return ompText === commandName || ompText.startsWith(`${commandName} `);
}

/** 文本快照没有 commandId：每个 occurrence 只绑定一轮，重复快照沿用绑定而非重新分配。 */
export function matchQueueSnapshotOf(
  host: QueueSnapshotHost,
  queueTexts: string[],
): Set<TurnContext> | null {
  if (host.queuedTurns.length === 0) {
    // 空快照证明上一批 occurrence 已消失；无本地等待轮的非空快照不建立新输入身份。
    if (queueTexts.length === 0) queueSnapshotOccurrences.delete(host);
    return null;
  }
  const previous = queueSnapshotOccurrences.get(host) ?? [];
  const remaining = new Map<string, QueueSnapshotOccurrence[]>();
  for (const occurrence of previous) {
    const sameText = remaining.get(occurrence.text);
    if (sameText) sameText.push(occurrence);
    else remaining.set(occurrence.text, [occurrence]);
  }
  const occurrences = queueTexts.map((text) => ({
    text: text.trim(),
    turn: null as TurnContext | null,
  }));
  const present = new Set<TurnContext>();
  const retained = new Set<QueueSnapshotOccurrence>();
  const currentByText = new Map<string, QueueSnapshotOccurrence[]>();
  for (const occurrence of occurrences) {
    const sameText = currentByText.get(occurrence.text);
    if (sameText) sameText.push(occurrence);
    else currentByText.set(occurrence.text, [occurrence]);
  }
  // 相同文本缩减时核心按 FIFO 消费队首，保留原快照后缀；增长时新事实位于保留项之后。
  for (const [text, current] of currentByText) {
    const prior = remaining.get(text);
    if (!prior) continue;
    const start = Math.max(0, prior.length - current.length);
    for (let index = 0; index < Math.min(prior.length, current.length); index += 1) {
      const occurrence = current[index]!;
      occurrence.turn = prior[start + index]!.turn;
      retained.add(occurrence);
      if (occurrence.turn) present.add(occurrence.turn);
    }
  }
  // 只为新增 occurrence 按本地队列顺序分配身份。已经出队的旧绑定仍占用该快照事实，
  // 否则 A 的重复快照会在 A 已消费、B 尚未接纳时把 B 错误登记为 seen。
  for (const turn of host.queuedTurns) {
    if (present.has(turn) || queueDrainedTurns.has(turn)) continue;
    const text = (host.inputTextByTurnId.get(turn.turnId) ?? "").trim();
    if (text.length === 0) continue;
    const occurrence = occurrences.find(
      (candidate) =>
        !retained.has(candidate) &&
        candidate.turn === null &&
        queueTextMatchesOf(text, candidate.text),
    );
    if (!occurrence) continue;
    occurrence.turn = turn;
    present.add(turn);
  }
  queueSnapshotOccurrences.set(host, occurrences);
  return present;
}

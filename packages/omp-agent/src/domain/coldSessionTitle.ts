// omp 会话文件标题解析（自 coldHistory.ts 拆出）。

/**
 * 从条目中提取会话标题（S7-2，对齐 omp 权威语义的优先级）：
 * ① 首行 type:"title" 固定宽度槽位（session-title-slot.ts：建文件首行写入可变当前标题；
 *    rpc-project-sessions 冷改名只原地重写该行不追加条目；omp session-listing 也只认物理首行）；
 * ② 最后一条 title_change（session-manager 每次 setSessionName 追加，最后一条最新）；
 * ③ header.title（type:"session" 头条目，如条目形状可辨；无槽位的旧版文件只有它）；
 * ④ 首条用户消息截断。
 * 现状缺陷（已修）：原先返回第一条 title_change 即胜出——冷改名后槽位已更新而旧
 * title_change 仍在文件中部，导致恢复列表显示过期标题。
 */
export function titleFromOmpEntries(entries: unknown[]): string | null {
  let slotTitle: string | null = null;
  let lastChangeTitle: string | null = null;
  let headerTitle: string | null = null;
  let firstUserText: string | null = null;
  for (const [index, entry] of entries.entries()) {
    if (typeof entry !== "object" || entry === null) {
      continue;
    }
    const record = entry as Record<string, unknown>;
    // 槽位只认物理首行（omp parseTitleSlotFromContent 只取第一行；防御式解析不校验 v/pad）。
    if (
      index === 0 &&
      record.type === "title" &&
      typeof record.title === "string" &&
      record.title.length > 0
    ) {
      slotTitle = record.title;
      continue;
    }
    if (
      record.type === "title_change" &&
      typeof record.title === "string" &&
      record.title.length > 0
    ) {
      lastChangeTitle = record.title;
    } else if (
      headerTitle === null &&
      record.type === "session" &&
      typeof record.title === "string" &&
      record.title.length > 0
    ) {
      headerTitle = record.title;
    }
    if (
      firstUserText === null &&
      record.type === "message" &&
      typeof record.message === "object" &&
      record.message !== null &&
      "role" in record.message &&
      record.message.role === "user"
    ) {
      // 字符串是当前 omp 的合法用户正文形状；标题扫描不能因此抛错中断列表。
      const content = "content" in record.message ? record.message.content : undefined;
      const text = (
        typeof content === "string"
          ? content
          : Array.isArray(content)
            ? content
                .filter((block) => block?.type === "text" && typeof block.text === "string")
                .map((block) => block.text)
                .join(" ")
            : ""
      ).trim();
      if (text.length > 0) {
        firstUserText = text;
      }
    }
  }
  return slotTitle ?? lastChangeTitle ?? headerTitle ?? firstUserText;
}

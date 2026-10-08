export function resolveReasoningStreamingSummary(
  streamingText: string,
): { key: string; text: string } | null {
  // 收起态只需要最后一个有效行。原先 replace/split 每个增量都复制并遍历累计全文；
  // 从尾部查找保留相同摘要语义，并用原文行起点保持同一行追加时的滚动身份。
  let end = streamingText.length;
  while (end > 0) {
    let start = end;
    while (start > 0) {
      const character = streamingText.charCodeAt(start - 1);
      if (character === 10 || character === 13) break;
      start -= 1;
    }
    const text = streamingText.slice(start, end).trim();
    if (text.length > 0) return { key: String(start), text };
    if (start === 0) return null;

    end = start - 1;
    if (
      streamingText.charCodeAt(end) === 10 &&
      end > 0 &&
      streamingText.charCodeAt(end - 1) === 13
    ) {
      end -= 1;
    }
  }
  return null;
}

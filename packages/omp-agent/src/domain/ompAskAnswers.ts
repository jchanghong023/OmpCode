function object(value: unknown): Record<string, unknown> | null {
  return typeof value === "object" && value !== null && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : null;
}

/**
 * 修复：ask 正文只是展示摘要，不能据此重建答案；live/冷恢复统一读取 OMP 已提交 details。
 * 调用方只允许成功的 ask 结果进入；空答不伪造选择，畸形结构不猜测修复。
 */
export function ompAskAnswers(details: unknown): Record<string, string[]> | null {
  const record = object(details);
  if (!record) return null;
  const results = record.results === undefined ? [record] : record.results;
  if (!Array.isArray(results)) return null;
  const entries: [string, string[]][] = [];
  for (const raw of results) {
    const result = object(raw);
    if (
      !result ||
      typeof result.question !== "string" ||
      !result.question.trim() ||
      !Array.isArray(result.selectedOptions) ||
      !result.selectedOptions.every((value) => typeof value === "string" && value.trim()) ||
      (result.customInput !== undefined && typeof result.customInput !== "string")
    )
      return null;
    const answers = [...(result.selectedOptions as string[])];
    if (typeof result.customInput === "string" && result.customInput.trim()) {
      answers.push(result.customInput);
    }
    // 两个题目的文字可以完全相同（需求：同文也按题序分别应答）；按题面作键会被
    // Object.fromEntries 覆盖成"末题答案渲染两遍"。题 id 由 OMP 原样回传且唯一，
    // 故优先用 id 作键（UI 的 answers[question.id] 兜底读取对齐），缺 id 才退回题面。
    const id = typeof result.id === "string" && result.id.trim() ? result.id : undefined;
    if (answers.length > 0) entries.push([id ?? result.question, answers]);
  }
  return entries.length > 0 ? Object.fromEntries(entries) : null;
}

// 从 omp 工具调用入参提取文件变更事实（路径、写入/编辑计数、行数增删估计）。
// omp 没有独立的文件变更事件；write/edit 工具的入参是权威来源（docs/rpc.md 事件面）。
// 行数统计是「内容事实」的估计值（write=新内容行数、edit=新旧串行数差），与 omp 自身
// 展示口径一致，不承诺与 git diff 完全一致。

export interface FileFactItem {
  path: string;
  additions: number;
  deletions: number;
  writeCount: number;
  toolNames: string[];
  patches: {
    oldStart: number;
    oldLines: number;
    newStart: number;
    newLines: number;
    lines: string[];
  }[];
}

interface FileFactAccumulator extends FileFactItem {}

function countLines(value: string | undefined): number {
  if (!value) {
    return 0;
  }
  const trimmed = value.replace(/\n$/, "");
  if (trimmed.length === 0) {
    return 0;
  }
  return trimmed.split("\n").length;
}

function asRecord(value: unknown): Record<string, unknown> | undefined {
  return typeof value === "object" && value !== null ? (value as Record<string, unknown>) : undefined;
}

function normalizePath(path: string | undefined): string | null {
  if (typeof path !== "string" || path.trim().length === 0) {
    return null;
  }
  return path.replace(/\\/g, "/");
}

export class TurnFileFacts {
  private itemsByKey = new Map<string, FileFactAccumulator>();

  static fromSummary(summary: { files: number; additions: number; deletions: number } | undefined): TurnFileFacts {
    // 历史轮不驻留明细；摘要级事实足够 fileChanges 查询的聚合数字，明细为空。
    const facts = new TurnFileFacts();
    if (summary && summary.files > 0) {
      facts.placeholderSummary = { ...summary };
    }
    return facts;
  }

  private placeholderSummary: { files: number; additions: number; deletions: number } | null = null;

  recordToolResult(input: { toolName: string; input?: Record<string, unknown>; resultDetails?: unknown }): void {
    const toolName = input.toolName;
    const args = input.input;
    if (toolName === "write" || toolName === "edit" || toolName === "multiedit") {
      this.recordWriteOrEdit(toolName, args, input.resultDetails);
      return;
    }
    if (toolName === "bash" || toolName === "shell") {
      // bash 修改的文件不可静态归因；不纳入文件面板（与 ZCode 原生 rewind 忽略 bash 的口径一致）。
      return;
    }
  }

  private recordWriteOrEdit(toolName: string, args: Record<string, unknown> | undefined, resultDetails: unknown): void {
    if (!args) {
      return;
    }
    if (toolName === "write") {
      const path = normalizePath(typeof args.path === "string" ? args.path : undefined);
      const content = typeof args.content === "string" ? args.content : undefined;
      if (!path) {
        return;
      }
      const additions = countLines(content);
      this.accumulate(path, { additions, deletions: 0, toolName, patch: buildPatch(0, additions, content ? `-${content}` : "") });
      return;
    }
    if (typeof args.input === "string") {
      // 默认 hashline edit 把路径放在 [path#TAG] 段中，实际增删由成功结果的 diff 给出。
      const paths = [...args.input.matchAll(/^\[([^\]\r\n]+)#[0-9A-F]{4}\]$/gm)]
        .map((match) => normalizePath(match[1]))
        .filter((path): path is string => path !== null);
      const diff = asRecord(resultDetails)?.diff;
      const changes = typeof diff === "string" ? changesFromUnifiedDiff(diff, paths[0]) : [];
      const changedPaths = new Set(changes.map((item) => item.path));
      for (const change of changes) {
        this.accumulate(change.path, { ...change, toolName, patch: buildPatch(change.deletions, change.additions, change.lines) });
      }
      for (const path of new Set(paths)) {
        if (!changedPaths.has(path)) this.accumulate(path, { additions: 0, deletions: 0, toolName });
      }
      return;
    }
    // edit：replace 形态 {path, old_string, new_string}；patch 形态 {path, edits:[...]}。
    const path = normalizePath(typeof args.path === "string" ? args.path : undefined);
    if (!path) {
      return;
    }
    const oldString = typeof args.old_string === "string" ? args.old_string : undefined;
    const newString = typeof args.new_string === "string" ? args.new_string : undefined;
    if (oldString !== undefined || newString !== undefined) {
      const deletions = countLines(oldString);
      const additions = countLines(newString);
      const lines = [
        ...(oldString ? oldString.split("\n").map((line) => `-${line}`) : []),
        ...(newString ? newString.split("\n").map((line) => `+${line}`) : []),
      ];
      this.accumulate(path, { additions, deletions, toolName, patch: buildPatch(deletions, additions, lines) });
      return;
    }
    const edits = Array.isArray(args.edits) ? args.edits : [];
    let additions = 0;
    let deletions = 0;
    const patches: FileFactItem["patches"] = [];
    for (const edit of edits) {
      const record = asRecord(edit);
      const diff = typeof record?.diff === "string" ? record.diff : undefined;
      if (diff) {
        const lines = diff.split("\n");
        const added = lines.filter((line) => line.startsWith("+") && !line.startsWith("++")).length;
        const removed = lines.filter((line) => line.startsWith("-") && !line.startsWith("--")).length;
        additions += added;
        deletions += removed;
        patches.push(buildPatch(removed, added, lines));
      }
    }
    if (additions > 0 || deletions > 0) {
      this.accumulate(path, { additions, deletions, toolName, patches });
    }
  }

  private accumulate(path: string, fact: { additions: number; deletions: number; toolName: string; patch?: FileFactItem["patches"][number]; patches?: FileFactItem["patches"] }): void {
    this.placeholderSummary = null;
    const existing = this.itemsByKey.get(path);
    const patches = [...(existing?.patches ?? []), ...(fact.patches ?? (fact.patch ? [fact.patch] : []))].slice(-20);
    this.itemsByKey.set(path, {
      path,
      additions: (existing?.additions ?? 0) + fact.additions,
      deletions: (existing?.deletions ?? 0) + fact.deletions,
      writeCount: (existing?.writeCount ?? 0) + 1,
      toolNames: dedupe([...(existing?.toolNames ?? []), fact.toolName]),
      patches,
    });
  }

  summary(): { files: number; additions: number; deletions: number } {
    if (this.placeholderSummary) {
      return this.placeholderSummary;
    }
    const items = this.items();
    return {
      files: items.length,
      additions: items.reduce((total, item) => total + item.additions, 0),
      deletions: items.reduce((total, item) => total + item.deletions, 0),
    };
  }

  items(): FileFactItem[] {
    if (this.placeholderSummary) {
      return [];
    }
    return [...this.itemsByKey.values()];
  }
}

function changesFromUnifiedDiff(diff: string, fallbackPath: string | undefined): { path: string; additions: number; deletions: number; lines: string[] }[] {
  const changes = new Map<string, { path: string; additions: number; deletions: number; lines: string[] }>();
  let path = fallbackPath;
  for (const line of diff.split("\n")) {
    if (line.startsWith("+++ ")) {
      const next = line.slice(4).replace(/^b\//, "").trim();
      path = next === "/dev/null" ? undefined : normalizePath(next) ?? undefined;
      continue;
    }
    if (!path || line.startsWith("--- ") || line.startsWith("@@")) continue;
    if (!line.startsWith("+") && !line.startsWith("-")) continue;
    const item = changes.get(path) ?? { path, additions: 0, deletions: 0, lines: [] };
    if (line.startsWith("+")) item.additions += 1;
    else item.deletions += 1;
    item.lines.push(line);
    changes.set(path, item);
  }
  return [...changes.values()];
}

function buildPatch(oldLines: number, newLines: number, lines: string | string[]): FileFactItem["patches"][number] {
  const lineArray = typeof lines === "string" ? lines.split("\n") : lines;
  return {
    oldStart: 1,
    oldLines,
    newStart: 1,
    newLines,
    lines: lineArray.slice(0, 200),
  };
}

function dedupe(values: string[]): string[] {
  return [...new Set(values)];
}

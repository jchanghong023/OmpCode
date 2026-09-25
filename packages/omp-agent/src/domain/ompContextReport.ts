// omp /context 的 RPC command_output 是带 ANSI 色码的本地命令文本；
// 仅从其中提取带单位的 token 事实，百分比由 UI 按 get_state 容量重算。
export interface OmpContextReport {
  contextWindow: number;
  entries: { label: string; tokens: number }[];
}

const ANSI_COLOR = new RegExp(String.fromCharCode(27) + String.raw`\[[0-9;]*m`, "g");
const CONTEXT_HEADER = /^Context window:\s*([\d,]+)\s+tokens\b/i;
const CONTEXT_ENTRY =
  /^\s*(.{1,60}?)\s+\[[^\]]*\]\s+<?[\d.]+%\s+([\d,.]+)\s*(K|M|G)?\s+tokens?\s*$/i;

export function parseOmpContextReport(output: string): OmpContextReport | null {
  const lines = output.replace(ANSI_COLOR, "").split(/\r?\n/);
  const header = lines.map((line) => CONTEXT_HEADER.exec(line)).find(Boolean);
  const contextWindow = Number(header?.[1]?.replaceAll(",", ""));
  if (!Number.isSafeInteger(contextWindow) || contextWindow <= 0) return null;

  const entries: OmpContextReport["entries"] = [];
  for (const line of lines) {
    const match = CONTEXT_ENTRY.exec(line);
    if (!match) continue;
    const multiplier =
      { K: 1_000, M: 1_000_000, G: 1_000_000_000 }[match[3]?.toUpperCase() as "K" | "M" | "G"] ?? 1;
    const tokens = Number(match[2]?.replaceAll(",", "")) * multiplier;
    if (!Number.isFinite(tokens) || tokens < 0) continue;
    entries.push({ label: match[1]!.trim(), tokens });
    if (entries.length === 32) break;
  }
  return entries.length > 0 ? { contextWindow, entries } : null;
}

import { readFile, access, stat } from "node:fs/promises";
import { createHash } from "node:crypto";
import { commandOutput } from "./test-gates-process.mjs";

// 源码快照与 Git 文本工具：指纹只取成功 Git 命令的 stdout，避免 LF/CRLF 诊断
// 与跨流拼接顺序不稳定造成的误判（从进程模块拆出以守住 400 行架构上限）。

export async function gitText(args) {
  const result = await commandOutput("git", args, { quiet: true, stdoutOnly: true });
  if (result.code) throw new Error(result.output.trim());
  return result.output;
}

export async function snapshot() {
  const [headText, diff, untrackedText, statusText] = await Promise.all([
    gitText(["rev-parse", "HEAD"]),
    gitText(["diff", "--binary", "HEAD"]),
    gitText(["ls-files", "--others", "--exclude-standard", "-z"]),
    gitText(["status", "--short"]),
  ]);
  const head = headText.trim();
  const untracked = untrackedText.split("\0").filter(Boolean).sort();
  const hash = createHash("sha256").update(diff);
  for (const name of untracked) {
    // 原因：git ls-files --others 会把空未跟踪目录（如 CI 上 tsc 预构建生成的空 dist）列为
    // 单一条目；Linux 的 readFile 读目录抛 EISDIR，曾使全新检出的 bootstrap 直接失败。
    // 依据：目录条目本身没有内容身份，跳过不改变文件条目的指纹语义；其余读取错误仍照常抛出。
    if ((await stat(name).catch(() => null))?.isDirectory()) continue;
    hash.update(name).update(await readFile(name));
  }
  const status = statusText.trim();
  return {
    head,
    contentHash: hash.digest("hex"),
    clean: !status,
    dirty: status.split("\n").filter(Boolean),
  };
}

export function sameSnapshot(a, b) {
  return a?.head === b?.head && a?.contentHash === b?.contentHash;
}

export async function exists(path) {
  try {
    await access(path);
    return true;
  } catch {
    return false;
  }
}

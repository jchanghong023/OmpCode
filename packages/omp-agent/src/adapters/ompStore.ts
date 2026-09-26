// omp 会话存储只读扫描：当前 profile 的 agent/sessions/<encoded-cwd>/*.jsonl。
// 目录名编码与 oh-my-pi session-paths.ts 保持一致（home 前缀 `-`、tmp 前缀 `-tmp-`、绝对路径 `--…--`）。
// PI_CONFIG_DIR 可整体重定位（omp 同源），生产不设置。

import { createReadStream } from "node:fs";
import { readdir, realpath, rm, stat } from "node:fs/promises";
import { homedir, tmpdir } from "node:os";
import { isAbsolute, join, relative, resolve } from "node:path";
import { createInterface } from "node:readline";
import { resolveOmpProfileFromEnv } from "@zcode/shared/omp-profile";
import type { OmpStorePort, OmpStoreSessionSummary } from "../app/ports.js";
import { titleFromOmpEntries } from "../domain/coldHistory.js";
import { logger } from "./logger.js";

function configDir(env: NodeJS.ProcessEnv): string {
  const configured = env.PI_CONFIG_DIR?.trim();
  // omp 把相对 PI_CONFIG_DIR 解析在用户主目录下；Node 的相对 join 原先却
  // 解析在 workspace cwd 下，导致模型运行成功而冷会话扫描永久找不到文件。
  return configured ? resolve(homedir(), configured) : join(homedir(), ".omp");
}

function sessionsRoot(env: NodeJS.ProcessEnv): string {
  const profile = resolveOmpProfileFromEnv(env);
  return profile === "default"
    ? join(configDir(env), "agent", "sessions")
    : join(configDir(env), "profiles", profile, "agent", "sessions");
}

async function resolveEquivalentPath(value: string): Promise<string> {
  try {
    return await realpath(value);
  } catch {
    return value;
  }
}

async function encodeSessionDirName(cwd: string): Promise<string> {
  const resolvedCwd = resolve(cwd);
  const [canonicalCwd, canonicalHome, canonicalTemp] = await Promise.all([
    resolveEquivalentPath(resolvedCwd),
    resolveEquivalentPath(homedir()),
    resolveEquivalentPath(tmpdir()),
  ]);
  const homeRelative = relative(canonicalHome, canonicalCwd);
  const tempRelative = relative(canonicalTemp, canonicalCwd);
  const withinHome =
    homeRelative === "" || (!homeRelative.startsWith("..") && !isAbsolute(homeRelative));
  const withinTemp =
    tempRelative === "" || (!tempRelative.startsWith("..") && !isAbsolute(tempRelative));
  // Bug 根因：Windows 的临时目录通常位于用户目录内；omp 优先使用临时目录编码，
  // 此处原先优先匹配用户目录，导致重启后找不到真实会话文件及子代理记录。
  if (withinTemp && (process.platform === "win32" || !withinHome)) {
    return encodeRelative("-tmp", tempRelative);
  }
  if (withinHome) return encodeRelative("-", homeRelative);
  return `--${canonicalCwd.replace(/^[/\\]/, "").replace(/[/\\:]/g, "-")}--`;
}

function encodeRelative(prefix: string, relativePath: string): string {
  const encoded = relativePath.replace(/[/\\:]/g, "-");
  if (!encoded) {
    return prefix;
  }
  return prefix.endsWith("-") ? `${prefix}${encoded}` : `${prefix}-${encoded}`;
}

export function createOmpStore(env: NodeJS.ProcessEnv = process.env): OmpStorePort {
  const sessionDirectory = async (cwd: string) =>
    join(sessionsRoot(env), await encodeSessionDirName(cwd));
  const summaryOf = async (
    directory: string,
    name: string,
  ): Promise<OmpStoreSessionSummary | null> => {
    const sessionId = sessionIdOfFileName(name);
    if (!sessionId) return null;
    const sessionPath = join(directory, name);
    try {
      const info = await stat(sessionPath);
      // Bug 根因：stat 毫秒时间含小数，Host 索引协议要求 safeint。
      return {
        sessionId,
        sessionPath,
        title: null,
        firstUserText: null,
        updatedAt: Math.trunc(info.mtimeMs),
        createdAt: Math.trunc(info.birthtimeMs || info.mtimeMs),
      };
    } catch {
      return null;
    }
  };
  const withTitle = async (summary: OmpStoreSessionSummary): Promise<void> => {
    try {
      summary.title = titleFromOmpEntries(await readEntries(summary.sessionPath, 120));
      summary.firstUserText = summary.title;
    } catch {
      // 文件竞争删除等场景：保持 null。
    }
  };
  return {
    async listSessions(cwd: string): Promise<OmpStoreSessionSummary[]> {
      const directory = await sessionDirectory(cwd);
      let names: string[];
      try {
        names = await readdir(directory);
      } catch (error) {
        if ((error as NodeJS.ErrnoException).code === "ENOENT") return [];
        throw error;
      }
      const files = names
        .filter((name) => name.endsWith(".jsonl"))
        .sort()
        .reverse();
      const summaries: OmpStoreSessionSummary[] = [];
      // 所有仍存在的会话都必须可见；分批 stat 避免巨大目录一次性排队打开全部文件。
      for (let start = 0; start < files.length; start += 32) {
        const batch = await Promise.all(
          files.slice(start, start + 32).map((name) => summaryOf(directory, name)),
        );
        for (const summary of batch) if (summary) summaries.push(summary);
      }
      // 标题/首条输入仍只对最近 20 个会话做头部解析；不读取整份长文件。
      for (const summary of summaries.slice(0, 20)) {
        await withTitle(summary);
      }
      return summaries;
    },

    async findSession(cwd: string, sessionId: string): Promise<OmpStoreSessionSummary | null> {
      const directory = await sessionDirectory(cwd);
      let names: string[];
      try {
        names = await readdir(directory);
      } catch (error) {
        if ((error as NodeJS.ErrnoException).code === "ENOENT") return null;
        throw error;
      }
      // ID 是文件名后缀；不需要读取整个目录中其它会话的 stat 与标题。
      const name = names
        .filter((candidate) => sessionIdOfFileName(candidate) === sessionId)
        .sort()
        .at(-1);
      if (!name) return null;
      const summary = await summaryOf(directory, name);
      if (summary) await withTitle(summary);
      return summary;
    },

    async readSessionEntries(sessionPath: string): Promise<unknown[]> {
      try {
        // Bug 根因：固定取末尾 4000 行使更早历史永久无法经 rowsRange 访问。
        // 流式解析不再为完整文件同时生成 content、split 行数组与 JSON 对象数组。
        return await readEntries(sessionPath);
      } catch (error) {
        logger.warn("读取 omp 会话文件失败", { sessionPath, error: String(error) });
        return [];
      }
    },

    async readSubagentEntries(sessionPath: string, subagentId: string): Promise<unknown[]> {
      // 子代理名来自父会话工具结果，不能让它逃出该会话的子目录。
      if (!sessionPath.endsWith(".jsonl") || !/^[A-Za-z0-9_-]{1,100}$/.test(subagentId)) return [];
      const childPath = join(sessionPath.slice(0, -6), `${subagentId}.jsonl`);
      try {
        return await readEntries(childPath);
      } catch {
        return [];
      }
    },

    async deleteSession(sessionPath: string): Promise<boolean> {
      try {
        await rm(sessionPath, { force: true });
        return true;
      } catch {
        return false;
      }
    },
  };
}

function sessionIdOfFileName(name: string): string | null {
  // omp 会话文件名时间戳形如 2026-09-24T13-33-28-741Z（UTC Z 后缀），
  // 字符类必须包含 Z，否则所有会话在冷扫描中被静默跳过（GUI 恢复会话 recoveryFailed 根因）。
  const match = /^[0-9T:.+-Z]+_(.+)\.jsonl$/.exec(name);
  return match?.[1] ?? null;
}

/** 读标题（title_change / 首条用户消息）；失败返回原文 null。 */
export async function readSessionTitle(sessionPath: string): Promise<string | null> {
  try {
    return titleFromOmpEntries(await readEntries(sessionPath, 200));
  } catch {
    return null;
  }
}

/** JSONL 文件只保留解析后的对象；limit 用于标题读取，完整历史不截断。 */
async function readEntries(
  sessionPath: string,
  limit = Number.POSITIVE_INFINITY,
): Promise<unknown[]> {
  const stream = createReadStream(sessionPath, { encoding: "utf8" });
  const lines = createInterface({ input: stream, crlfDelay: Infinity });
  const entries: unknown[] = [];
  try {
    for await (const line of lines) {
      try {
        entries.push(JSON.parse(line) as unknown);
      } catch {
        // 追加中的半行或无效行不进入历史投影。
      }
      if (entries.length >= limit) break;
    }
    return entries;
  } finally {
    lines.close();
    stream.destroy();
  }
}

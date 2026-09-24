// omp 会话存储只读扫描：~/.omp/agent/sessions/<encoded-cwd>/*.jsonl。
// 目录名编码与 oh-my-pi session-paths.ts 保持一致（home 前缀 `-`、tmp 前缀 `-tmp-`、绝对路径 `--…--`）。
// PI_CONFIG_DIR 可整体重定位（omp 同源），生产不设置。

import { readdir, readFile, rm, stat } from "node:fs/promises";
import { existsSync, realpathSync } from "node:fs";
import { homedir, tmpdir } from "node:os";
import { isAbsolute, join, relative, resolve } from "node:path";
import type { OmpStorePort, OmpStoreSessionSummary } from "../app/ports.js";
import { titleFromOmpEntries } from "../domain/coldHistory.js";
import { logger } from "./logger.js";

function configDir(env: NodeJS.ProcessEnv): string {
  return env.PI_CONFIG_DIR?.trim() || join(homedir(), ".omp");
}

function sessionsRoot(env: NodeJS.ProcessEnv): string {
  return join(configDir(env), "agent", "sessions");
}

function resolveEquivalentPath(value: string): string {
  try {
    return realpathSync(value);
  } catch {
    return value;
  }
}

function encodeSessionDirName(cwd: string): string {
  const resolvedCwd = resolve(cwd);
  const canonicalCwd = resolveEquivalentPath(resolvedCwd);
  const canonicalHome = resolveEquivalentPath(homedir());
  const canonicalTemp = resolveEquivalentPath(tmpdir());
  const homeRelative = relative(canonicalHome, canonicalCwd);
  const tempRelative = relative(canonicalTemp, canonicalCwd);
  if (homeRelative === "" || (!homeRelative.startsWith("..") && !isAbsolute(homeRelative))) {
    return encodeRelative("-", homeRelative);
  }
  if (tempRelative === "" || (!tempRelative.startsWith("..") && !isAbsolute(tempRelative))) {
    return encodeRelative("-tmp", tempRelative);
  }
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
  return {
    async listSessions(cwd: string): Promise<OmpStoreSessionSummary[]> {
      const directory = join(sessionsRoot(env), encodeSessionDirName(cwd));
      if (!existsSync(directory)) {
        return [];
      }
      const files = (await readdir(directory)).filter((name) => name.endsWith(".jsonl")).sort().reverse();
      const summaries: OmpStoreSessionSummary[] = [];
      for (const name of files.slice(0, 100)) {
        const sessionPath = join(directory, name);
        const sessionId = sessionIdOfFileName(name);
        if (!sessionId) {
          continue;
        }
        let updatedAt = Date.now();
        let createdAt = Date.now();
        try {
          const info = await stat(sessionPath);
          updatedAt = info.mtimeMs;
          createdAt = info.birthtimeMs || info.mtimeMs;
        } catch {
          continue;
        }
        summaries.push({
          sessionId,
          sessionPath,
          title: null,
          firstUserText: null,
          updatedAt,
          createdAt,
        });
      }
      // 标题/首条输入只对最近 20 个会话做头部解析（列表展示需要，代价有界）。
      for (const summary of summaries.slice(0, 20)) {
        try {
          const content = await readFile(summary.sessionPath, "utf8");
          const entries = content
            .split("\n")
            .slice(0, 120)
            .map((line) => {
              try {
                return JSON.parse(line);
              } catch {
                return null;
              }
            })
            .filter((entry): entry is unknown => entry !== null);
          summary.title = titleFromOmpEntries(entries);
          summary.firstUserText = summary.title;
        } catch {
          // 文件竞争删除等场景：保持 null。
        }
      }
      return summaries;
    },

    async readSessionEntries(sessionPath: string): Promise<unknown[]> {
      try {
        const content = await readFile(sessionPath, "utf8");
        return content
          .split("\n")
          .slice(0, 4000)
          .map((line) => {
            try {
              return JSON.parse(line);
            } catch {
              return null;
            }
          })
          .filter((entry): entry is unknown => entry !== null);
      } catch (error) {
        logger.warn("读取 omp 会话文件失败", { sessionPath, error: String(error) });
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
  const match = /^[0-9T:.+-]+_(.+)\.jsonl$/.exec(name);
  return match?.[1] ?? null;
}

/** 读标题（title_change / 首条用户消息）；失败返回原文 null。 */
export async function readSessionTitle(sessionPath: string): Promise<string | null> {
  try {
    const content = await readFile(sessionPath, "utf8");
    const entries = content
      .split("\n")
      .slice(0, 200)
      .map((line) => {
        try {
          return JSON.parse(line);
        } catch {
          return null;
        }
      })
      .filter((entry): entry is unknown => entry !== null);
    return titleFromOmpEntries(entries);
  } catch {
    return null;
  }
}

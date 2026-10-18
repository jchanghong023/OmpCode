// omp 会话存储只读扫描：当前 profile 的 agent/sessions/<encoded-cwd>/*.jsonl。
// 目录名编码与 oh-my-pi session-paths.ts 保持一致（home 前缀 `-`、tmp 前缀 `-tmp-`、绝对路径 `--…--`）。
// OMP_CONFIG_ROOT / PI_CONFIG_DIR 重定位与 Main 共用解析；POSIX 上 $XDG_DATA_HOME/omp
// 迁移目录存在时 sessions 根对齐 omp DirResolver XDG 规则（见 ompSessionsRoot）。

import { createReadStream } from "node:fs";
import { open, readdir, rm, stat } from "node:fs/promises";
import { homedir } from "node:os";
import { basename, join } from "node:path";
import { createInterface } from "node:readline";
import { resolveOmpProfileFromEnv } from "@zcode/shared/omp-profile";
import {
  ensureOfflineDataRoot,
  resolveOfflineDataRoots,
  resolveOmpConfigRoot,
  resolveOmpCodePersistentRoot,
  resolveOmpCodeDataRootFromEnv,
} from "@zcode/shared/node";
import type { OmpStorePort, OmpStoreSessionSummary } from "../app/ports.js";
import { titleFromOmpEntries } from "../domain/coldHistory.js";
import { readableOmpSkillInput, visibleOmpCustomMessage } from "../domain/OmpCustomMessage.js";
import { logger } from "./logger.js";
import { createOmpCommandOutputStore } from "./OmpCommandOutputStore.js";
import { safeInteractionAgentId } from "../domain/OmpInteractionIds.js";
import { encodeSessionDirName, sessionsRoot } from "./ompSessionPaths.js";
import { logStoreFallback, observeStoreOperation } from "./hostRequestDiagnostics.js";

export function createOmpStore(env: NodeJS.ProcessEnv = process.env): OmpStorePort {
  // 独立适配器也要先验证两类私有根，不能跟随被植入的目录链接读取 NFS 旧数据。
  for (const [persistentRoot, namespace] of [
    [resolveOmpConfigRoot(homedir(), env), "omp"],
    [resolveOmpCodePersistentRoot(homedir(), env), "ompcode"],
  ] as const) {
    const roots = resolveOfflineDataRoots(persistentRoot, namespace, { env });
    if (roots) ensureOfflineDataRoot(roots);
  }
  const commandOutputs = createOmpCommandOutputStore(
    ompCommandOutputsRoot(env),
    env.ZCODE_WORKSPACE_IDENTITY,
  );
  const sessionDirectory = async (cwd: string) =>
    join(sessionsRoot(env), await encodeSessionDirName(cwd, env));
  const summaryOf = async (
    directory: string,
    name: string,
  ): Promise<OmpStoreSessionSummary | null> => {
    const sessionId = sessionIdOfFileName(name);
    if (!sessionId) return null;
    const sessionPath = join(directory, name);
    const startedAt = Date.now();
    try {
      const info = await stat(sessionPath);
      // Bug 根因：stat 毫秒时间含小数，Host 索引协议要求 safeint。
      const [header] = await readEntries(sessionPath, 1);
      const headerTime = journalTimestamp(
        typeof header === "object" && header !== null && "timestamp" in header
          ? header.timestamp
          : undefined,
      );
      const createdAt = headerTime ?? Math.trunc(info.birthtimeMs || info.mtimeMs);
      const updatedAt = (await readLastActivityAt(sessionPath, info.size)) ?? createdAt;
      return {
        sessionId,
        sessionPath,
        title: null,
        firstUserText: null,
        updatedAt,
        createdAt,
      };
    } catch (error) {
      logStoreFallback("summary", "stat", startedAt, error, { sessionId });
      return null;
    }
  };
  const withTitle = async (summary: OmpStoreSessionSummary): Promise<void> => {
    const startedAt = Date.now();
    try {
      summary.title = titleFromOmpEntries(await readEntries(summary.sessionPath, 120));
      summary.firstUserText = summary.title;
    } catch (error) {
      // 文件竞争删除等场景保持 null；不输出标题或首条输入。
      logStoreFallback("title", "read", startedAt, error, { sessionId: summary.sessionId });
    }
  };
  return {
    appendCommandOutput: commandOutputs.appendCommandOutput,
    readCommandOutputs: commandOutputs.readCommandOutputs,
    associateCommandOutputs: commandOutputs.associateCommandOutputs,
    deleteCommandOutputs: commandOutputs.deleteCommandOutputs,
    flushCommandOutputs: commandOutputs.flushCommandOutputs,
    async listSessions(cwd: string): Promise<OmpStoreSessionSummary[]> {
      return observeStoreOperation("list", {}, async () => {
        const directory = await sessionDirectory(cwd);
        let names: string[];
        try {
          names = await readdir(directory);
        } catch (error) {
          if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
          names = [];
          logger.warn("会话目录不存在，合并派生历史", {
            event: "omp.store.list.fallback",
            stage: "readdir",
            code: "ENOENT",
          });
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
        // 本地命令可能不创建原生文件，仍沿同一列表返回可恢复的 GUI 派生历史。
        const byId = new Map(summaries.map((summary) => [summary.sessionId, summary]));
        for (const derived of await commandOutputs.listSessions(cwd)) {
          const native = byId.get(derived.sessionId);
          byId.set(
            derived.sessionId,
            native
              ? {
                  ...native,
                  title: native.title ?? derived.title,
                  updatedAt: Math.max(native.updatedAt, derived.updatedAt),
                }
              : derived,
          );
        }
        return [...byId.values()].sort((left, right) => right.updatedAt - left.updatedAt);
      });
    },

    async findSession(cwd: string, sessionId: string): Promise<OmpStoreSessionSummary | null> {
      return observeStoreOperation("find", { sessionId }, async () => {
        const directory = await sessionDirectory(cwd);
        let names: string[];
        try {
          names = await readdir(directory);
        } catch (error) {
          if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
          names = [];
          logger.warn("会话目录不存在，查询派生历史", {
            event: "omp.store.find.fallback",
            sessionId,
            stage: "readdir",
            code: "ENOENT",
          });
        }
        // ID 是文件名后缀；不需要读取整个目录中其它会话的 stat 与标题。
        const name = names
          .filter((candidate) => sessionIdOfFileName(candidate) === sessionId)
          .sort()
          .at(-1);
        if (!name) return commandOutputs.findSession(cwd, sessionId);
        const summary = await summaryOf(directory, name);
        if (summary) await withTitle(summary);
        return summary;
      });
    },

    async readSessionEntries(sessionPath: string): Promise<unknown[]> {
      return observeStoreOperation(
        "readSession",
        { sessionId: sessionIdOfFileName(basename(sessionPath)) },
        async () => {
          const startedAt = Date.now();
          try {
            // Bug 根因：固定取末尾 4000 行使更早历史永久无法经 rowsRange 访问。
            // 流式解析不再为完整文件同时生成 content、split 行数组与 JSON 对象数组。
            return await readEntries(sessionPath);
          } catch (error) {
            logStoreFallback("readSession", "read", startedAt, error);
            return [];
          }
        },
      );
    },

    async readSubagentEntries(sessionPath: string, subagentId: string): Promise<unknown[]> {
      return observeStoreOperation(
        "readSubagent",
        {
          sessionId: sessionIdOfFileName(basename(sessionPath)),
          ...(/^[A-Za-z0-9_-]{1,100}$/.test(subagentId) ? { subagentId } : {}),
        },
        async () => {
          const startedAt = Date.now();
          // 子代理名来自父会话工具结果，不能让它逃出该会话的子目录。
          if (!sessionPath.endsWith(".jsonl") || !/^[A-Za-z0-9_-]{1,100}$/.test(subagentId)) {
            logStoreFallback("readSubagent", "validation", startedAt, undefined);
            return [];
          }
          const childPath = join(sessionPath.slice(0, -6), `${subagentId}.jsonl`);
          try {
            return await readEntries(childPath);
          } catch (error) {
            logStoreFallback("readSubagent", "read", startedAt, error);
            return [];
          }
        },
      );
    },

    async readInteractionEntries(sessionPath, ancestry, version) {
      return observeStoreOperation(
        "readInteraction",
        { ancestryDepth: ancestry.length },
        async () => {
          const startedAt = Date.now();
          if (
            !sessionPath.endsWith(".jsonl") ||
            ancestry.some((id) => !safeInteractionAgentId(id))
          ) {
            logStoreFallback("readInteraction", "validation", startedAt, undefined);
            return { version: "invalid", available: false };
          }
          let recordPath = sessionPath;
          for (const id of ancestry) recordPath = join(recordPath.slice(0, -6), `${id}.jsonl`);
          try {
            const info = await stat(recordPath);
            const currentVersion = `${info.size}:${info.mtimeMs}`;
            if (currentVersion === version) return { version: currentVersion, available: true };
            // 读取预算只约束观察页；普通会话历史仍保持完整读取。
            const entries = await readEntries(recordPath, 50_001);
            return {
              version: currentVersion,
              available: true,
              entries: entries.slice(0, 50_000),
              truncated: entries.length > 50_000,
            };
          } catch (error) {
            logStoreFallback("readInteraction", "read", startedAt, error);
            return { version: "missing", available: false, entries: [] };
          }
        },
      );
    },

    async deleteSession(sessionPath: string): Promise<boolean> {
      return observeStoreOperation(
        "delete",
        { sessionId: sessionIdOfFileName(basename(sessionPath)) },
        async () => {
          const startedAt = Date.now();
          try {
            await rm(sessionPath, { force: true });
            return true;
          } catch (error) {
            logStoreFallback("delete", "remove", startedAt, error);
            return false;
          }
        },
      );
    },
  };
}

/** GUI 派生数据遵循 OmpCode 根；PI_CONFIG_DIR 只定位 OMP，不迁移应用数据。 */
function ompCommandOutputsRoot(env: NodeJS.ProcessEnv, home = homedir()): string {
  const root =
    resolveOmpCodeDataRootFromEnv(home, env) ??
    (env.ZCODE_HOME?.trim() ||
      join(env.ZCODE_DATA_BASE_DIR?.trim() || env.HOME?.trim() || home, ".ompcode"));
  return join(root, "cli", "omp-command-output", resolveOmpProfileFromEnv(env));
}

function sessionIdOfFileName(name: string): string | null {
  // omp 会话文件名时间戳形如 2026-09-24T13-33-28-741Z（UTC Z 后缀），
  // 字符类必须包含 Z，否则所有会话在冷扫描中被静默跳过（GUI 恢复会话 recoveryFailed 根因）。
  const match = /^[0-9T:.+-Z]+_(.+)\.jsonl$/.exec(name);
  return match?.[1] ?? null;
}

/** JSONL 文件只保留解析后的对象；limit 用于标题读取，完整历史不截断。 */
async function readEntries(
  sessionPath: string,
  limit = Number.POSITIVE_INFINITY,
): Promise<unknown[]> {
  const startedAt = Date.now();
  const stream = createReadStream(sessionPath, { encoding: "utf8" });
  const lines = createInterface({ input: stream, crlfDelay: Infinity });
  const entries: unknown[] = [];
  let invalidLineCount = 0;
  try {
    for await (const line of lines) {
      try {
        entries.push(JSON.parse(line) as unknown);
      } catch {
        // 追加中的半行或无效行不进入历史投影。
        invalidLineCount += 1;
      }
      if (entries.length >= limit) break;
    }
    if (invalidLineCount > 0)
      logStoreFallback("jsonl", "decode", startedAt, undefined, {
        invalidLineCount,
        entryCount: entries.length,
      });
    return entries;
  } finally {
    lines.close();
    stream.destroy();
  }
}

function journalTimestamp(value: unknown): number | undefined {
  const timestamp =
    typeof value === "number" ? value : typeof value === "string" ? Date.parse(value) : NaN;
  return Number.isSafeInteger(Math.trunc(timestamp)) && timestamp >= 0
    ? Math.trunc(timestamp)
    : undefined;
}

/** Read backwards only as far as the latest activity; exit diagnostics never promote a task. */
async function readLastActivityAt(sessionPath: string, size: number): Promise<number | undefined> {
  const file = await open(sessionPath, "r");
  const chunk = Buffer.allocUnsafe(64 * 1024);
  let position = size;
  let pending = Buffer.alloc(0);
  try {
    while (position > 0) {
      const length = Math.min(chunk.length, position);
      position -= length;
      const { bytesRead } = await file.read(chunk, 0, length, position);
      const bytes = Buffer.concat([chunk.subarray(0, bytesRead), pending]);
      let end = bytes.length;
      for (let index = bytes.length - 1; index >= 0; index -= 1) {
        if (bytes[index] !== 10) continue;
        const activity = journalActivityAt(bytes.subarray(index + 1, end).toString("utf8"));
        if (activity !== undefined) return activity;
        end = index;
      }
      pending = Buffer.from(bytes.subarray(0, end));
    }
    return journalActivityAt(pending.toString("utf8"));
  } finally {
    await file.close();
  }
}

function journalActivityAt(line: string): number | undefined {
  let record: Record<string, unknown>;
  try {
    const value: unknown = JSON.parse(line);
    if (!value || typeof value !== "object" || Array.isArray(value)) return undefined;
    record = value as Record<string, unknown>;
  } catch {
    // Match the history reader: an incomplete append is not a completed activity.
    return undefined;
  }
  const message =
    record.message && typeof record.message === "object"
      ? (record.message as Record<string, unknown>)
      : undefined;
  if (
    record.type === "message" &&
    ["user", "assistant", "toolResult"].includes(String(message?.role))
  ) {
    return journalTimestamp(message?.timestamp) ?? journalTimestamp(record.timestamp);
  }
  const custom = record.type === "custom_message" ? record : message;
  const visible = readableOmpSkillInput(custom) ?? visibleOmpCustomMessage(custom);
  return visible
    ? (journalTimestamp(visible.timestamp) ?? journalTimestamp(record.timestamp))
    : undefined;
}

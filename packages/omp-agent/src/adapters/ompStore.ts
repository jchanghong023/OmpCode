// omp 会话存储只读扫描：当前 profile 的 agent/sessions/<encoded-cwd>/*.jsonl。
// 目录名编码与 oh-my-pi session-paths.ts 保持一致（home 前缀 `-`、tmp 前缀 `-tmp-`、绝对路径 `--…--`）。
// OMP_CONFIG_ROOT / PI_CONFIG_DIR 重定位与 Main 共用解析；POSIX 上 $XDG_DATA_HOME/omp
// 迁移目录存在时 sessions 根对齐 omp DirResolver XDG 规则（见 ompSessionsRoot）。

import { createReadStream, existsSync } from "node:fs";
import { readdir, realpath, rm, stat } from "node:fs/promises";
import { homedir, tmpdir } from "node:os";
import { basename, isAbsolute, join, relative, resolve } from "node:path";
import { createInterface } from "node:readline";
import { resolveOmpProfileFromEnv } from "@zcode/shared/omp-profile";
import { resolveOmpAgentDir, resolveOmpCodeDataRootFromEnv } from "@zcode/shared/node";
import type { OmpStorePort, OmpStoreSessionSummary } from "../app/ports.js";
import { titleFromOmpEntries } from "../domain/coldHistory.js";
import { logger } from "./logger.js";
import { createOmpCommandOutputStore } from "./OmpCommandOutputStore.js";
import { safeInteractionAgentId } from "../domain/OmpInteractionIds.js";
import {
  logStoreFallback,
  observeStoreOperation,
  safeErrorSummary,
} from "./hostRequestDiagnostics.js";

/**
 * omp sessions 目录解析（S1-3，对齐 omp DirResolver XDG 规则，v18.4.8+fork.278
 * packages/utils/src/dirs.ts）。platform/home/exists 注入仅供 UT；生产路径与本函数唯一。
 * omp 精确条件（已按 git show 核对）：
 * - 仅 linux/darwin 参与 XDG，win32 不受影响；
 * - 仅 $XDG_DATA_HOME（data 类别；sessions 归 data）非空时参与，无 trim；
 * - 默认 profile 锚定 $XDG_DATA_HOME/omp，命名 profile 锚定 $XDG_DATA_HOME/omp/profiles/<profile>，
 *   且锚点目录必须真实存在（omp config init-xdg 迁移完成后才生效），否则回退 ~/.omp 布局；
 * - XDG 生效时扁平化 agent/ 前缀：sessions 目录直接挂在锚点下（$XDG_DATA_HOME/omp/sessions）。
 * PI_CODING_AGENT_DIR 覆盖会关闭 omp 的 XDG 分支，但本适配层历来未消费该变量，维持现状不扩scope。
 */
export function ompSessionsRoot(options: {
  env: NodeJS.ProcessEnv;
  platform: NodeJS.Platform;
  home: string;
  exists: (path: string) => boolean;
}): string {
  const { env, platform, home, exists } = options;
  const profile = resolveOmpProfileFromEnv(env);
  const xdgDataHome = env.XDG_DATA_HOME;
  if ((platform === "linux" || platform === "darwin") && xdgDataHome) {
    const appRoot = join(xdgDataHome, "omp");
    const anchor = profile === "default" ? appRoot : join(appRoot, "profiles", profile);
    if (exists(anchor)) {
      return join(anchor, "sessions");
    }
  }
  return join(resolveOmpAgentDir(home, env), "sessions");
}

function sessionsRoot(env: NodeJS.ProcessEnv): string {
  return ompSessionsRoot({
    env,
    platform: process.platform,
    home: homedir(),
    exists: (path) => existsSync(path),
  });
}

async function resolveEquivalentPath(value: string): Promise<string> {
  const startedAt = Date.now();
  try {
    return await realpath(value);
  } catch (error) {
    logger.debug("路径规范化失败，沿用原路径", {
      event: "omp.store.realpath.fallback",
      stage: "realpath",
      elapsedMs: Date.now() - startedAt,
      ...safeErrorSummary(error),
    });
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
  const commandOutputs = createOmpCommandOutputStore(
    ompCommandOutputsRoot(env),
    env.ZCODE_WORKSPACE_IDENTITY,
  );
  const sessionDirectory = async (cwd: string) =>
    join(sessionsRoot(env), await encodeSessionDirName(cwd));
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
      return {
        sessionId,
        sessionPath,
        title: null,
        firstUserText: null,
        updatedAt: Math.trunc(info.mtimeMs),
        createdAt: Math.trunc(info.birthtimeMs || info.mtimeMs),
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

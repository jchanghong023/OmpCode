import type { Dirent } from "node:fs";
import { readdir, stat } from "node:fs/promises";
import { join, relative, sep } from "node:path";
import type { WorkspaceFileEntry } from "@zcode/shared";
import { packWorkspaceFileEntries } from "@zcode/shared/workspaceFileEntriesCodec";
import type { ServiceLogger } from "../logger/serviceLogger.js";
import type { WorkspaceFileSearchFilter } from "./workspaceFileMentionFilter.js";
import {
  WORKSPACE_FILE_SEARCH_IGNORE_FILE_NAME,
  isWorkspaceFileSearchPathIgnored,
  loadWorkspaceFileSearchIgnoreRules,
} from "./workspaceFileIgnore.js";
import type { buildHostFileSearchCandidates } from "./workspaceFileSearch.js";

const INDEX_TTL_MS = 60_000;
const SCAN_CONCURRENCY = 8;
const CACHE_MAX_ENTRIES = 4;
type IgnoreRules = Awaited<ReturnType<typeof loadWorkspaceFileSearchIgnoreRules>>;

interface WorkspaceFileIndex {
  at: number;
  fingerprint: string;
  cacheable: boolean;
  packed: string;
  candidates?: ReturnType<typeof buildHostFileSearchCandidates>;
}

interface WorkspaceIndexScope {
  rootPath: string;
  generation: number;
  index?: WorkspaceFileIndex;
  rules?: { fingerprint: string; value: IgnoreRules };
  pending?: { generation: number; refresh: boolean; promise: Promise<WorkspaceFileIndex> };
}

async function ignoreFingerprint(rootPath: string): Promise<string> {
  try {
    const value = await stat(join(rootPath, WORKSPACE_FILE_SEARCH_IGNORE_FILE_NAME));
    // 原子替换可能保持 mtime/size；ctime 与 inode 也参与签名，避免继续使用旧规则。
    return `${value.mtimeMs}:${value.ctimeMs}:${value.size}:${value.ino}`;
  } catch {
    return "none";
  }
}

function isSkippableError(error: unknown): boolean {
  const code = (error as { code?: unknown } | null)?.code;
  return code === "EACCES" || code === "EPERM" || code === "ENOENT";
}

async function scanWorkspace(
  rootPath: string,
  rules: IgnoreRules,
  filter: WorkspaceFileSearchFilter,
): Promise<string> {
  const entries: WorkspaceFileEntry[] = [];
  const directories = [rootPath];
  const traverse = async () => {
    for (;;) {
      const directory = directories.pop();
      if (!directory) return;
      let children: Dirent[];
      try {
        children = await readdir(directory, { withFileTypes: true });
      } catch (error) {
        if (isSkippableError(error)) continue;
        throw error;
      }
      for (const entry of children) {
        const path = join(directory, entry.name);
        const relativePath = relative(rootPath, path).split(sep).join("/");
        if (relativePath === WORKSPACE_FILE_SEARCH_IGNORE_FILE_NAME) continue;
        const symbolicLink = entry.isSymbolicLink();
        const type: WorkspaceFileEntry["type"] = entry.isDirectory()
          ? "directory"
          : symbolicLink && (await stat(path).catch(() => null))?.isDirectory()
            ? "directory"
            : "file";
        if (isWorkspaceFileSearchPathIgnored(rules, relativePath, type)) continue;
        const candidate = { name: entry.name, path, relativePath, type };
        const decision = filter.evaluate(candidate, { ignoreRulesActive: true });
        if (decision.include) entries.push(candidate);
        if (type === "directory" && !symbolicLink && decision.traverse) directories.push(path);
      }
    }
  };
  await Promise.all(Array.from({ length: SCAN_CONCURRENCY }, traverse));
  entries.sort((left, right) =>
    left.type !== right.type
      ? left.type === "directory"
        ? -1
        : 1
      : left.relativePath.localeCompare(right.relativePath),
  );
  return packWorkspaceFileEntries(entries);
}

/** 每个 fileService 实例只持有这一份索引/规则所有者；不依赖网络盘 watch。 */
export function createWorkspaceFileIndexCache(
  filter: WorkspaceFileSearchFilter,
  logger: ServiceLogger,
) {
  const scopes = new Map<string, WorkspaceIndexScope>();
  const trimCache = () => {
    // 在途项只活到请求完成；已完成索引、规则和刷新记录共同受固定 LRU 容量约束。
    let completed = [...scopes.values()].filter((scope) => !scope.pending).length;
    for (const [key, scope] of scopes) {
      if (completed <= CACHE_MAX_ENTRIES) break;
      if (!scope.pending) {
        scopes.delete(key);
        completed--;
      }
    }
  };

  const ensure = (
    rootPath: string,
    workspaceIdentity?: string,
    refresh = false,
  ): Promise<WorkspaceFileIndex> => {
    const key = workspaceIdentity?.trim() || rootPath;
    const previous = scopes.get(key);
    const scope: WorkspaceIndexScope =
      previous?.rootPath === rootPath ? previous : { rootPath, generation: 0 };
    scopes.delete(key);
    scopes.set(key, scope);
    // 旧实现先读/编译 ignore，再登记扫描，而且 refresh 会绕过在途请求。
    // 在任何 IO 前登记 promise，普通查询和刷新均加入当前代际，不按输入字符并发重扫。
    if (scope.pending?.generation === scope.generation) {
      scope.pending.refresh ||= refresh;
      return scope.pending.promise;
    }
    const preceding = previous?.pending?.promise;
    const generation = scope.generation;
    const scanning = Promise.resolve().then(async (): Promise<WorkspaceFileIndex> => {
      // rootPath 替换或保存规则使代际改变时，新扫描等待旧扫描结束；旧结果不能回写。
      await preceding?.catch(() => undefined);
      const fingerprint = await ignoreFingerprint(rootPath);
      if (
        !pending.refresh &&
        scope.index?.fingerprint === fingerprint &&
        Date.now() - scope.index.at < INDEX_TTL_MS
      )
        return scope.index;
      let rules =
        fingerprint !== "none" && scope.rules?.fingerprint === fingerprint
          ? scope.rules.value
          : undefined;
      if (!rules) {
        rules = await loadWorkspaceFileSearchIgnoreRules(rootPath, logger);
        // 指纹必须来自读取前，不能把读取期间新写入的版本签名绑定到旧 matcher。
        // 自动创建时先保留 none；下一次查询核验新文件后只重新解析一次。
        if (scope.generation === generation)
          scope.rules = rules.source.startsWith("fallback-")
            ? undefined
            : { fingerprint, value: rules };
      }
      const packed = await scanWorkspace(rootPath, rules, filter);
      // stat 成功不代表正文读取成功；把降级 matcher/索引绑到该指纹会让暂时 EIO
      // 永久沿用 fallback。降级仅服务当前请求，后续查询必须再次读取真实规则。
      return {
        at: Date.now(),
        fingerprint,
        cacheable: !rules.source.startsWith("fallback-"),
        packed,
      };
    });
    const pending = { generation, refresh, promise: scanning };
    const finish = () => {
      if (scope.pending === pending) scope.pending = undefined;
      trimCache();
    };
    pending.promise = scanning.then(
      (index) => {
        if (scopes.get(key) === scope && scope.generation === generation)
          scope.index = index.cacheable ? index : undefined;
        finish();
        return index;
      },
      (error: unknown) => {
        finish();
        throw error;
      },
    );
    scope.pending = pending;
    return pending.promise;
  };

  return {
    ensure,
    invalidate(rootPath: string) {
      for (const scope of scopes.values()) {
        if (scope.rootPath !== rootPath) continue;
        scope.generation++;
        scope.index = undefined;
        scope.rules = undefined;
      }
    },
  };
}

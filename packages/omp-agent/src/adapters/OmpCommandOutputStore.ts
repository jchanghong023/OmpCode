// command_output 未进入 OMP journal，GUI 冷恢复只能保存收到的文本派生记录。
// 单一异步写入链覆盖追加、身份关联与删除，防止关闭/删除后迟到写入复活历史。
import { createHash, randomUUID } from "node:crypto";
import { createReadStream } from "node:fs";
import { mkdir, readFile, readdir, rename, rm, stat, writeFile } from "node:fs/promises";
import { createInterface } from "node:readline";
import { join } from "node:path";
import type { OmpCommandOutputRecord } from "../domain/OmpCommandOutput.js";
import { ompSessionIdOfFilePath } from "../domain/ids.js";
import type { OmpCommandOutputSession, OmpStoreSessionSummary } from "../app/ports.js";
import { logger } from "./logger.js";
import { nativeOmpCustomDisplays } from "../domain/OmpCustomMessage.js";

interface CommandHistory {
  version: 1;
  sessionId: string;
  sessionPath: string | null;
  /** OMP 会先分配路径；只有实际见过文件后，缺失才表示外部删除。 */
  nativeFileObserved: boolean;
  aliases: string[];
  title: string | null;
  outputs: OmpCommandOutputRecord[];
}

function digest(value: string): string {
  return createHash("sha256").update(value).digest("hex");
}

function outputRecord(value: unknown): value is OmpCommandOutputRecord {
  if (!value || typeof value !== "object") return false;
  const record = value as Partial<OmpCommandOutputRecord>;
  return (
    typeof record.id === "string" &&
    record.id.length > 0 &&
    typeof record.text === "string" &&
    (record.customType === undefined || typeof record.customType === "string") &&
    (record.nativeTimestamp === undefined || Number.isFinite(record.nativeTimestamp)) &&
    (record.nativeSessionId === undefined || typeof record.nativeSessionId === "string") &&
    Number.isSafeInteger(record.createdAt) &&
    record.createdAt! >= 0
  );
}

function historyRecord(value: unknown): CommandHistory | null {
  if (!value || typeof value !== "object") return null;
  const record = value as Partial<CommandHistory>;
  if (
    record.version !== 1 ||
    typeof record.sessionId !== "string" ||
    (record.sessionPath !== null && typeof record.sessionPath !== "string") ||
    (record.title !== null && typeof record.title !== "string") ||
    !Array.isArray(record.outputs)
  )
    return null;
  return {
    version: 1,
    sessionId: record.sessionId,
    sessionPath: record.sessionPath,
    nativeFileObserved: record.nativeFileObserved === true,
    aliases: [
      ...new Set([
        record.sessionId,
        ...(Array.isArray(record.aliases)
          ? record.aliases.filter((id): id is string => typeof id === "string")
          : []),
      ]),
    ],
    title: record.title,
    outputs: record.outputs
      .filter(outputRecord)
      .map(({ id, text, createdAt, customType, nativeTimestamp, nativeSessionId }) => ({
        id,
        text,
        createdAt,
        ...(customType !== undefined ? { customType } : {}),
        ...(nativeTimestamp !== undefined ? { nativeTimestamp } : {}),
        ...(nativeSessionId !== undefined ? { nativeSessionId } : {}),
      })),
  };
}

export function createOmpCommandOutputStore(root: string, workspaceIdentity?: string) {
  // workspaceIdentity 只用于身份隔离，cwd 仍负责原生会话文件和工作区文件访问。
  const directoryOf = (cwd: string) => join(root, digest(workspaceIdentity?.trim() || cwd));
  let tail = Promise.resolve();
  let writeFailure: unknown;
  const serial = <T>(operation: () => Promise<T>): Promise<T> => {
    const current = tail.then(operation);
    tail = current.then(
      () => {},
      (error) => {
        writeFailure = error;
        logger.warn("OMP 命令派生历史写入失败", { error: String(error) });
      },
    );
    return current;
  };
  const histories = async (cwd: string): Promise<{ path: string; history: CommandHistory }[]> => {
    const directory = directoryOf(cwd);
    let names: string[];
    try {
      names = await readdir(directory);
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === "ENOENT") return [];
      throw error;
    }
    const records = await Promise.all(
      names
        .filter((name) => /^[a-f0-9]{64}\.json$/.test(name))
        .map(async (name) => {
          const path = join(directory, name);
          try {
            const history = historyRecord(JSON.parse(await readFile(path, "utf8")));
            return history ? { path, history } : null;
          } catch (error) {
            if ((error as NodeJS.ErrnoException).code !== "ENOENT")
              logger.warn("OMP 命令派生历史读取失败", { error: String(error) });
            return null;
          }
        }),
    );
    return records.filter((record): record is NonNullable<typeof record> => record !== null);
  };
  const matches = (history: CommandHistory, sessionId: string, sessionPath?: string | null) =>
    history.aliases.includes(sessionId) ||
    ompSessionIdOfFilePath(history.sessionPath) === sessionId ||
    Boolean(sessionPath && history.sessionPath === sessionPath);
  const writeHistory = async (path: string, history: CommandHistory): Promise<void> => {
    const temporary = `${path}.${randomUUID()}.tmp`;
    try {
      await writeFile(temporary, `${JSON.stringify(history)}\n`, "utf8");
      await rename(temporary, path);
    } finally {
      await rm(temporary, { force: true });
    }
  };
  const nativeFileExists = async (path: string | null): Promise<boolean> => {
    if (!path) return false;
    try {
      return (await stat(path)).isFile();
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === "ENOENT") return false;
      throw error;
    }
  };
  const customAlreadyPersisted = async (
    sessionPath: string | null,
    record: OmpCommandOutputRecord,
  ): Promise<boolean> => {
    if (!sessionPath || record.customType === undefined || record.nativeTimestamp === undefined)
      return false;
    if (
      record.nativeSessionId !== undefined &&
      record.nativeSessionId !== ompSessionIdOfFilePath(sessionPath)
    )
      return false;
    const stream = createReadStream(sessionPath, { encoding: "utf8" });
    const lines = createInterface({ input: stream, crlfDelay: Infinity });
    try {
      for await (const line of lines) {
        let entry: unknown;
        try {
          entry = JSON.parse(line);
        } catch {
          continue;
        }
        // 同 type/正文的旧事件不能覆盖新结果；仅原生事件时间相同才证明已经落盘。
        if (
          nativeOmpCustomDisplays([entry]).some(
            (native) =>
              native.customType === record.customType &&
              native.text === record.text &&
              native.timestamp === record.nativeTimestamp,
          )
        )
          return true;
      }
      return false;
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === "ENOENT") return false;
      throw error;
    } finally {
      lines.close();
      stream.destroy();
    }
  };
  const associate = async (
    history: CommandHistory,
    session: OmpCommandOutputSession,
  ): Promise<void> => {
    const sessionPath = session.sessionPath || history.sessionPath;
    const observed = await nativeFileExists(sessionPath);
    history.nativeFileObserved =
      sessionPath === history.sessionPath ? history.nativeFileObserved || observed : observed;
    history.sessionPath = sessionPath;
    history.title = session.title || history.title;
    history.aliases = [
      ...new Set([
        ...history.aliases,
        session.sessionId,
        ...[ompSessionIdOfFilePath(sessionPath)].filter((id): id is string => Boolean(id)),
      ]),
    ];
  };
  const summaryOfHistory = async (
    path: string,
    history: CommandHistory,
  ): Promise<OmpStoreSessionSummary | null> => {
    if (history.outputs.length === 0) return null;
    const nativeExists = await nativeFileExists(history.sessionPath);
    // 分配路径不等于落盘；真正见过 journal 后被外部删除，则不能由派生文本复活。
    if (history.nativeFileObserved && !nativeExists) return null;
    if (nativeExists && !history.nativeFileObserved) {
      history.nativeFileObserved = true;
      await writeHistory(path, history);
    }
    let createdAt = history.outputs[0]!.createdAt;
    let updatedAt = createdAt;
    for (const output of history.outputs) {
      createdAt = Math.min(createdAt, output.createdAt);
      updatedAt = Math.max(updatedAt, output.createdAt);
    }
    return {
      sessionId: ompSessionIdOfFilePath(history.sessionPath) ?? history.sessionId,
      sessionPath: nativeExists ? history.sessionPath! : "",
      title: history.title,
      firstUserText: null,
      createdAt,
      updatedAt,
      ...(!nativeExists ? { commandOutputOnly: true as const } : {}),
    };
  };
  return {
    listSessions(cwd: string): Promise<OmpStoreSessionSummary[]> {
      return serial(async () => {
        const summaries: OmpStoreSessionSummary[] = [];
        for (const { path, history } of await histories(cwd)) {
          const summary = await summaryOfHistory(path, history);
          if (summary) summaries.push(summary);
        }
        return summaries;
      });
    },
    findSession(cwd: string, sessionId: string): Promise<OmpStoreSessionSummary | null> {
      return serial(async () => {
        // 根因：列表只暴露 canonical UUID，旧 GUI 接受的逻辑 ID 必须按 aliases 精确恢复。
        for (const { path, history } of await histories(cwd)) {
          if (!matches(history, sessionId)) continue;
          const summary = await summaryOfHistory(path, history);
          if (summary) return summary;
        }
        return null;
      });
    },
    appendCommandOutput(
      session: OmpCommandOutputSession,
      record: OmpCommandOutputRecord,
    ): Promise<void> {
      return serial(async () => {
        // core 在 message_end 前已 flush；journal 有该 custom 时不保存第二份显示副本。
        if (await customAlreadyPersisted(session.sessionPath, record)) return;
        const nativeSessionId =
          record.nativeSessionId ??
          (record.customType !== undefined ? ompSessionIdOfFilePath(session.sessionPath) : null);
        const directory = directoryOf(session.cwd);
        await mkdir(directory, { recursive: true });
        const existing = (await histories(session.cwd)).find(({ history }) =>
          matches(history, session.sessionId, session.sessionPath),
        );
        const path = existing?.path ?? join(directory, `${digest(session.sessionId)}.json`);
        const history = existing?.history ?? {
          version: 1 as const,
          sessionId: session.sessionId,
          sessionPath: null,
          nativeFileObserved: false,
          aliases: [session.sessionId],
          title: null,
          outputs: [],
        };
        await associate(history, session);
        if (!history.outputs.some((output) => output.id === record.id))
          history.outputs.push({
            id: record.id,
            text: record.text,
            createdAt: record.createdAt,
            ...(record.customType !== undefined ? { customType: record.customType } : {}),
            ...(record.nativeTimestamp !== undefined
              ? { nativeTimestamp: record.nativeTimestamp }
              : {}),
            ...(nativeSessionId ? { nativeSessionId } : {}),
          });
        await writeHistory(path, history);
      });
    },
    associateCommandOutputs(session: OmpCommandOutputSession): Promise<void> {
      return serial(async () => {
        for (const { path, history } of await histories(session.cwd)) {
          if (!matches(history, session.sessionId, session.sessionPath)) continue;
          const before = JSON.stringify(history);
          await associate(history, session);
          if (JSON.stringify(history) !== before) await writeHistory(path, history);
        }
      });
    },
    async readCommandOutputs(
      cwd: string,
      sessionId: string,
      sessionPath?: string | null,
    ): Promise<OmpCommandOutputRecord[]> {
      await tail;
      const records = new Map<string, OmpCommandOutputRecord>();
      for (const { history } of await histories(cwd)) {
        if (!matches(history, sessionId, sessionPath)) continue;
        for (const output of history.outputs)
          if (!records.has(output.id)) records.set(output.id, output);
      }
      return [...records.values()].sort((left, right) => left.createdAt - right.createdAt);
    },
    deleteCommandOutputs(
      cwd: string,
      sessionId: string,
      sessionPath?: string | null,
    ): Promise<boolean> {
      return serial(async () => {
        for (const { path, history } of await histories(cwd)) {
          if (matches(history, sessionId, sessionPath)) await rm(path, { force: true });
        }
        return true;
      });
    },
    async flushCommandOutputs(): Promise<void> {
      await tail;
      if (writeFailure !== undefined) {
        const failure = writeFailure;
        writeFailure = undefined;
        throw failure;
      }
    },
  };
}

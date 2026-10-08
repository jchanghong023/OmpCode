import { createReadStream } from "node:fs";
import { open, type FileHandle } from "node:fs/promises";
import { StringDecoder } from "node:string_decoder";
import type { OmpCommandOutputRecord } from "../domain/OmpCommandOutput.js";
import { nativeOmpCustomDisplays } from "../domain/OmpCustomMessage.js";
import { ompSessionIdOfFilePath } from "../domain/ids.js";

interface NativeCustomIndex {
  identity: string;
  modifiedAt: number;
  changedAt: number;
  offset: number;
  decoder: StringDecoder;
  partialLine: string;
  keys: Set<string>;
}

function nativeCustomKeys(line: string): string[] {
  let entry: unknown;
  try {
    entry = JSON.parse(line);
  } catch {
    return [];
  }
  return nativeOmpCustomDisplays([entry])
    .filter((native) => native.timestamp !== undefined)
    .map((native) => JSON.stringify([native.customType, native.text, native.timestamp]));
}

/** 仅由 command-output store 的串行链调用；JSONL 是事实源，索引只保存读取游标。 */
export class NativeCustomOutputIndex {
  // 根因：每条 custom 都从头扫描 journal，长会话连续输出产生 N 倍读取。
  // 不缓存永久的“未落盘”；首次扫描后继续读取追加字节。
  // 可观察的截短/替换会失效；不检测外部在两次读取间同 inode 截短再长大。
  private readonly indexes = new Map<string, NativeCustomIndex>();

  invalidate(sessionPath: string): void {
    this.indexes.delete(sessionPath);
  }

  async hasPersisted(sessionPath: string | null, record: OmpCommandOutputRecord): Promise<boolean> {
    if (!sessionPath || record.customType === undefined || record.nativeTimestamp === undefined)
      return false;
    if (
      record.nativeSessionId !== undefined &&
      record.nativeSessionId !== ompSessionIdOfFilePath(sessionPath)
    )
      return false;
    let handle: FileHandle | undefined;
    try {
      handle = await open(sessionPath, "r");
      // 用打开的文件身份判断替换，避免 stat(path) 与真正读取的文件不一致。
      const info = await handle.stat();
      const identity = `${info.dev}:${info.ino}:${info.birthtimeMs}`;
      let index = this.indexes.get(sessionPath);
      if (
        !index ||
        index.identity !== identity ||
        info.size < index.offset ||
        (info.size === index.offset &&
          (info.mtimeMs !== index.modifiedAt || info.ctimeMs !== index.changedAt))
      ) {
        index = {
          identity,
          modifiedAt: info.mtimeMs,
          changedAt: info.ctimeMs,
          offset: 0,
          decoder: new StringDecoder("utf8"),
          partialLine: "",
          keys: new Set(),
        };
        this.indexes.set(sessionPath, index);
      }
      if (info.size > index.offset) {
        // 裸 fd 的 stream.destroy() 会关描述符，却不更新 FileHandle，外层 close 因而 EBADF。
        // 传入同一 FileHandle，让 Node 同步唯一 fd owner 的关闭状态；不吞关闭失败。
        const stream = createReadStream(sessionPath, {
          fd: handle,
          autoClose: false,
          start: index.offset,
          end: info.size - 1,
        });
        try {
          for await (const chunk of stream) {
            const bytes = chunk as Buffer;
            const text = index.partialLine + index.decoder.write(bytes);
            let start = 0;
            let end: number;
            while ((end = text.indexOf("\n", start)) !== -1) {
              for (const key of nativeCustomKeys(text.slice(start, end))) index.keys.add(key);
              start = end + 1;
            }
            // 保留未完成行及 UTF-8 半字符；后续 flush 只续读追加字节。
            index.partialLine = text.slice(start);
            index.offset += bytes.length;
          }
        } finally {
          stream.destroy();
        }
      }
      index.modifiedAt = info.mtimeMs;
      index.changedAt = info.ctimeMs;
      const key = JSON.stringify([record.customType, record.text, record.nativeTimestamp]);
      // 无末尾换行的完整 JSON 也有效，但不把尚未定界的行写入长期索引。
      return index.keys.has(key) || nativeCustomKeys(index.partialLine).includes(key);
    } catch (error) {
      this.indexes.delete(sessionPath);
      if ((error as NodeJS.ErrnoException).code === "ENOENT") return false;
      throw error;
    } finally {
      await handle?.close();
    }
  }
}

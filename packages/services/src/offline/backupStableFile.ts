import { createHash } from "node:crypto";
import type { BigIntStats } from "node:fs";
import * as fs from "node:fs/promises";
import {
  assertRealPath,
  checkAbort,
  equalStamp,
  OfflineBackupError,
  openRegular,
  sameIdentity,
  stamp,
} from "./backupFiles.js";

export async function copyStable(
  source: string,
  destination: string,
  before: BigIntStats,
  appendOnly: boolean,
  buffer: Buffer,
  signal?: AbortSignal,
): Promise<{ sha256: string; prefixBytes?: number }> {
  const input = await openRegular(source);
  try {
    const opened = await input.stat({ bigint: true });
    if (
      appendOnly
        ? !sameIdentity(before, opened) || opened.size < before.size
        : !equalStamp(stamp(before), stamp(opened))
    ) {
      throw new OfflineBackupError("SOURCE_CHANGED");
    }
    if (before.size > BigInt(Number.MAX_SAFE_INTEGER))
      throw new OfflineBackupError("SOURCE_TOO_LARGE");
    let length = Number(before.size);
    if (appendOnly) {
      // Main appends complete newline records and rotates at 1MiB. Never chase
      // its growing EOF, and never publish an in-flight final record.
      let end = length;
      length = 0;
      while (end > 0) {
        checkAbort(signal);
        const start = Math.max(0, end - buffer.length);
        const { bytesRead } = await input.read(buffer, 0, end - start, start);
        if (bytesRead !== end - start) throw new OfflineBackupError("SOURCE_CHANGED");
        const newline = buffer.subarray(0, bytesRead).lastIndexOf(0x0a);
        if (newline >= 0) {
          length = start + newline + 1;
          break;
        }
        end = start;
      }
    }
    const mode = (before.mode & 0o111n) !== 0n ? 0o700 : 0o600;
    const output = await fs.open(destination, "wx", mode);
    try {
      await output.chmod(mode);
      const hash = createHash("sha256");
      let position = 0;
      while (position < length) {
        checkAbort(signal);
        const { bytesRead } = await input.read(
          buffer,
          0,
          Math.min(buffer.length, length - position),
          position,
        );
        if (bytesRead === 0) throw new OfflineBackupError("SOURCE_CHANGED");
        hash.update(buffer.subarray(0, bytesRead));
        let written = 0;
        while (written < bytesRead) {
          const result = await output.write(
            buffer,
            written,
            bytesRead - written,
            position + written,
          );
          if (result.bytesWritten === 0) throw new OfflineBackupError("INCOMPLETE_WRITE");
          written += result.bytesWritten;
        }
        position += bytesRead;
      }
      const sha256 = hash.digest("hex");
      if (appendOnly) {
        // Growth is permitted; rewriting/truncating an already copied prefix
        // is not. Verify the bounded prefix rather than trusting just its size.
        const verified = createHash("sha256");
        position = 0;
        while (position < length) {
          checkAbort(signal);
          const { bytesRead } = await input.read(
            buffer,
            0,
            Math.min(buffer.length, length - position),
            position,
          );
          if (bytesRead === 0) throw new OfflineBackupError("SOURCE_CHANGED");
          verified.update(buffer.subarray(0, bytesRead));
          position += bytesRead;
        }
        const after = await input.stat({ bigint: true });
        if (
          !sameIdentity(before, after) ||
          after.size < BigInt(length) ||
          verified.digest("hex") !== sha256
        ) {
          throw new OfflineBackupError("SOURCE_CHANGED");
        }
      } else if (!equalStamp(stamp(before), stamp(await input.stat({ bigint: true })))) {
        throw new OfflineBackupError("SOURCE_CHANGED");
      }
      await assertRealPath(source);
      if (!sameIdentity(before, await fs.lstat(source, { bigint: true }))) {
        throw new OfflineBackupError("SOURCE_CHANGED");
      }
      await output.sync();
      return { sha256, ...(appendOnly ? { prefixBytes: length } : {}) };
    } finally {
      await output.close();
    }
  } finally {
    await input.close();
  }
}

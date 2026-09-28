import assert from "node:assert/strict";
import { existsSync } from "node:fs";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";

/**
 * 离线锁定（OMPCODE_CENTOS7_LOCAL_ONLY=1）下 Main 日志 error-only 过滤：
 * 过滤发生在格式化、终端打印和文件排队之前（centos7-performance.md）。
 */

function dayFile(directory: string): string {
  const now = new Date();
  return join(
    directory,
    `${now.getFullYear()}-${String(now.getMonth() + 1).padStart(2, "0")}-${String(now.getDate()).padStart(2, "0")}.log`,
  );
}

test("离线锁定：仅 error 进入终端与文件，解除锁定后各级别恢复", async (context) => {
  const directory = await mkdtemp(join(tmpdir(), "omp-main-log-local-only-"));
  context.after(() => rm(directory, { recursive: true, force: true }));
  process.env.ZCODE_ENV = "test";
  process.env.ZCODE_E2E_RUNTIME_LOG_DIR = directory;
  const { logger } = await import("../src/main/logger.js");
  const file = dayFile(directory);
  const previousLocalOnly = process.env.OMPCODE_CENTOS7_LOCAL_ONLY;
  context.after(() => {
    if (previousLocalOnly === undefined) {
      delete process.env.OMPCODE_CENTOS7_LOCAL_ONLY;
    } else {
      process.env.OMPCODE_CENTOS7_LOCAL_ONLY = previousLocalOnly;
    }
  });

  const consoleLogArgs: unknown[][] = [];
  const originalConsoleLog = console.log;
  console.log = (...args: unknown[]) => {
    consoleLogArgs.push(args);
  };
  try {
    process.env.OMPCODE_CENTOS7_LOCAL_ONLY = "1";
    logger.debug("locked-debug-suppressed");
    logger.info("locked-info-suppressed");
    logger.warn("locked-warn-suppressed");
    logger.fromRenderer("info", ["locked-renderer-suppressed"]);
    assert.equal(existsSync(file), false, "非 error 级别在锁定下不得入队");
    assert.deepEqual(consoleLogArgs, [], "非 error 级别在锁定下不得打印终端");
    logger.error("locked-error-visible");
    await logger.flush();

    let content = await readFile(file, "utf8");
    assert.match(content, /locked-error-visible/);
    assert.doesNotMatch(content, /locked-(debug|info|warn|renderer)-suppressed/);

    // 解除锁定（与 Windows 全功能基准一致）：各级别恢复输出。
    process.env.OMPCODE_CENTOS7_LOCAL_ONLY = "0";
    logger.info("unlocked-info-visible");
    await logger.flush();
    content = await readFile(file, "utf8");
    assert.match(content, /unlocked-info-visible/);
    assert.ok(consoleLogArgs.length > 0, "未锁定时 info 恢复终端输出");
  } finally {
    console.log = originalConsoleLog;
  }
});

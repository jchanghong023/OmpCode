import assert from "node:assert/strict";
import { existsSync } from "node:fs";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";

test("主进程日志调用不等文件写入，退出屏障刷盘保留错误", async (context) => {
  const directory = await mkdtemp(join(tmpdir(), "omp-main-log-test-"));
  context.after(() => rm(directory, { recursive: true, force: true }));
  process.env.ZCODE_ENV = "test";
  process.env.ZCODE_E2E_RUNTIME_LOG_DIR = directory;
  const { logger } = await import("../src/main/logger.js");
  logger.info("async-fixture-info");
  logger.error("async-fixture-error");
  const file = join(
    directory,
    `${new Date().getFullYear()}-${String(new Date().getMonth() + 1).padStart(2, "0")}-${String(new Date().getDate()).padStart(2, "0")}.log`,
  );
  assert.equal(existsSync(file), false);
  await logger.flush();
  const content = await readFile(file, "utf8");
  assert.match(content, /async-fixture-info/);
  assert.match(content, /async-fixture-error/);
});

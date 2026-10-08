import assert from "node:assert/strict";
import { existsSync, statSync } from "node:fs";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";

/**
 * main 侧唯一有界异步队列的回归（centos7-performance.md：时间/容量上限显式常量
 * 且被测试引用，参考值 25ms 合批窗口与 4MiB 队列上限、退出 1 秒排空预算）。
 *
 * logger 模块在进程内持有单一 LOG_DIR 与队列：必须在设置测试环境后动态 import，
 * 避免模块顶层把 LOG_DIR 绑定到真实用户目录；本文件所有用例共享同一目录，
 * 各用例用独立标记互不干扰。
 */

// 目录与导入顺序不可调整：logger 模块顶层读取一次 LOG_DIR。
process.env.ZCODE_ENV = "test";
const logRoot = await mkdtemp(join(tmpdir(), "omp-main-log-test-"));
process.env.ZCODE_E2E_RUNTIME_LOG_DIR = logRoot;
const {
  logger,
  flushMainLogs,
  MAIN_LOG_FLUSH_WINDOW_MS,
  MAIN_LOG_MAX_QUEUED_BYTES,
  MAIN_LOG_EXIT_FLUSH_BUDGET_MS,
} = await import("../src/main/logger.js");

function dayFile(): string {
  const now = new Date();
  return join(
    logRoot,
    `${now.getFullYear()}-${String(now.getMonth() + 1).padStart(2, "0")}-${String(now.getDate()).padStart(2, "0")}.log`,
  );
}

async function fileContent(): Promise<string> {
  const file = dayFile();
  return existsSync(file) ? readFile(file, "utf8") : "";
}

test.after(() => rm(logRoot, { recursive: true, force: true }));

test("主进程日志调用不等文件写入，退出屏障刷盘保留错误", async () => {
  logger.info("async-fixture-info");
  logger.error("async-fixture-error");
  assert.equal(existsSync(dayFile()), false);
  await logger.flush();
  const content = await fileContent();
  assert.match(content, /async-fixture-info/);
  assert.match(content, /async-fixture-error/);
});

test("合批窗口：不调用 flush 也会在时间上限内落盘", async () => {
  logger.info("window-fixture-should-land");
  assert.equal(existsSync(dayFile()), true, "上一用例已 flush，本用例入队后不得立即追加");
  const before = await fileContent();
  // 不调用 flush：25ms 窗口 + 余量后必须由窗口排空，持续写入不能被无限延期。
  await new Promise((resolve) => setTimeout(resolve, MAIN_LOG_FLUSH_WINDOW_MS * 4 + 100));
  const content = await fileContent();
  assert.ok(
    content.includes("window-fixture-should-land") && content.length > before.length,
    "合批窗口到期后必须落盘",
  );
});

test("队列容量：超过 4MiB 上限时丢弃计数并在后续记录中报告", async () => {
  const file = dayFile();
  const sizeBefore = existsSync(file) ? statSync(file).size : 0;

  // 同步循环内入队超过 4MiB，事件循环无法中途排空，丢弃行为可确定复现。
  const consoleCalls: unknown[][] = [];
  const originalConsoleLog = console.log;
  console.log = (...args: unknown[]) => {
    consoleCalls.push(args);
  };
  try {
    const chunk = "x".repeat(16 * 1024);
    for (let index = 0; index < 320; index += 1) {
      logger.info(`cap-fixture-${index} ${chunk}`);
    }
  } finally {
    console.log = originalConsoleLog;
  }

  await logger.flush();
  assert.ok(consoleCalls.length > 0, "允许的日志同时写入 console");
  const written = statSync(file).size - sizeBefore;
  // 队列上限 + 丢弃报告行 + 正在写的最后一批余量。
  assert.ok(
    written <= MAIN_LOG_MAX_QUEUED_BYTES + 256 * 1024,
    `文件增量必须受 4MiB 队列上限约束，实际 ${written}`,
  );
  // 丢弃计数在容量释放后的下一条可入队记录中报告（需求：超限计数并在后续记录中报告）。
  logger.info("post-flood-small-line");
  await logger.flush();
  const content = await fileContent();
  assert.match(content, /log buffer dropped \d+ lines/);
  assert.match(content, /post-flood-small-line/);
});

test("退出排空共享预算：重复 flushMainLogs 不累加等待", async () => {
  logger.error("exit-fixture-error");
  const started = Date.now();
  await flushMainLogs();
  await flushMainLogs();
  await flushMainLogs();
  // 队列已空时排空应当即时完成；预算常量保证重复调用共用同一 deadline。
  assert.ok(Date.now() - started < MAIN_LOG_EXIT_FLUSH_BUDGET_MS);
  const content = await fileContent();
  assert.match(content, /exit-fixture-error/);
});

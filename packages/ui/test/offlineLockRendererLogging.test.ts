import assert from "node:assert/strict";
import { test } from "node:test";
// offlineLockGate 必须先于 logger 加载：logger 的门控读取其同步快照。
import { applyOfflineLockState } from "../src/lib/offlineLockGate.js";

// logger 在模块初始化时捕获 console 函数引用，桩必须先装、再动态导入 logger。
const calls: string[] = [];
const originalDebug = console.debug;
const originalLog = console.log;
const originalWarn = console.warn;
const originalError = console.error;
console.debug = (...args: unknown[]) => calls.push(`debug:${args.join("|")}`);
console.log = (...args: unknown[]) => calls.push(`log:${args.join("|")}`);
console.warn = (...args: unknown[]) => calls.push(`warn:${args.join("|")}`);
console.error = (...args: unknown[]) => calls.push(`error:${args.join("|")}`);

const { logger } = await import("../src/logger.js");

test("离线锁定下 renderer 只保留 error，解除锁定后恢复正常级别", () => {
  try {
    applyOfflineLockState({ localOnly: true });
    logger.info("locked-info");
    logger.warn("locked-warn");
    logger.error("locked-error");
    logger.lifecycle.info("locked-lifecycle-info");
    logger.lifecycle.error("locked-lifecycle-error");
    assert.equal(calls.filter((line) => line.startsWith("error:")).length, 2);
    assert.equal(calls.some((line) => line.includes("locked-info")), false);
    assert.equal(calls.some((line) => line.includes("locked-warn")), false);
    assert.equal(calls.some((line) => line.includes("locked-lifecycle-info")), false);

    calls.length = 0;
    applyOfflineLockState({ localOnly: false });
    logger.info("open-info");
    logger.lifecycle.info("open-lifecycle-info");
    assert.equal(calls.some((line) => line.includes("open-info")), true);
    assert.equal(calls.some((line) => line.includes("open-lifecycle-info")), true);
  } finally {
    console.debug = originalDebug;
    console.log = originalLog;
    console.warn = originalWarn;
    console.error = originalError;
    // 还原未锁定，避免影响同进程内的其他用例。
    applyOfflineLockState({ localOnly: false });
  }
});

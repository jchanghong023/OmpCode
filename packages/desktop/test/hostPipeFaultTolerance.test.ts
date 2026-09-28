import assert from "node:assert/strict";
import { test } from "node:test";
import { isClosedHostOutput } from "../src/host/closedOutputError.js";
import { createHostLogRelay } from "../src/main/hostLogRelay.js";

/**
 * Host 管道容错回归（centos7-release.md）：原始 stdout/stderr 管道不可用
 * （EBADF/EPIPE）时，写日志不得终止 Host，日志继续经结构化消息通道到达 Main；
 * 无关写错误保持可见。
 */

test("EBADF/EPIPE 分类为已关闭输出，无关错误与普通值不算", () => {
  assert.equal(
    isClosedHostOutput(Object.assign(new Error("broken pipe"), { code: "EPIPE" })),
    true,
  );
  assert.equal(isClosedHostOutput(Object.assign(new Error("bad fd"), { code: "EBADF" })), true);
  assert.equal(isClosedHostOutput(Object.assign(new Error("denied"), { code: "EACCES" })), false);
  assert.equal(isClosedHostOutput(new Error("no code")), false);
  assert.equal(isClosedHostOutput("EPIPE"), false);
  assert.equal(isClosedHostOutput(null), false);
  assert.equal(isClosedHostOutput({ code: "EPIPE" }), false);
});

function makeWriteGuard(): (...args: unknown[]) => void {
  // 与 host/index.ts writeRawHostConsole 相同的守卫形态，验证分类器的容错契约。
  return (...args: unknown[]) => {
    try {
      console.log(...args);
    } catch (error) {
      if (!isClosedHostOutput(error)) {
        throw error;
      }
    }
  };
}

test("同步写管道：EBADF/EPIPE 被吞掉，其余错误照常抛出", () => {
  const guard = makeWriteGuard();
  const originalLog = console.log;
  try {
    console.log = () => {
      throw Object.assign(new Error("pipe closed"), { code: "EPIPE" });
    };
    assert.doesNotThrow(() => guard("log-after-pipe-closed"));

    console.log = () => {
      throw Object.assign(new Error("bad descriptor"), { code: "EBADF" });
    };
    assert.doesNotThrow(() => guard("log-after-bad-fd"));

    console.log = () => {
      throw new Error("disk full");
    };
    assert.throws(() => guard("unrelated-failure"), /disk full/);
  } finally {
    console.log = originalLog;
  }
});

test("结构化日志优先：原始管道日志被抑制，结构化通道持续到达 Main", () => {
  const emitted: Array<{ level: string; message: string }> = [];
  const relay = createHostLogRelay("win-1", {
    info: (...args: unknown[]) => emitted.push({ level: "info", message: args.join(" ") }),
    warn: (...args: unknown[]) => emitted.push({ level: "warn", message: args.join(" ") }),
    error: (...args: unknown[]) => emitted.push({ level: "error", message: args.join(" ") }),
  });

  relay.onStdout("raw stdout before structured\n");
  relay.onStderr("raw stderr before structured\n");
  relay.onStructuredLog({ level: "info", source: "host", message: "structured heartbeat" });
  // 管道已死（EBADF/EPIPE）后 Host 仍通过结构化通道继续上报：
  relay.onStructuredLog({ level: "error", source: "host", message: "structured after pipe dead" });

  assert.equal(emitted.length, 2);
  assert.match(emitted[0]!.message, /\[host-log\] \(win-1\) \[host\] structured heartbeat/);
  assert.equal(emitted[0]!.level, "info");
  assert.equal(emitted[1]!.level, "error");
});

test("无结构化日志时退出兜底回放原始管道日志，Node warning 保持 warn 语义", () => {
  const emitted: Array<{ level: string; message: string }> = [];
  const relay = createHostLogRelay("win-2", {
    info: (...args: unknown[]) => emitted.push({ level: "info", message: args.join(" ") }),
    warn: (...args: unknown[]) => emitted.push({ level: "warn", message: args.join(" ") }),
    error: (...args: unknown[]) => emitted.push({ level: "error", message: args.join(" ") }),
  });

  relay.onStdout("early stdout\n");
  relay.onStderr("(node:123) ExperimentalWarning: something is experimental\n");
  relay.onStderr("fatal detail\n");
  relay.flushRawLogs();

  assert.equal(emitted.length, 3);
  assert.equal(emitted[0]!.level, "info");
  assert.match(emitted[0]!.message, /\[host-stdout\] \(win-2\): early stdout/);
  assert.equal(emitted[1]!.level, "warn");
  assert.doesNotMatch(emitted[1]!.message, /--trace-warnings/);
  assert.equal(emitted[2]!.level, "error");
  assert.match(emitted[2]!.message, /fatal detail/);
});

test("已见结构化日志时兜底回放清空缓存，不再输出原始日志", () => {
  const emitted: Array<{ level: string; message: string }> = [];
  const relay = createHostLogRelay("win-3", {
    info: (...args: unknown[]) => emitted.push({ level: "info", message: args.join(" ") }),
    warn: (...args: unknown[]) => emitted.push({ level: "warn", message: args.join(" ") }),
    error: (...args: unknown[]) => emitted.push({ level: "error", message: args.join(" ") }),
  });

  relay.onStdout("buffered\n");
  relay.onStructuredLog({ level: "warn", source: "host", message: "structured first" });
  relay.flushRawLogs();
  assert.equal(emitted.length, 1);
  assert.equal(emitted[0]!.level, "warn");
});

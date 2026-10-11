import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import test from "node:test";

const execute = promisify(execFile);
const loggerUrl = new URL("../src/logger/serviceLogger.ts", import.meta.url).href;

function runLogger(script: string) {
  return execute(process.execPath, ["--import", "tsx", "--input-type=module", "--eval", script], {
    cwd: new URL("../../..", import.meta.url),
    env: { ...process.env, JCH_LOG_LEVEL: "debug" },
  });
}

test("无 process 的浏览器读面保留日志、脱敏与注入 PID，不访问 stderr", async () => {
  const { stdout, stderr } = await runLogger(`
    const nodeProcess = process;
    delete globalThis.process;
    globalThis.__JCH_LOG_LEVEL__ = "debug";
    // 模块加载边界：必须先移除 process；静态 import 会提前求值，无法覆盖浏览器初始化。
    const { createServiceLogger } = await import(${JSON.stringify(loggerUrl)});
    const records = [];
    const sink = Object.fromEntries(["debug", "log", "warn", "error"].map(method =>
      [method, (...args) => records.push({ method, args })]));
    const logger = createServiceLogger("browser-service", { sink });
    logger.info(undefined, "Bearer browser-secret-token");
    logger.warn("trace-1", { kind: "visible" });
    createServiceLogger("injected-service", { pid: 123, sink }).error(undefined, "failure");
    const fail = () => { throw new Error("broken browser sink"); };
    const broken = createServiceLogger("broken-service", {
      sink: { log: fail, warn: fail, error: fail, debug: fail }
    });
    broken.info(undefined, "must not reach a Node fallback");
    nodeProcess.stdout.write(JSON.stringify(records));
  `);
  const records = JSON.parse(stdout) as { method: string; args: string[] }[];
  assert.equal(records.length, 3);
  assert.equal(records[0]?.method, "log");
  assert.match(records[0]?.args[0] ?? "", /\[browser-service\]/u);
  assert.doesNotMatch(records[0]?.args[0] ?? "", /\[pid:/u);
  assert.doesNotMatch(records[0]?.args[1] ?? "", /browser-secret-token/u);
  assert.equal(records[1]?.method, "warn");
  assert.match(records[1]?.args[0] ?? "", /\[browser-service\]\[trace:trace-1\]/u);
  assert.equal(JSON.parse(records[1]?.args[1] ?? "{}").kind, "visible");
  assert.equal(records[2]?.method, "error");
  assert.match(records[2]?.args[0] ?? "", /\[pid:123\] \[injected-service\]/u);
  assert.equal(stderr, "");
});

test("Node 保留真实 PID，sink 重复失败只向真实 stderr 报告一次", async () => {
  const { stdout, stderr } = await runLogger(`
    import { createServiceLogger } from ${JSON.stringify(loggerUrl)};
    const records = [];
    const sink = { log: (...args) => records.push(args), warn() {}, error() {} };
    createServiceLogger("node-service", { sink }).info(undefined, "node message");
    const fail = () => { throw new Error("private sink failure"); };
    const broken = createServiceLogger("broken-service", {
      sink: { log: fail, warn: fail, error: fail }
    });
    broken.info(undefined, "first");
    broken.info(undefined, "second");
    process.stdout.write(JSON.stringify({ pid: process.pid, records }));
  `);
  const result = JSON.parse(stdout) as { pid: number; records: string[][] };
  assert.match(
    result.records[0]?.[0] ?? "",
    new RegExp(`\\[pid:${result.pid}\\] \\[node-service\\]`, "u"),
  );
  assert.equal(result.records[0]?.[1], "node message");
  const failures = stderr
    .trim()
    .split("\n")
    .map((line) => JSON.parse(line));
  assert.equal(failures.length, 1);
  assert.equal(failures[0].event, "service_log_sink_failed");
  assert.equal(failures[0].pid, result.pid);
  assert.equal(failures[0].level, "error");
  assert.doesNotMatch(stderr, /private sink failure|first|second/u);
});

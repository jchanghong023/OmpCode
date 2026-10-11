import assert from "node:assert/strict";
import test from "node:test";
import { Emitter } from "@zcode/rpc";
import type { ZCodeProtocolMessage } from "@zcode/shared";
import { z } from "zod";
import {
  forwardOmpAgentDiagnostic,
  type OmpDiagnosticHostContext,
} from "../src/zcode-agent/ompDiagnosticLog.js";
import { ZCodeProtocolClient } from "../src/zcode-agent/zcodeProtocolClient.js";

const host: OmpDiagnosticHostContext = {
  workspaceKey: "workspace-a",
  workspaceIdentity: "identity-a",
  workspacePath: "F:/work/a",
  runtimeGeneration: 1,
  runtimeInstanceId: "runtime-a",
  agentPid: 42,
};

function source(fields: Record<string, unknown> = {}): string {
  return JSON.stringify({
    ts: 1_797_000_000_123,
    pid: 42,
    scope: "omp-agent",
    level: "warn",
    event: "omp_rpc_failed",
    message: "request failed",
    ...fields,
  });
}

test("存活 Agent 按 JCH_LOG_LEVEL 交付，生产 DEBUG 不被覆盖且阈值过滤不进入退出尾部", (t) => {
  const previous = process.env.ZCODE_RUNTIME_ENV;
  const previousLevel = process.env.JCH_LOG_LEVEL;
  process.env.ZCODE_RUNTIME_ENV = "production";
  process.env.JCH_LOG_LEVEL = " DeBuG ";
  const warnings: unknown[][] = [];
  const errors: unknown[][] = [];
  const debug: unknown[][] = [];
  t.mock.method(console, "warn", (...args: unknown[]) => warnings.push(args));
  t.mock.method(console, "error", (...args: unknown[]) => errors.push(args));
  t.mock.method(console, "debug", (...args: unknown[]) => debug.push(args));
  try {
    assert.equal(forwardOmpAgentDiagnostic(source(), host), true);
    assert.equal(warnings.length, 1);
    assert.equal(forwardOmpAgentDiagnostic(source({ level: "error" }), host), true);
    assert.equal(errors.length, 1);
    assert.equal(forwardOmpAgentDiagnostic(source({ level: "debug" }), host), true);
    assert.equal(debug.length, 1);
    const forwardedDebug = JSON.parse(String(debug[0]?.[1]));
    assert.equal(forwardedDebug.level, "debug");
    assert.equal(forwardedDebug.pid, 42);
    process.env.JCH_LOG_LEVEL = "warning";
    assert.equal(forwardOmpAgentDiagnostic(source({ level: "debug" }), host), true);
    assert.equal(debug.length, 1);
    assert.equal(forwardOmpAgentDiagnostic(source(), host), true);
    assert.equal(warnings.length, 2);
    const forwarded = JSON.parse(String(warnings[0]?.[1]));
    assert.equal(forwarded.ts, 1_797_000_000_123);
    assert.equal(forwarded.pid, 42);
    assert.equal(forwarded.event, "omp_rpc_failed");
  } finally {
    if (previous === undefined) delete process.env.ZCODE_RUNTIME_ENV;
    else process.env.ZCODE_RUNTIME_ENV = previous;
    if (previousLevel === undefined) delete process.env.JCH_LOG_LEVEL;
    else process.env.JCH_LOG_LEVEL = previousLevel;
  }
});

test("安全摘要限长、隐藏凭据和未知正文，子进程不能伪造 Host 或串代身份", (t) => {
  const records: Record<string, unknown>[] = [];
  t.mock.method(console, "warn", (_prefix: unknown, json: unknown) =>
    records.push(JSON.parse(String(json))),
  );
  const oldRuntime = {
    ...host,
    runtimeInstanceId: "runtime-old",
    runtimeGeneration: 3,
    agentPid: 30,
  };
  const nextRuntime = {
    ...host,
    runtimeInstanceId: "runtime-new",
    runtimeGeneration: 4,
    agentPid: 40,
  };
  const line = source({
    pid: 300,
    workspaceKey: "forged",
    workspaceIdentity: "forged",
    workspacePath: "forged",
    runtimeInstanceId: "forged",
    runtimeGeneration: 999,
    agentPid: 999,
    requestId: "host-7",
    ompRequestId: "omp-req-2",
    coreInstanceId: "core-a",
    supportedProtocolVersions: [1, 3],
    message: "Bearer secret-token https://user:password@example.com/api?token=secret-query",
    errorMessage: "x".repeat(5_000),
    params: { prompt: "private prompt" },
    data: "private answer",
    secret: "private key",
    unknownBody: { value: "private body" },
  });
  assert.equal(forwardOmpAgentDiagnostic(line, nextRuntime), true);
  assert.equal(forwardOmpAgentDiagnostic(line, oldRuntime), true);
  assert.equal(records[0]?.runtimeInstanceId, "runtime-new");
  assert.equal(records[1]?.runtimeInstanceId, "runtime-old");
  assert.equal(records[0]?.agentPid, 40);
  assert.equal(records[1]?.agentPid, 30);
  assert.equal(records[0]?.pid, 300);
  assert.equal(records[0]?.workspaceKey, host.workspaceKey);
  assert.equal(records[0]?.workspacePath, host.workspacePath);
  assert.equal(records[0]?.requestId, "host-7");
  assert.deepEqual(records[0]?.supportedProtocolVersions, [1, 3]);
  assert.equal(records[0]?.truncated, true);
  assert.match(String(records[0]?.errorMessage), /\[truncated\]$/);
  const output = JSON.stringify(records);
  for (const privateValue of [
    "secret-token",
    "password",
    "secret-query",
    "private prompt",
    "private answer",
    "private key",
    "private body",
  ]) {
    assert.equal(output.includes(privateValue), false);
  }
});

test("不合法或超长 stderr JSON 不成为普通生产日志", (t) => {
  let delivered = 0;
  for (const method of ["log", "warn", "error", "debug"] as const) {
    t.mock.method(console, method, () => {
      delivered += 1;
    });
  }
  const invalid = [
    "not json",
    "null",
    "[]",
    "{",
    source({ scope: "other" }),
    source({ level: "fatal" }),
    source({ ts: "not a timestamp" }),
    source({ pid: -1 }),
    source({ message: { body: "secret" } }),
    source({ event: "unsafe\nevent" }),
    source({ message: "x".repeat(40_000) }),
  ];
  for (const line of invalid) assert.equal(forwardOmpAgentDiagnostic(line, host), false);
  assert.equal(delivered, 0);
});

for (const outcome of [
  "success",
  "remote",
  "decode",
  "disconnect",
  "send",
  "timeout",
  "cancel",
] as const) {
  test(`Host 请求在 send 前记录开始且 ${outcome} 仅记录一次终态`, async (t) => {
    const logs: Record<string, unknown>[] = [];
    for (const method of ["log", "warn", "error"] as const) {
      t.mock.method(console, method, (_prefix: unknown, json: unknown) => {
        if (typeof json === "string") logs.push(JSON.parse(json));
      });
    }
    const messages = new Emitter<ZCodeProtocolMessage>();
    const closes = new Emitter<{ reason?: string }>();
    const client = new ZCodeProtocolClient(
      {
        kind: "memory",
        onMessage: messages.event,
        onClose: closes.event,
        async send() {
          assert.equal(logs[0]?.event, "omp_host_request_started");
          if (outcome === "send") throw new Error("write failed");
        },
        dispose() {},
      },
      { diagnosticContext: host },
    );
    try {
      const controller = new AbortController();
      const request = client.request(
        "v4/conversation/workflowRuns",
        {
          sessionId: "session-a",
          inputId: "input-a",
          content: "private prompt",
        },
        outcome === "decode" ? z.string() : undefined,
        {
          trace: { traceId: "trace-a", traceparent: "not-for-log" },
          signal: controller.signal,
          timeoutMs: outcome === "timeout" ? 1 : 10_000,
        },
      );
      const result =
        outcome === "success"
          ? request.then((value) => assert.deepEqual(value, { state: "ready" }))
          : assert.rejects(request);
      if (outcome === "success" || outcome === "decode") {
        messages.fire({ id: 1, result: { state: "ready" } });
        messages.fire({ id: 1, result: { state: "duplicate" } });
      } else if (outcome === "remote") {
        messages.fire({
          id: 1,
          error: { code: -32601, message: "not supported", data: "private response" },
        });
        messages.fire({ id: 1, error: { code: -32601, message: "duplicate" } });
      } else if (outcome === "disconnect") {
        closes.fire({ reason: "EOF" });
      } else if (outcome === "cancel") {
        controller.abort(new Error("cancelled"));
      }
      await result;
      assert.equal(logs.length, 2);
      const final = logs[1];
      assert.equal(final?.requestId, 1);
      assert.equal(final?.stage, outcome === "success" ? "response_decoded" : outcome);
      assert.equal(final?.runtimeInstanceId, host.runtimeInstanceId);
      assert.equal(final?.traceId, "trace-a");
      assert.equal(final?.sessionId, "session-a");
      assert.equal(typeof final?.elapsedMs, "number");
      assert.equal(JSON.stringify(logs).includes("private"), false);
      assert.equal(JSON.stringify(logs).includes("not-for-log"), false);
    } finally {
      client.dispose();
      messages.dispose();
      closes.dispose();
    }
  });
}

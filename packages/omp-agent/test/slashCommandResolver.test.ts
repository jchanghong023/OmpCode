import assert from "node:assert/strict";
import test from "node:test";
import { createSlashCommandResolver } from "../src/app/slashCommandResolver.js";
import { dispatchOmpText } from "../src/app/ompPromptDispatch.js";
import type {
  OmpCommandOutcome,
  OmpDirectoryGatewayPort,
  OmpSessionProcess,
} from "../src/app/ports.js";
import type { OmpCommandFrame } from "../src/domain/ompFrames.js";
import { createDirectoryStub } from "./fixtures/directoryStub.js";

function catalogFlight() {
  let resolve!: (outcome: OmpCommandOutcome) => void;
  const promise = new Promise<OmpCommandOutcome>((done) => {
    resolve = done;
  });
  return { promise, resolve };
}

function dispatchFixture(send: OmpDirectoryGatewayPort["send"]) {
  const resolver = createSlashCommandResolver({ ...createDirectoryStub(), send });
  const sent: OmpCommandFrame[] = [];
  const process: OmpSessionProcess = {
    ompSessionFile: null,
    async start() {},
    async send(command) {
      sent.push(command);
      return { success: true, data: { agentInvoked: false } };
    },
    respondUi() {},
    async refreshState() {
      return null;
    },
    async readContextReport() {
      return null;
    },
    async dispose() {},
  };
  return {
    resolver,
    sent,
    dispatch(text: string) {
      return dispatchOmpText({
        process,
        text,
        images: [],
        streaming: false,
        followupMode: "queue",
        modelSelection: { provider: "new", model: "selected" },
        currentConfig: { provider: "old", model: "current", thought: "off" },
        resolveSlashCommand: resolver.resolve,
      });
    },
  };
}

const removedCatalog: OmpCommandOutcome = {
  success: true,
  data: { commands: [{ name: "removed", execution: "omp" }] },
};
const currentCatalog: OmpCommandOutcome = {
  success: true,
  data: { commands: [{ name: "added", execution: "omp" }] },
};

test("invalidate 后旧目录不能授权已移除命令，新目录新增命令可正常分发", async () => {
  const old = catalogFlight();
  let queries = 0;
  const f = dispatchFixture(async () => {
    queries += 1;
    return queries === 1 ? old.promise : currentCatalog;
  });
  const removed = f.dispatch("/removed");
  assert.equal(queries, 1);
  f.resolver.invalidate();
  old.resolve(removedCatalog);
  const rejection = await removed;
  assert.equal(rejection.success, false);
  assert.equal(rejection.code, "omp_command_unknown");
  assert.deepEqual(f.sent, []);
  assert.equal((await f.dispatch("/added argument")).success, true);
  assert.equal(f.sent.filter((command) => command.type === "prompt").length, 1);
  assert.equal(f.sent.find((command) => command.type === "prompt")?.message, "/added argument");
});

test("旧目录 finally 不清新代 flight，跨代并发提交共享当前查询", async () => {
  const old = catalogFlight();
  const current = catalogFlight();
  let queries = 0;
  const f = dispatchFixture(async () => {
    queries += 1;
    if (queries === 1) return old.promise;
    if (queries === 2) return current.promise;
    throw new Error("unexpected duplicate catalog query");
  });
  const first = f.dispatch("/added first");
  f.resolver.invalidate();
  const second = f.dispatch("/added second");
  const oldFinished = old.promise.then(() => undefined);
  old.resolve(removedCatalog);
  await oldFinished;
  const third = f.dispatch("/added third");
  assert.equal(queries, 2);
  current.resolve(currentCatalog);
  const outcomes = await Promise.all([first, second, third]);
  assert.ok(outcomes.every((outcome) => outcome.success));
  assert.equal(queries, 2);
  assert.equal(f.sent.filter((command) => command.type === "prompt").length, 3);
});

test("正常并发解析只读一次目录，后续命中复用当前缓存", async () => {
  const catalog = catalogFlight();
  let queries = 0;
  const f = dispatchFixture(async () => {
    queries += 1;
    return catalog.promise;
  });
  const first = f.dispatch("/added one");
  const second = f.dispatch("/added two");
  assert.equal(queries, 1);
  catalog.resolve(currentCatalog);
  assert.ok((await Promise.all([first, second])).every((outcome) => outcome.success));
  assert.equal((await f.dispatch("/added three")).success, true);
  assert.equal(queries, 1);
  assert.equal(f.sent.filter((command) => command.type === "prompt").length, 3);
});

test("目录更新后的传输/核心/schema 失败明确 unknown，旧可执行命令不 dispatch", async () => {
  const failures: (OmpCommandOutcome | "transport")[] = [
    "transport",
    { success: false, error: "catalog failed" },
    { success: true, data: { commands: [{ name: 42 }] } },
  ];
  for (const failure of failures) {
    let queries = 0;
    const f = dispatchFixture(async () => {
      queries += 1;
      if (queries === 1) return removedCatalog;
      if (failure === "transport") throw new Error("catalog transport failed");
      return failure;
    });
    assert.equal((await f.dispatch("/removed")).success, true);
    f.sent.length = 0;
    f.resolver.invalidate();
    const rejection = await f.dispatch("/removed");
    assert.equal(rejection.success, false);
    assert.equal(rejection.code, "omp_command_unknown");
    assert.deepEqual(f.sent, []);
  }
});

test("unknown 复核失败使当前目录失效，不能以旧目录继续授权其他命令", async () => {
  let queries = 0;
  const f = dispatchFixture(async () => {
    queries += 1;
    return queries === 1 ? removedCatalog : { success: false, error: "catalog failed" };
  });
  assert.equal((await f.dispatch("/removed")).success, true);
  f.sent.length = 0;
  assert.equal((await f.dispatch("/unknown")).code, "omp_command_unknown");
  assert.equal((await f.dispatch("/removed")).code, "omp_command_unknown");
  assert.deepEqual(f.sent, []);
});

test("旧核 v1 命令与别名仍可执行，TUI-only 和不可用目录命令保持拒绝", async () => {
  const f = dispatchFixture(async () => ({
    success: true,
    data: {
      commands: [
        { name: "legacy", aliases: ["alias"], input: { hint: "argument" } },
        { name: "terminal", execution: "tui" },
        { name: "unavailable", availability: { available: false, reason: "unsupported" } },
      ],
    },
  }));
  assert.equal((await f.dispatch("/alias argument")).success, true);
  f.sent.length = 0;
  assert.equal((await f.dispatch("/terminal")).code, "omp_command_tui_only");
  assert.equal((await f.dispatch("/unavailable")).code, "omp_command_tui_only");
  assert.deepEqual(f.sent, []);
});

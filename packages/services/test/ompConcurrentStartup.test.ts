import assert from "node:assert/strict";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { createZCodeAgentService } from "../src/zcode-agent/zcodeAgentService.js";
import { setDataBaseDir } from "../src/paths.js";

// 真实 stdio 子进程只实现只读关闭判据，不调用模型、不读取用户配置。
const fakeAgent = `
import { appendFileSync } from "node:fs";
import { createInterface } from "node:readline";
const sessions = new Set(["existing-a", "existing-b", "existing-new"]);
const input = createInterface({ input: process.stdin });
input.on("line", (line) => {
  const request = JSON.parse(line);
  appendFileSync(process.argv[1], JSON.stringify({method: request.method, sessionId: request.params?.sessionId}) + "\\n");
  if (request.method === "session/close") {
    const closed = sessions.delete(request.params.sessionId);
    process.stdout.write(JSON.stringify({ id: request.id, result: { closed } }) + "\\n");
  } else {
    process.stdout.write(JSON.stringify({ id: request.id, error: { code: -32601, message: "unsupported" } }) + "\\n");
  }
});
input.on("close", () => process.exit(0));
`;

function deferred() {
  let resolve!: () => void;
  const promise = new Promise<void>((done) => { resolve = done; });
  return { promise, resolve };
}

async function requestsAt(path: string) {
  const text = await readFile(path, "utf8");
  return text.trim().split("\n").map((line) => JSON.parse(line) as {
    method: string;
    sessionId: string;
  });
}

test("same-generation concurrent consumers share startup and both reach the stdio runtime", async () => {
  const root = await mkdtemp(join(tmpdir(), "omp-concurrent-start-"));
  setDataBaseDir(root);
  const entered = deferred();
  const release = deferred();
  const requestPath = join(root, "requests.jsonl");
  let starts = 0;
  const service = createZCodeAgentService({
    requestTimeoutMs: 2_000,
    commandResolver: async () => {
      starts += 1;
      entered.resolve();
      await release.promise;
      return { command: process.execPath, args: ["--input-type=module", "-e", fakeAgent, requestPath] };
    },
  });
  try {
    const first = service.closeSession({ workspacePath: root, sessionId: "existing-a" });
    const second = service.closeSession({ workspacePath: root, sessionId: "existing-b" });
    const results = Promise.all([first, second]);
    await entered.promise;
    release.resolve();
    assert.deepEqual(await results, [true, true]);
    assert.equal(starts, 1);
    assert.deepEqual(
      (await requestsAt(requestPath)).map((request) => request.sessionId).sort(),
      ["existing-a", "existing-b"],
    );
    // 同一进程内的关闭真实改变 fixture 状态，重复关闭并非 echo 成功。
    assert.equal(await service.closeSession({ workspacePath: root, sessionId: "existing-a" }), false);
  } finally {
    release.resolve();
    await service.disposeAllAndWait();
    setDataBaseDir(null);
    await rm(root, { recursive: true, force: true });
  }
});

test("release cancels old startup without dispatch, and the next generation remains usable", async () => {
  const root = await mkdtemp(join(tmpdir(), "omp-cancel-start-"));
  setDataBaseDir(root);
  const entered = deferred();
  const release = deferred();
  const requestPath = join(root, "requests.jsonl");
  let starts = 0;
  const service = createZCodeAgentService({
    requestTimeoutMs: 2_000,
    commandResolver: async () => {
      starts += 1;
      if (starts === 1) {
        entered.resolve();
        await release.promise;
      }
      return { command: process.execPath, args: ["--input-type=module", "-e", fakeAgent, requestPath] };
    },
  });
  try {
    const old = service.closeSession({ workspacePath: root, sessionId: "existing-a" });
    const rejected = assert.rejects(old, /cancelled|unavailable/i);
    await entered.promise;
    await service.disposeWorkspace({ workspacePath: root });
    release.resolve();
    await rejected;
    assert.equal(await service.closeSession({ workspacePath: root, sessionId: "existing-new" }), true);
    assert.equal(starts, 2);
    assert.deepEqual(await requestsAt(requestPath), [
      { method: "session/close", sessionId: "existing-new" },
    ]);
  } finally {
    release.resolve();
    await service.disposeAllAndWait();
    setDataBaseDir(null);
    await rm(root, { recursive: true, force: true });
  }
});

test("failed startup is shared by concurrent consumers and does not poison the next attempt", async () => {
  const root = await mkdtemp(join(tmpdir(), "omp-failed-start-"));
  setDataBaseDir(root);
  const entered = deferred();
  const release = deferred();
  const requestPath = join(root, "requests.jsonl");
  let starts = 0;
  const service = createZCodeAgentService({
    requestTimeoutMs: 2_000,
    commandResolver: async () => {
      starts += 1;
      if (starts === 1) {
        entered.resolve();
        await release.promise;
        throw new Error("isolated startup failure");
      }
      return { command: process.execPath, args: ["--input-type=module", "-e", fakeAgent, requestPath] };
    },
  });
  try {
    const results = Promise.allSettled([
      service.closeSession({ workspacePath: root, sessionId: "existing-a" }),
      service.closeSession({ workspacePath: root, sessionId: "existing-b" }),
    ]);
    await entered.promise;
    release.resolve();
    for (const result of await results) {
      assert.equal(result.status, "rejected");
      if (result.status === "rejected") assert.match(String(result.reason), /isolated startup failure/);
    }
    assert.equal(starts, 1);
    assert.equal(await service.closeSession({ workspacePath: root, sessionId: "existing-new" }), true);
    assert.equal(starts, 2);
    assert.deepEqual(await requestsAt(requestPath), [
      { method: "session/close", sessionId: "existing-new" },
    ]);
  } finally {
    release.resolve();
    await service.disposeAllAndWait();
    setDataBaseDir(null);
    await rm(root, { recursive: true, force: true });
  }
});

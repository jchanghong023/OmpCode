import assert from "node:assert/strict";
import { test } from "node:test";
import { spawn } from "node:child_process";
import { createRequire } from "node:module";
import { createInterface } from "node:readline";
import { mkdtemp, mkdir, rm, writeFile, readFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join, relative, resolve, sep } from "node:path";
import { fileURLToPath } from "node:url";
import { zcodeSessionAgentInteractionsResultSchema } from "@zcode/shared";
import { setTimeout as sleep } from "node:timers/promises";

const packageRoot = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const tsxCli = join(
  dirname(createRequire(import.meta.url).resolve("tsx/package.json")),
  "dist",
  "cli.mjs",
);
const sessionId = "10000000-0000-4000-8000-000000000001";
function start(env: Record<string, string>, workspacePath: string) {
  const child = spawn(
    process.execPath,
    [
      tsxCli,
      join(packageRoot, "src/adapters/cliMain.ts"),
      "app-server",
      "--stdio",
      "--cwd",
      workspacePath,
    ],
    {
      cwd: workspacePath,
      windowsHide: true,
      env: { ...process.env, ...env },
      stdio: ["pipe", "pipe", "pipe"],
    },
  );
  const frames: Record<string, unknown>[] = [];
  let stderr = "";
  child.stderr.on("data", (value) => {
    stderr = `${stderr}${value}`.slice(-2000);
  });
  createInterface({ input: child.stdout }).on("line", (line) => {
    try {
      frames.push(JSON.parse(line));
    } catch {}
  });
  let requestId = 0;
  const request = async (method: string, params: unknown) => {
    const id = ++requestId;
    child.stdin.write(`${JSON.stringify({ id, method, params })}\n`);
    for (let attempt = 0; attempt < 500; attempt += 1) {
      const frame = frames.find((frame) => frame.id === id);
      if (frame) return frame;
      if (child.exitCode !== null) assert.fail(`adapter exited ${child.exitCode}: ${stderr}`);
      await sleep(20);
    }
    assert.fail(`request timed out: ${method}: ${stderr}`);
  };
  const close = async () => {
    if (child.exitCode !== null) return;
    const exited = new Promise<void>((done) => child.once("exit", () => done()));
    child.stdin.end();
    const timeout = setTimeout(() => child.kill(), 3000);
    await exited;
    clearTimeout(timeout);
  };
  return { request, close };
}

test("真实adapter stdio公开只读查询覆盖live+两种订阅+重启cold，读取不执行模型", async (context) => {
  const root = await mkdtemp(join(tmpdir(), "omp-interactions-protocol-"));
  context.after(async () => {
    assert.ok(resolve(root).startsWith(`${resolve(tmpdir())}${sep}`));
    await rm(root, { recursive: true, force: true });
  });
  const workspacePath = join(root, "workspace");
  const config = join(root, "omp");
  await mkdir(workspacePath, { recursive: true });
  const encoded = `-tmp-${relative(tmpdir(), workspacePath).replace(/[/\\:]/g, "-")}`;
  const sessionDirectory = join(config, "agent", "sessions", encoded);
  await mkdir(sessionDirectory, { recursive: true });
  const rootFile = join(sessionDirectory, `2026-10-08T00-00-00-000Z_${sessionId}.jsonl`);
  await writeFile(
    rootFile,
    `${JSON.stringify({ type: "session", id: sessionId, cwd: workspacePath })}\n`,
  );
  const promptLog = join(root, "prompt.log");
  const env = {
    OMP_CONFIG_ROOT: config,
    ZCODE_WORKSPACE_IDENTITY: "isolated-interactions",
    OMP_RPC_BINARY_PATH: process.execPath,
    OMP_RPC_ARGS_JSON: JSON.stringify([join(packageRoot, "test/fixtures/fakeOmpInteractions.mjs")]),
    FAKE_INTERACTION_SESSION_FILE: rootFile,
    FAKE_INTERACTION_SESSION_ID: sessionId,
    FAKE_INTERACTION_PROMPT_LOG: promptLog,
  };
  const workspace = {
    workspacePath,
    workspaceIdentity: "isolated-interactions",
    workspaceKey: "isolated-interactions",
  };
  const first = start(env, workspacePath);
  let liveEvents: unknown[] = [];
  try {
    const coldBefore = await first.request("session/agentInteractions", { workspace, sessionId });
    assert.equal(
      zcodeSessionAgentInteractionsResultSchema.parse(coldBefore.result).events.length,
      0,
    );
    await assert.rejects(() => readFile(promptLog), { code: "ENOENT" });
    const wrongScope = await first.request("session/agentInteractions", {
      workspace: { ...workspace, workspaceKey: "other" },
      sessionId,
    });
    assert.equal((wrongScope.error as { code: number }).code, -32602);
    for (const mode of ["desktop-continuous", "web-remote-replayable"]) {
      const subscribed = await first.request("v4/conversation/subscribe", {
        topic: `conversation/${sessionId}`,
        connectionId: mode,
        clientMode: mode,
        base: null,
      });
      assert.ok(subscribed.result);
    }
    await first.request("session/send", { sessionId, content: "INTERACTIONS" });
    let snapshot;
    for (let attempt = 0; attempt < 100; attempt += 1) {
      snapshot = zcodeSessionAgentInteractionsResultSchema.parse(
        (await first.request("session/agentInteractions", { workspace, sessionId })).result,
      );
      if (snapshot.events.filter((event) => event.kind === "message").length === 4) break;
      await sleep(20);
    }
    assert.ok(snapshot);
    assert.equal(snapshot.events.filter((event) => event.kind === "message").length, 4);
    assert.equal(
      snapshot.agents.find((agent) => agent.id === "Alpha/Alpha.Gamma")?.parentAgentId,
      "Alpha",
    );
    assert.ok(!snapshot.agents.some((agent) => agent.id === "Main"));
    assert.deepEqual(
      snapshot.events
        .filter((event) => event.kind === "message")
        .map((event) => [event.fromAgentId, event.toAgentId])
        .sort(),
      [
        ["Alpha", "Beta"],
        ["Alpha", "main"],
        ["Beta", "Alpha/Alpha.Gamma"],
        ["main", "Alpha"],
      ].sort(),
    );
    liveEvents = snapshot.events
      .filter((event) => event.kind === "message")
      .map(({ source: _source, ...event }) => event);
    assert.equal((await readFile(promptLog, "utf8")).trim().split("\n").length, 1);
  } finally {
    await first.close();
  }
  const second = start(env, workspacePath);
  try {
    const restored = zcodeSessionAgentInteractionsResultSchema.parse(
      (await second.request("session/agentInteractions", { workspace, sessionId })).result,
    );
    const restoredEvents = restored.events
      .filter((event) => event.kind === "message")
      .map(({ source: _source, ...event }) => event);
    assert.deepEqual(restoredEvents, liveEvents);
    assert.equal((await readFile(promptLog, "utf8")).trim().split("\n").length, 1);
    assert.equal(restored.coverage.status, "partial");
  } finally {
    await second.close();
  }
});

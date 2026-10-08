// 需求 N01–N05：真实安装核、真实 GLM，公开 v4 入口；不使用 fake 或注入会话事实。
import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { createRequire } from "node:module";
import { appendFile, readFile, readdir, writeFile } from "node:fs/promises";
import { dirname, join, resolve } from "node:path";
import { createInterface } from "node:readline";
import { setTimeout as sleep } from "node:timers/promises";
import { test } from "node:test";
import { fileURLToPath } from "node:url";
import { zcodeWorkspacePresentationSchema } from "@zcode/shared";
import {
  commandAckSchema,
  conversationTopicWireFrameSchema,
} from "@zcode/shared/zcode-protocol-v4";
import {
  nativeCommandNames,
  nativeCredentialEnv,
  nativeFixtureEnv,
  prepareNativeFixture,
} from "./fixtures/nativeCommandFixture.mjs";

type RecordValue = Record<string, any>;
const root = resolve(dirname(fileURLToPath(import.meta.url)), "../../..");
const adapter = join(root, "packages/omp-agent/src/adapters/cliMain.ts");
const tsx = join(
  dirname(createRequire(import.meta.url).resolve("tsx/package.json")),
  "dist/cli.mjs",
);
const optedIn = process.env.OMP_NATIVE_E2E === "1";
const testOptions = {
  skip: optedIn
    ? false
    : "Set OMP_NATIVE_E2E=1: creates isolated sessions and calls existing GLM credentials",
  timeout: 1_200_000,
};

class NativeHarness {
  readonly frames: RecordValue[] = [];
  readonly subscriptions = new Map<string, string>();
  private next = 0;
  private stderr = "";
  private captures = Promise.resolve();
  constructor(
    readonly child: ReturnType<typeof spawn>,
    private capturePath?: string,
  ) {
    createInterface({ input: child.stdout! }).on("line", (line) => {
      try {
        const frame = JSON.parse(line);
        this.frames.push(frame);
        if (this.capturePath && frame.method === "v4/conversation/frame") {
          const wire = frame.params.frame;
          const sourceRows =
            wire?.payload?.kind === "snapshot"
              ? (wire.payload.snapshot.rows?.window ?? [])
              : (wire?.payload?.deltas ?? [])
                  .filter((delta: RecordValue) => delta.row)
                  .map((delta: RecordValue) => delta.row);
          const summary = {
            timestamp: new Date().toISOString(),
            subscription: frame.params.subscriptionId,
            rows: sourceRows
              .filter((row: RecordValue) => row.kind === "assistantText")
              .map((row: RecordValue) => ({ rowId: row.rowId, text: row.text })),
            deltas: wire?.payload?.deltas?.filter((delta: RecordValue) => delta.op === "row.delta"),
          };
          this.captures = this.captures.then(() =>
            appendFile(this.capturePath!, `${JSON.stringify(summary)}\n`),
          );
        }
      } catch {
        /* Nonprotocol stdout is ignored. */
      }
    });
    child.stderr!.on("data", (chunk) => {
      this.stderr = `${this.stderr}${chunk}`.slice(-4000);
    });
  }
  async wait<T>(condition: () => T | undefined | false, timeout = 180_000): Promise<T> {
    const deadline = Date.now() + timeout;
    while (Date.now() < deadline) {
      const value = condition();
      if (value !== undefined && value !== false) return value;
      if (this.child.exitCode !== null) throw new Error(`Adapter exited: ${this.child.exitCode}`);
      await sleep(40);
    }
    // 不输出 stderr：底层诊断可能包含用户认证提供者信息；验收失败保留明确阶段。
    const summaries = [...this.subscriptions]
      .filter(([key]) => key.endsWith(":desktop-continuous"))
      .map(([key]) => {
        const session = key.slice(0, -":desktop-continuous".length);
        const state = this.view(session).state;
        return {
          session,
          phase: state.control?.phase,
          error: state.control?.lastError,
          pending: state.pendingInteractions?.map((item: RecordValue) => ({
            prompt: item.payload?.prompt,
            options: item.payload?.options,
          })),
        };
      });
    throw new Error(
      `Native observation timed out after ${timeout} ms: ${JSON.stringify(summaries)}`,
    );
  }
  async request(method: string, params: unknown): Promise<RecordValue> {
    const id = ++this.next;
    this.child.stdin!.write(`${JSON.stringify({ id, method, params })}\n`);
    const commandType =
      method === "v4/command" && typeof params === "object" && params !== null
        ? (params as RecordValue).type
        : undefined;
    const operation = commandType ? `${method}(${commandType})` : method;
    const response = await this.wait(() =>
      this.frames.find((frame) => frame.id === id && ("result" in frame || "error" in frame)),
    ).catch((error) => {
      throw new Error(`${operation} request ${id} did not settle: ${String(error)}`);
    });
    assert.ok(!response.error, `${operation} failed: ${JSON.stringify(response.error)}`);
    return response.result;
  }
  async command(
    sessionId: string | null,
    type: string,
    payload: unknown,
    commandId = `native-${++this.next}`,
  ) {
    return commandAckSchema.parse(
      await this.request("v4/command", {
        commandId,
        clientId: "native-e2e",
        sessionId,
        type,
        payload,
        issuedAt: Date.now(),
      }),
    );
  }
  async subscribe(
    sessionId: string,
    mode: "desktop-continuous" | "web-remote-replayable",
    base?: unknown,
  ) {
    const response = await this.request("v4/conversation/subscribe", {
      topic: `conversation/${sessionId}`,
      connectionId: `${mode}-${++this.next}`,
      clientMode: mode,
      ...(base ? { base } : {}),
    });
    this.subscriptions.set(`${sessionId}:${mode}`, response.ack.subscriptionId);
    await this.wait(() => this.wires(response.ack.subscriptionId).length > 0);
    return response.ack;
  }
  wires(subscription: string) {
    return this.frames
      .filter(
        (frame) =>
          frame.method === "v4/conversation/frame" && frame.params.subscriptionId === subscription,
      )
      .map((frame) => {
        conversationTopicWireFrameSchema.parse(frame.params);
        return frame.params.frame;
      });
  }
  view(session: string, mode = "desktop-continuous") {
    const subscription = this.subscriptions.get(`${session}:${mode}`);
    assert.ok(subscription, "Subscribe before reading a projection");
    let state: RecordValue = {};
    const rows = new Map<number, RecordValue>();
    for (const wire of this.wires(subscription)) {
      if (wire.payload.kind === "snapshot") {
        state = wire.payload.snapshot;
        rows.clear();
        for (const row of state.rows?.window ?? []) rows.set(row.rowId, { ...row });
      } else {
        for (const delta of wire.payload.deltas) {
          if (delta.op === "state.updated") state = { ...state, ...delta.patch };
          if (delta.op === "row.appended" || delta.op === "row.upserted")
            rows.set(delta.row.rowId, { ...delta.row });
          if (delta.op === "row.delta") {
            const row = rows.get(delta.rowId);
            if (row) row[delta.path] = String(row[delta.path] ?? "") + delta.append;
          }
        }
      }
    }
    return { state, rows: [...rows.values()] };
  }
  text(session: string, after = 0, mode = "desktop-continuous") {
    return this.view(session, mode)
      .rows.filter((row) => row.rowId > after && row.kind === "assistantText")
      .map((row) => row.text)
      .join("\n");
  }
  cursor(session: string) {
    return Math.max(0, ...this.view(session).rows.map((row) => row.rowId));
  }
  async output(session: string, after: number, expected: RegExp, timeout = 180_000) {
    return this.wait(
      () => (expected.test(this.text(session, after)) ? this.text(session, after) : undefined),
      timeout,
    ).catch((error) => {
      throw new Error(
        `Native output missing: ${expected}; observed ${this.text(session, after).slice(-600)}; ${String(error)}`,
      );
    });
  }
  async compactTerminal(session: string, after: number) {
    // 原生命令以 command_output 报告前提拒绝/错误；ACK与completedSuccess不能冒充压缩成功。
    return this.wait(() => {
      const text = this.text(session, after);
      const failed = text.match(/^Compaction failed:[^\n]*/mu);
      if (failed) throw new Error(`Native compaction terminal failure: ${failed[0]}`);
      return /Compaction complete\./iu.test(text) ? text : undefined;
    }, 240_000);
  }
  async idle(session: string) {
    await this.wait(() => {
      const view = this.view(session);
      return ["completedSuccess", "completedInterrupted", "error", "draft"].includes(
        view.state.control?.phase,
      ) && !view.state.pendingInteractions?.length
        ? true
        : undefined;
    });
  }
  async send(session: string, text: string, expected: RegExp) {
    const after = this.cursor(session);
    const ack = await this.command(session, "sendText", { text });
    assert.equal(ack.status, "accepted", `${text}: ${JSON.stringify(ack)}`);
    await this.output(session, after, expected);
    await this.idle(session);
    return after;
  }
  async question(session: string) {
    return this.wait(
      () =>
        this.view(session).state.pendingInteractions?.find(
          (item: RecordValue) => item.kind === "userInput",
        ) as RecordValue | undefined,
    );
  }
  async answer(session: string, item: RecordValue, answer: unknown) {
    const ack = await this.command(session, "resolveInteraction", {
      interactionId: item.interactionId,
      answer,
    });
    assert.equal(ack.status, "accepted");
    await this.wait(
      () =>
        !(this.view(session).state.pendingInteractions ?? []).some(
          (entry: RecordValue) => entry.interactionId === item.interactionId,
        ),
    );
  }
  async dialog(
    session: string,
    text: string,
    steps: Array<string | RegExp | boolean | null>,
    expected?: RegExp,
  ) {
    const after = this.cursor(session);
    // OMP 的 goal drop / 草稿退出会同步等待确认，ACK 可能晚于交互；必须先发起请求，
    // 经真实 v4 应答全部问题后再等待 ACK，不能让测试宿主与核心互相等待。
    const submission = this.command(session, "sendText", { text }).then(
      (ack) => ({ ack }),
      (error) => ({ error }),
    );
    for (const value of steps) {
      const question = await this.question(session);
      if (value === null) await this.answer(session, question, { action: "cancel" });
      else if (typeof value === "boolean")
        await this.answer(session, question, { action: value ? "accept" : "decline" });
      else {
        const option = question.payload.options?.find((item: RecordValue) =>
          value instanceof RegExp
            ? value.test(item.label)
            : item.label === value || item.optionId === value,
        );
        assert.ok(!(value instanceof RegExp) || option, `Missing native option ${value}`);
        await this.answer(session, question, {
          action: "accept",
          content: option ? { optionId: option.optionId } : { answer: value },
        });
      }
    }
    const outcome = await submission;
    if ("error" in outcome) throw outcome.error;
    assert.equal(outcome.ack.status, "accepted");
    if (expected) await this.output(session, after, expected);
    await this.idle(session);
    return after;
  }
  async close() {
    if (this.child.exitCode !== null) return;
    const closed = new Promise((resolveClose) => this.child.once("exit", resolveClose));
    this.child.stdin!.end();
    const deadline = setTimeout(() => this.child.kill(), 5000);
    await closed;
    clearTimeout(deadline);
    await this.captures;
  }
  async history(session: string) {
    const page = await this.request("v4/conversation/rowsRange", {
      sessionId: session,
      limit: 10000,
    });
    assert.equal(page.hasMore, false, "Fixture history must fit a single explicit history page");
    return page.rows
      .filter((row: RecordValue) => row.kind === "assistantText")
      .map((row: RecordValue) => row.text)
      .join("\n");
  }
}

async function start(
  fixture: Awaited<ReturnType<typeof prepareNativeFixture>>,
  credentials: Record<string, string>,
) {
  const env = nativeFixtureEnv(fixture, credentials);
  const capture = process.env.OMP_NATIVE_E2E_CAPTURE_FRAMES === "1";
  const captureTag = String(Date.now());
  if (capture) {
    env.OMP_NATIVE_E2E_REAL_BINARY = env.OMP_RPC_BINARY_PATH;
    env.OMP_NATIVE_E2E_NATIVE_FRAME_PATH = join(
      fixture.evidence,
      `native-wire-${captureTag}.jsonl`,
    );
    env.OMP_RPC_BINARY_PATH = process.execPath;
    env.OMP_RPC_ARGS_JSON = JSON.stringify([
      join(root, "packages/omp-agent/test/fixtures/nativeWireTap.mjs"),
      ...JSON.parse(env.OMP_RPC_ARGS_JSON),
    ]);
  }
  const harness = new NativeHarness(
    spawn(process.execPath, [tsx, adapter, "app-server", "--stdio"], {
      cwd: fixture.workspace,
      env,
      stdio: ["pipe", "pipe", "pipe"],
      windowsHide: true,
    }),
    capture ? join(fixture.evidence, `zcode-wire-${captureTag}.jsonl`) : undefined,
  );
  await harness.wait(() =>
    harness.frames.find(
      (frame) => frame.method === "startup/storageState" && frame.params.phase === "ready",
    ),
  );
  return harness;
}
async function create(
  harness: NativeHarness,
  fixture: Awaited<ReturnType<typeof prepareNativeFixture>>,
) {
  const ack = await harness.command(null, "createSession", {
    workspaceId: fixture.workspace,
    firstInput: { text: "/goal show" },
  });
  assert.equal(ack.status, "accepted");
  const sessionId = (ack.result as { sessionId: string }).sessionId;
  await harness.subscribe(sessionId, "desktop-continuous");
  await harness.subscribe(sessionId, "web-remote-replayable");
  await harness.output(sessionId, 0, /No goal set/i);
  return sessionId;
}

async function compactionEntries(configRoot: string): Promise<RecordValue[]> {
  const files = await readdir(join(configRoot, "agent", "sessions"), { recursive: true }).catch(
    () => [],
  );
  const records: RecordValue[] = [];
  for (const file of files.filter((file) => file.endsWith(".jsonl"))) {
    const text = await readFile(join(configRoot, "agent", "sessions", file), "utf8");
    for (const line of text.split("\n")) {
      if (!line.trim()) continue;
      const entry = JSON.parse(line);
      if (entry.type === "compaction") records.push(entry);
    }
  }
  return records;
}

async function teamJournalDiagnostics(configRoot: string) {
  const sessionsRoot = join(configRoot, "agent", "sessions");
  const files = await readdir(sessionsRoot, { recursive: true }).catch(() => []);
  const stages: RecordValue[] = [];
  for (const file of files.filter((file) => /team-[^\\/]*\.jsonl$/u.test(file))) {
    const entries = (await readFile(join(sessionsRoot, file), "utf8"))
      .split("\n")
      .filter(Boolean)
      .map((line) => JSON.parse(line));
    const messages = entries.filter((entry) => entry.type === "message");
    stages.push({
      file,
      start: entries.find((entry) => entry.type === "session")?.timestamp,
      thinking: entries.find((entry) => entry.type === "thinking_level_change")?.thinkingLevel,
      lastMessageAt: messages.at(-1)?.timestamp,
      errors: messages.map((entry) => entry.message?.errorMessage).filter(Boolean),
      modelOutputTokens: messages.reduce(
        (count, entry) => count + (entry.message?.usage?.output ?? 0),
        0,
      ),
      tools: messages.flatMap((entry) =>
        Array.isArray(entry.message?.content)
          ? entry.message.content
              .filter((part: RecordValue) => part.type === "toolCall")
              .map((part: RecordValue) => part.name)
          : [],
      ),
    });
  }
  return stages;
}

async function savedTeamLiveReport(fixture: Awaited<ReturnType<typeof prepareNativeFixture>>) {
  const path = join(fixture.evidence, "team-live.json");
  const saved = await readFile(path, "utf8")
    .then(JSON.parse)
    .catch(() => null);
  if (saved) return saved;
  // 兼容已有真实 run：此前 cold 差异断言捕获了完整 live 报告，但尚未保存独立 artifact。
  // 只解码该断言的原始字面量作期望值，不向应用写入或拼造任何模型/会话事实。
  const failure = JSON.parse(await readFile(join(fixture.evidence, "team-failure.json"), "utf8"));
  assert.match(failure.message, /Team final report changed across .* cold recovery/u);
  const literals = String(failure.message)
    .split("\n")
    .filter((line) => line.startsWith("- "))
    .map((line) => line.replace(/^-\s*/u, "").match(/^'((?:[^'\\]|\\.)*)'(?:\s*\+)?$/u)?.[1])
    .filter((value): value is string => value !== undefined);
  const captured = literals
    .map((raw) => JSON.parse(`"${raw.replace(/\\'/gu, "'").replace(/(?<!\\)"/gu, '\\"')}"`))
    .join("");
  const index = captured.indexOf("## /team 多模型讨论结果（team-result）");
  assert.ok(
    index >= 0 && captured.includes("选择方案请直接回复"),
    "The existing failure must contain the complete observed live final report",
  );
  const recovered = {
    finalReport: captured.slice(index),
    stages: failure.stages,
    source: "observed-live-assertion-diff",
    liveResult: "passed",
  };
  await writeFile(path, JSON.stringify(recovered, null, 2));
  return recovered;
}

test(
  "N04 compact small-session refusal is visible without a model call or journal compaction",
  testOptions,
  async () => {
    const fixture = await prepareNativeFixture();
    const harness = await start(fixture, await nativeCredentialEnv());
    try {
      const session = await create(harness, fixture);
      const before = await compactionEntries(fixture.configRoot);
      const tokens = harness.view(session).state.usage.cumulative;
      await harness.send(
        session,
        "/compact soft",
        /^Compaction failed: Nothing to compact \(session too small\)/m,
      );
      assert.deepEqual(harness.view(session).state.usage.cumulative, tokens);
      assert.deepEqual(await compactionEntries(fixture.configRoot), before);
      await writeFile(
        join(fixture.evidence, "compact-small-session-result.json"),
        JSON.stringify(
          {
            session,
            result: "passed",
            scope:
              "native empty-session refusal; successful compaction remains separately required",
          },
          null,
          2,
        ),
      );
      console.log(`Native compact refusal evidence: ${fixture.evidence}`);
    } finally {
      await harness.close();
    }
  },
);

test(
  "N04 team independently reaches the real structured final report, failure surface and cold delivery",
  testOptions,
  async () => {
    const phase = process.env.OMP_NATIVE_TEAM_PHASE ?? "live";
    assert.ok(["live", "cold"].includes(phase));
    const existingRoot = phase === "cold" ? process.env.OMP_NATIVE_TEAM_ROOT : undefined;
    assert.ok(
      phase !== "cold" || existingRoot,
      "Cold-only team verification requires OMP_NATIVE_TEAM_ROOT",
    );
    const fixture = await prepareNativeFixture(existingRoot);
    const credentials = await nativeCredentialEnv();
    let harness = await start(fixture, credentials);
    let session = "";
    const started = Date.now();
    const original = await readFile(join(fixture.workspace, "sample.ts"), "utf8");
    try {
      if (phase === "cold") {
        const saved = await savedTeamLiveReport(fixture);
        const listing = await harness.request("session/list", {});
        const parent = listing.sessions.filter(
          (entry: RecordValue) => entry.title === "NATIVE_TEAM_COMMAND_ACCEPTANCE",
        );
        assert.equal(
          parent.length,
          1,
          "Cold-only verification must target the actual stable parent catalog entry",
        );
        session = parent[0].sessionId;
        for (const mode of ["desktop-continuous", "web-remote-replayable"] as const) {
          await harness.subscribe(session, mode);
          const actual = await harness.history(session);
          assert.equal(
            actual.split(saved.finalReport).length - 1,
            1,
            `The observed team final report must recover exactly once (${mode})`,
          );
          if (saved.expectedHistory)
            assert.equal(
              actual,
              saved.expectedHistory,
              `Team history changed across ${mode} cold recovery`,
            );
        }
        await writeFile(
          join(fixture.evidence, "team-cold-result.json"),
          JSON.stringify(
            {
              session,
              source: saved.source ?? "live-artifact",
              checkedModes: ["desktop-continuous", "web-remote-replayable"],
              result: "passed",
            },
            null,
            2,
          ),
        );
        console.log(`Native team cold-only evidence: ${fixture.evidence}`);
        return;
      }
      session = await create(harness, fixture);
      await harness.send(
        session,
        "/rename NATIVE_TEAM_COMMAND_ACCEPTANCE",
        /NATIVE_TEAM_COMMAND_ACCEPTANCE/,
      );
      const after = harness.cursor(session);
      // 提示词不得约束"结构化字段最多一句话/正文最多80字"：该限制会让子代理省略 yield schema
      // 必填字段（如 factDifferences[].topic）而被原生流程判失败（team-incomplete）。与 GUI 验收
      // 已通过的提问一致，要求提交完整结构化结果、无差异时使用空数组（见 2026-10-08 验收报告）。
      const question =
        "/team 只读验收范围已明确：阅读sample.ts和README.md，确认当前导出函数nativeAnswer返回42。唯一方案是保持现有函数名及返回值，不设计新命名、不修改文件。仍按原生团队流程完成独立调查、对齐、审查和汇总，证据引用实际文件；各阶段必须通过原生 yield 提交该阶段 schema 要求的完整结构化结果，不省略必填字段，没有事实差异或需求理解差异时使用空数组、不编造差异，若有真实差异则完整填写各项必填字段；技能固定回复规则仅适用于显式skill调用，与本讨论无关。";
      assert.equal(
        (await harness.command(session, "sendText", { text: question })).status,
        "accepted",
      );
      const report = await harness.wait(() => {
        const text = harness.text(session, after);
        if (/team-incomplete|本次流程未完成|无法启动 \/team|后台任务不可用/u.test(text))
          throw new Error(`Native team failed: ${text.slice(-1800)}`);
        return /team-result/u.test(text) && /选择方案请直接回复/u.test(text) ? text : undefined;
      }, 180_000);
      assert.match(report, /方案 A\s*\|\s*✅ 可作为选项/u);
      assert.match(report, /nativeAnswer|sample\.ts/u);
      assert.equal(
        await readFile(join(fixture.workspace, "sample.ts"), "utf8"),
        original,
        "Team must remain read-only",
      );
      const stages = await teamJournalDiagnostics(fixture.configRoot);
      for (const stage of stages) {
        assert.equal(
          stage.thinking,
          "low",
          "Team child thinking must reflect the explicit isolated model metadata",
        );
        assert.ok(
          stage.modelOutputTokens > 0 && stage.tools.includes("yield"),
          `Team stage did not produce its real structured result: ${stage.file}`,
        );
        assert.deepEqual(stage.errors, []);
        assert.ok(
          stage.tools.every((tool: string) =>
            ["read", "grep", "glob", "wiki", "ast_grep", "yield"].includes(tool),
          ),
          "Team escaped the native read-only tool contract",
        );
      }
      for (const label of ["proposal-A", "alignment", "review-A", "synthesis"])
        assert.ok(
          stages.some((stage) => stage.file.includes(label)),
          `Missing real team stage ${label}`,
        );
      const live = await harness.history(session);
      const finalReport = report.slice(report.indexOf("## /team 多模型讨论结果（team-result）"));
      await writeFile(
        join(fixture.evidence, "team-live.json"),
        JSON.stringify(
          {
            session,
            finalReport,
            expectedHistory: live,
            elapsedMs: Date.now() - started,
            stages,
            source: "real-v4-live-result",
            liveResult: "passed",
          },
          null,
          2,
        ),
      );
      await harness.close();
      harness = await start(fixture, credentials);
      const listing = await harness.request("session/list", {});
      const parent = listing.sessions.filter(
        (entry: RecordValue) => entry.title === "NATIVE_TEAM_COMMAND_ACCEPTANCE",
      );
      assert.equal(parent.length, 1);
      session = parent[0].sessionId;
      for (const mode of ["desktop-continuous", "web-remote-replayable"] as const) {
        await harness.subscribe(session, mode);
        assert.equal(
          await harness.history(session),
          live,
          `Team final report changed across ${mode} cold recovery`,
        );
      }
      await writeFile(
        join(fixture.evidence, "team-result.json"),
        JSON.stringify(
          { session, elapsedMs: Date.now() - started, stages, result: "passed" },
          null,
          2,
        ),
      );
      console.log(`Native independent team acceptance evidence: ${fixture.evidence}`);
    } catch (error) {
      await writeFile(
        join(fixture.evidence, phase === "cold" ? "team-cold-failure.json" : "team-failure.json"),
        JSON.stringify(
          {
            message: String(error),
            elapsedMs: Date.now() - started,
            stages: await teamJournalDiagnostics(fixture.configRoot),
          },
          null,
          2,
        ),
      );
      console.log(`Native independent team failure evidence: ${fixture.evidence}`);
      throw error;
    } finally {
      await harness.close();
    }
  },
);

test(
  "N01/N03/N05 native catalog, local lifecycle, index dialogs, cancellation, cold history and both delivery modes",
  testOptions,
  async () => {
    const fixture = await prepareNativeFixture();
    const credentials = await nativeCredentialEnv();
    let harness = await start(fixture, credentials);
    const evidence: RecordValue[] = [];
    try {
      const workspace = {
        workspacePath: fixture.workspace,
        workspaceIdentity: fixture.workspace,
        workspaceKey: fixture.workspace,
      };
      const presentation = zcodeWorkspacePresentationSchema.parse(
        await harness.request("workspace/readPresentation", { workspace }),
      );
      const skillCatalog = await harness.request("skills/referenceCatalog", { workspace });
      for (const name of nativeCommandNames) {
        assert.ok(
          name.startsWith("skill:")
            ? skillCatalog.skills.some((skill: RecordValue) => `skill:${skill.name}` === name)
            : presentation.slashCommands.some((command) => command.name === name),
          `Missing native command ${name}`,
        );
        const text = `/${name}`;
        const completion = await harness.request("workspace/completeOmpCommand", {
          workspace,
          text,
          cursor: text.length,
        });
        assert.ok(
          completion.items.some(
            (item: RecordValue) => item.label === name && item.insertText === `${text} `,
          ),
          `No native completion for ${name}`,
        );
      }
      const session = await create(harness, fixture);
      const original = await readFile(join(fixture.workspace, "README.md"), "utf8");
      await harness.send(session, "/team", /用法.*\/team/u);
      for (const [text, expected] of [
        ["/advisor status", /advisor.*disabled/i],
        ["/advisor dump", /Advisor is not active|no advisor|no history/i],
        ["/advisor dump raw", /Advisor is not active|no advisor|no history/i],
        ["/advisor on", /advisor.*enabled/i],
        ["/advisor off", /advisor.*disabled/i],
        ["/advisor configure", /only available.*interactive TUI/i],
        ["/loop 2", /loop.*enabled/i],
        ["/loop", /loop.*disabled/i],
      ] as const)
        await harness.send(session, text, expected);
      await harness.send(session, "/plan", /plan mode enabled/i);
      await harness.wait(() => harness.view(session).state.config?.thought === "high");
      await harness.send(session, "/plan", /plan mode paused/i);
      await harness.wait(() => harness.view(session).state.config?.thought === "low");
      await harness.send(session, "/plan", /plan mode disabled/i);
      for (const [text, code, message] of [
        ["/not-a-native-e2e-command", "omp_command_unknown", /未知命令/u],
        ["/git", "omp_command_tui_only", /需要终端运行时/u],
        ["/loop 0", "omp_prompt_failed", /positive integer/i],
        ["/goal budget invalid", "omp_prompt_failed", /No active goal/i],
      ] as const) {
        const before = harness.cursor(session);
        const usage = harness.view(session).state.usage.cumulative;
        const ack = await harness.command(session, "sendText", { text });
        if (ack.status === "accepted") {
          await harness.wait(() =>
            harness
              .view(session)
              .rows.some(
                (row) => row.rowId > before && row.kind === "turnHeader" && row.state === "failed",
              ),
          );
          assert.equal(harness.view(session).state.control.lastError.code, code);
          assert.match(harness.view(session).state.control.lastError.message, message);
        } else assert.equal(ack.status, "rejected");
        assert.deepEqual(
          harness.view(session).state.usage.cumulative,
          usage,
          "Rejected native input must not consume model tokens",
        );
        assert.equal(
          harness
            .view(session)
            .rows.filter(
              (row) =>
                row.rowId > before && ["toolCall", "reasoning", "assistantText"].includes(row.kind),
            ).length,
          0,
        );
      }
      await harness.dialog(session, "/wiki", [null]);
      await harness.dialog(
        session,
        "/wiki",
        ["New document index", fixture.workspace, "native-manual"],
        /Created document index native-manual/i,
      );
      await harness.dialog(
        session,
        "/wiki",
        ["New document index", fixture.workspace, "native-manual"],
        /already exists/i,
      );
      await harness.dialog(
        session,
        "/wiki",
        ["Search document indexes", "NATIVE_WIKI_NEEDLE", /\[native-manual\] README\.md/u],
        /NATIVE_WIKI_NEEDLE/,
      );
      await harness.dialog(session, "/wiki", ["Delete document index", "1. native-manual", false]);
      await harness.dialog(
        session,
        "/wiki",
        ["Delete document index", "1. native-manual", true],
        /Deleted|Removed/i,
      );
      await harness.dialog(session, "/repo", ["Build repository index", false]);
      await harness.dialog(
        session,
        "/repo",
        ["Build repository index", true],
        /Build repository index complete/i,
      );
      await writeFile(
        join(fixture.workspace, "sample.ts"),
        "export function nativeUpdatedAnswer() { return 43; }\n",
      );
      await harness.dialog(
        session,
        "/repo",
        ["Update repository index"],
        /Update repository index complete/i,
      );
      await harness.dialog(
        session,
        "/repo",
        ["Rebuild repository index", true],
        /Rebuild repository index complete/i,
      );
      await harness.dialog(
        session,
        "/repo",
        ["Delete repository index", true],
        /Deleted|Removed|Delete repository index complete/i,
      );
      assert.equal(await readFile(join(fixture.workspace, "README.md"), "utf8"), original);
      assert.match(
        await readFile(join(fixture.workspace, "sample.ts"), "utf8"),
        /nativeUpdatedAnswer/,
      );
      // 真实等待对话时，停止必须独立受理；旧回答不得进入另一会话。
      assert.equal(
        (await harness.command(session, "sendText", { text: "/wiki" })).status,
        "accepted",
      );
      const pending = await harness.question(session);
      const other = await create(harness, fixture);
      const stoppedAt = Date.now();
      assert.equal((await harness.command(session, "stop", {})).status, "accepted");
      assert.ok(Date.now() - stoppedAt < 15_000, "Stop was blocked by native dialog");
      await harness.wait(() => !harness.view(session).state.pendingInteractions?.length);
      const late = await harness.command(session, "resolveInteraction", {
        interactionId: pending.interactionId,
        answer: { action: "accept", content: { optionId: "New document index" } },
      });
      assert.ok(
        late.status === "noop" || late.status === "rejected",
        "Stale answers must not be accepted",
      );
      assert.doesNotMatch(harness.text(other), /Created document index|native-manual/);
      // 以快照重连两条链路；不重发副作用，实际输出必须相等。
      const visible = await harness.history(session);
      for (const mode of ["desktop-continuous", "web-remote-replayable"] as const) {
        await harness.subscribe(session, mode);
        assert.ok(
          visible.endsWith(harness.text(session, 0, mode)),
          "Snapshot must expose the same retained history tail",
        );
        assert.equal(await harness.history(session), visible);
      }
      evidence.push({
        scope: "live/local",
        commands: nativeCommandNames,
        session,
        result: "passed",
      });
      await harness.close();
      harness = await start(fixture, credentials);
      for (const mode of ["desktop-continuous", "web-remote-replayable"] as const) {
        await harness.subscribe(session, mode);
        assert.equal(
          await harness.history(session),
          visible,
          `Native command history changed after cold resume (${mode})`,
        );
        assert.ok(
          visible.endsWith(harness.text(session, 0, mode)),
          "Cold snapshot must expose the retained history tail",
        );
      }
      evidence.push({ scope: "cold/both-delivery-modes", result: "passed" });
      await writeFile(
        join(fixture.evidence, "local-result.json"),
        JSON.stringify(evidence, null, 2),
      );
      console.log(`Native local acceptance evidence: ${fixture.evidence}`);
    } finally {
      await harness.close();
    }
  },
);

test(
  "N02/N04 real GLM magic commands, skill arguments, finite loop, goal lifecycle, compact and plan approval",
  testOptions,
  async () => {
    const existingRoot = process.env.OMP_NATIVE_E2E_ROOT;
    const fixture = await prepareNativeFixture(existingRoot);
    const selected = new Set(
      (process.env.OMP_NATIVE_E2E_SCENARIOS ?? "magic,loop,goal,compact,plan").split(","),
    );
    assert.ok(
      [...selected].every((name) =>
        ["magic", "loop", "goal", "compact", "postcompact", "plan"].includes(name),
      ),
      "Unknown native model scenario",
    );
    const credentials = await nativeCredentialEnv();
    let harness = await start(fixture, credentials);
    const passed: string[] = [];
    let currentPhase = "startup";
    let activeSession: string | null = null;
    const previousProgress = existingRoot
      ? await readFile(join(fixture.evidence, "model-progress.json"), "utf8")
          .then(JSON.parse)
          .catch(() => null)
      : null;
    const priorRunPassed = [
      ...new Set([
        ...(previousProgress?.priorRunPassed ?? []),
        ...(previousProgress?.passed ?? []),
      ]),
    ].filter((value) => typeof value === "string");
    const priorSmallSessionRejection = String(previousProgress?.message ?? "").match(
      /Compaction failed: Nothing to compact \(session too small\)/u,
    )?.[0];
    if (priorSmallSessionRejection) {
      await writeFile(
        join(fixture.evidence, "compact-small-session-result.json"),
        JSON.stringify(
          {
            source: "previous-model-progress-real-output",
            observedOutput: priorSmallSessionRejection,
            observedAt: previousProgress.updatedAt,
            result: "passed",
            scope: "native small-session refusal remains visible; success is separately required",
          },
          null,
          2,
        ),
      );
    }
    const progress = async (phase = currentPhase, result = "running", error?: unknown) => {
      currentPhase = phase;
      await writeFile(
        join(fixture.evidence, "model-progress.json"),
        JSON.stringify(
          {
            session: activeSession,
            selected: [...selected],
            passed,
            priorRunPassed,
            currentPhase,
            result,
            ...(error ? { message: String(error) } : {}),
            updatedAt: new Date().toISOString(),
          },
          null,
          2,
        ),
      );
    };
    try {
      let session: string;
      if (existingRoot) {
        const listing = await harness.request("session/list", {});
        const parent = listing.sessions.filter(
          (entry: RecordValue) => entry.title === "NATIVE_MODEL_COMMAND_ACCEPTANCE",
        );
        assert.equal(
          parent.length,
          1,
          "Resume must target the unique existing native model acceptance parent",
        );
        session = parent[0].sessionId;
        await harness.subscribe(session, "desktop-continuous");
        await harness.subscribe(session, "web-remote-replayable");
      } else {
        session = await create(harness, fixture);
        await harness.send(
          session,
          "/rename NATIVE_MODEL_COMMAND_ACCEPTANCE",
          /NATIVE_MODEL_COMMAND_ACCEPTANCE/,
        );
      }
      activeSession = session;
      await progress("ready");
      if (selected.has("magic")) {
        await progress("magic");
        for (const name of ["ultrathink", "orchestrate", "workflowz", "fullsend"]) {
          const marker = `NATIVE_${name.toUpperCase()}_RESULT`;
          const beforeTokens = harness.view(session).state.usage.cumulative.outputTokens;
          await harness.send(
            session,
            `/${name} 这是隔离只读验收。任务已经给出，无需调查、规划、调用工具或子代理。只回复 ${marker}。`,
            new RegExp(`^${marker}[.!。]?\\s*$`, "m"),
          );
          assert.ok(
            harness.view(session).state.usage.cumulative.outputTokens > beforeTokens,
            `${name} must produce a real model result, not a command echo`,
          );
          passed.push(name);
        }
        await harness.send(
          session,
          "ultrathink 这是隔离只读验收，不调用工具。只回复 NATIVE_BODY_ULTRATHINK_RESULT。",
          /^NATIVE_BODY_ULTRATHINK_RESULT[.!。]?\s*$/m,
        );
        const skillStart = await harness.send(
          session,
          "/skill:native-command-fixture  NATIVE_ARGUMENT_WITH_SPACES",
          /NATIVE_SKILL_RESULT[\s\S]*NATIVE_ARGUMENT_WITH_SPACES/,
        );
        assert.ok(
          harness
            .view(session)
            .rows.some(
              (row) =>
                row.rowId > skillStart &&
                row.kind === "userInput" &&
                row.text === "/skill:native-command-fixture  NATIVE_ARGUMENT_WITH_SPACES",
            ),
          "Native skill input whitespace and arguments must remain intact",
        );
        passed.push("body-ultrathink", "skill:*");
        await progress();
      }
      if (selected.has("loop")) {
        await progress("loop");
        const loopStart = harness.cursor(session);
        assert.equal(
          (
            await harness.command(session, "sendText", {
              text: "/loop 1 不调用工具，只回复 NATIVE_LOOP_RESULT。",
            })
          ).status,
          "accepted",
        );
        await harness.wait(
          () =>
            harness
              .view(session)
              .rows.filter(
                (row) =>
                  row.rowId > loopStart &&
                  row.kind === "assistantText" &&
                  /NATIVE_LOOP_RESULT/.test(row.text),
              ).length >= 2,
          240_000,
        );
        await harness.output(session, loopStart, /loop limit reached/i);
        await harness.idle(session);
        passed.push("loop");
        await progress();
      }
      if (selected.has("goal")) {
        await progress("goal/read-existing-state");
        const beforeGoal = harness.cursor(session);
        assert.equal(
          (await harness.command(session, "sendText", { text: "/goal show" })).status,
          "accepted",
        );
        const existingGoal = await harness.output(session, beforeGoal, /No goal set|Objective:/i);
        await harness.idle(session);
        if (/Objective:/u.test(existingGoal)) {
          // 重跑只清理该已验证隔离会话的旧测试目标，避免 set 的替换确认再次挡住宿主。
          await progress("goal/drop-existing-sandbox-goal");
          await harness.dialog(session, "/goal drop", [true], /Goal dropped/i);
        }
        await progress("goal/create");
        await harness.send(
          session,
          "/goal set 为后续验收保留这个目标，不调用 goal 工具，不完成或暂停目标，不调用其他工具；本轮只回复 NATIVE_GOAL_CREATED。",
          /NATIVE_GOAL_CREATED/,
        );
        await progress("goal/budget");
        await harness.send(session, "/goal budget 50000", /Goal budget set to 50000/i);
        await progress("goal/show-budget");
        await harness.send(session, "/goal show", /Objective:[\s\S]*50000/);
        await progress("goal/pause");
        await harness.send(session, "/goal pause", /Goal mode paused/i);
        await progress("goal/resume");
        await harness.send(session, "/goal resume", /Goal mode resumed/i);
        await progress("goal/drop-denied");
        await harness.dialog(session, "/goal drop", [false]);
        await progress("goal/show-after-denial");
        await harness.send(session, "/goal show", /Objective:/);
        await progress("goal/drop-accepted");
        await harness.dialog(session, "/goal drop", [true], /Goal dropped/i);
        await progress("goal/empty-after-drop");
        await harness.send(session, "/goal show", /No goal set/i);
        passed.push("goal");
        await progress();
      }
      if (selected.has("compact")) {
        await progress("compact/submit");
        const compactStart = harness.cursor(session);
        const beforeCompactions = await compactionEntries(fixture.configRoot);
        assert.equal(
          (
            await harness.command(session, "sendText", {
              text: "/compact soft Preserve NATIVE_SKILL_RESULT and NATIVE_GOAL_CREATED exactly in the summary. Append the exact sentinel NATIVE_COMPACT_PARAMETER.",
            })
          ).status,
          "accepted",
        );
        await progress("compact/wait-native-terminal");
        const nativeTerminal = await harness.compactTerminal(session, compactStart);
        await harness.idle(session);
        await progress("compact/verify-native-summary");
        const compacted = await compactionEntries(fixture.configRoot);
        assert.equal(
          compacted.length,
          beforeCompactions.length + 1,
          "Native compaction must persist exactly one OMP compaction entry",
        );
        const addedCompactions = compacted.filter(
          (entry) => !beforeCompactions.some((before) => before.id === entry.id),
        );
        assert.equal(addedCompactions.length, 1);
        const summary = addedCompactions[0]!.summary;
        assert.match(
          summary,
          /NATIVE_COMPACT_PARAMETER/,
          "Native customInstructions were not applied",
        );
        assert.match(summary, /NATIVE_SKILL_RESULT/);
        assert.match(summary, /NATIVE_GOAL_CREATED/);
        await writeFile(
          join(fixture.evidence, "compact-native-result.json"),
          JSON.stringify(
            {
              session,
              nativeTerminal: nativeTerminal.match(/^Compaction complete\.[^\n]*/mu)?.[0],
              compactionEntry: addedCompactions[0],
              result: "passed",
              scope:
                "native terminal, one journal entry, customInstructions and preserved markers; subsequent model call is separate",
            },
            null,
            2,
          ),
        );
        passed.push("compact-native");
        await progress("compact/native-passed");
      }
      if (selected.has("compact") || selected.has("postcompact")) {
        const recordedNative = JSON.parse(
          await readFile(join(fixture.evidence, "compact-native-result.json"), "utf8"),
        );
        assert.equal(
          recordedNative.session,
          session,
          "Post-compaction model acceptance must use the already compacted stable session",
        );
        assert.equal(recordedNative.result, "passed");
        // 参数是否生效已经由真实 summary 硬断言证明；额外/新旧 sentinel 的自然语言猜测
        // 并非 rpc-ui 接入需求。这里验证压缩后仍可启动真实模型轮并增加实际输出 token。
        await progress("compact/post-model-call");
        const beforeTokens = harness.view(session).state.usage.cumulative.outputTokens;
        await harness.send(
          session,
          "压缩后的新模型轮只读验收，不调用任何工具。只回复 NATIVE_POST_COMPACT_RESULT。",
          /^NATIVE_POST_COMPACT_RESULT[.!。]?\s*$/m,
        );
        const afterTokens = harness.view(session).state.usage.cumulative.outputTokens;
        assert.ok(
          afterTokens > beforeTokens,
          "A successful post-compaction model round must increase real model output usage",
        );
        await writeFile(
          join(fixture.evidence, "compact-post-model-result.json"),
          JSON.stringify(
            {
              session,
              beforeTokens,
              afterTokens,
              result: "passed",
              scope: "real post-compaction model turn completed with output and usage growth",
            },
            null,
            2,
          ),
        );
        passed.push("compact");
        await progress();
      }
      if (selected.has("plan")) {
        // 模型通过 OMP 原生 write 的 xd://propose 触发审批；不注入 proposal 事件。
        for (const approved of [false, true]) {
          const marker = approved ? "NATIVE_PLAN_APPROVED_RESULT" : "NATIVE_PLAN_DECLINED_RESULT";
          const slug = approved ? "native-approved" : "native-declined";
          const text = `/plan 请创建一个极短的计划：批准后不调用任何工具，只回复 ${marker}。先用 write 写 local://${slug}-plan.md，再用 write 把纯文本标题 ${slug} 写入 xd://propose 提交该计划，等待用户批准，批准前不能直接回复该标记。`;
          await progress(`plan/${approved ? "approved" : "declined"}/submit`);
          const proposalSubmission = harness.command(session, "sendText", { text }).then(
            (ack) => ({ ack }),
            (error) => ({ error }),
          );
          await progress(`plan/${approved ? "approved" : "declined"}/wait-proposal`);
          const question = await harness.question(session);
          assert.match(String(question.payload.prompt), /execute|plan|approve|计划|批准/i);
          const approvalCursor = harness.cursor(session);
          await progress(`plan/${approved ? "approved" : "declined"}/answer-proposal`);
          await harness.answer(session, question, { action: approved ? "accept" : "decline" });
          const proposalOutcome = await proposalSubmission;
          if ("error" in proposalOutcome) throw proposalOutcome.error;
          assert.equal(proposalOutcome.ack.status, "accepted");
          if (approved) {
            await harness.output(
              session,
              approvalCursor,
              new RegExp(`^${marker}[.!。]?\\s*$`, "m"),
              240_000,
            );
            await harness.idle(session);
            await harness.wait(() => harness.view(session).state.config?.thought === "low");
          } else {
            await harness.idle(session);
            assert.doesNotMatch(harness.text(session, approvalCursor), new RegExp(marker));
          }
          if (!approved) {
            await progress("plan/declined/exit-draft-confirmation");
            await harness.dialog(session, "/plan", [true], /plan mode paused/i);
            await harness.send(session, "/plan", /plan mode disabled/i);
          }
        }
        passed.push("plan-approval/rejection");
        await progress();
      }
      await progress("cold/model-history");
      const live = await harness.history(session);
      await harness.close();
      harness = await start(fixture, credentials);
      const listing = await harness.request("session/list", {});
      const restored = listing.sessions.filter(
        (entry: RecordValue) => entry.title === "NATIVE_MODEL_COMMAND_ACCEPTANCE",
      );
      assert.equal(restored.length, 1, "Cold catalog must contain one canonical parent session");
      const stableSession = restored[0].sessionId;
      for (const mode of ["desktop-continuous", "web-remote-replayable"] as const) {
        await harness.subscribe(stableSession, mode);
        assert.equal(
          await harness.history(stableSession),
          live,
          `Model output changed after cold resume (${mode})`,
        );
      }
      await writeFile(
        join(fixture.evidence, "model-result.json"),
        JSON.stringify(
          { passed, coldModes: ["desktop-continuous", "web-remote-replayable"], result: "passed" },
          null,
          2,
        ),
      );
      console.log(`Native model acceptance evidence: ${fixture.evidence}`);
      await progress("complete", "passed");
    } catch (error) {
      await progress(currentPhase, "failed", error);
      throw error;
    } finally {
      await harness.close();
    }
  },
);

test(
  "N04 plan-controls-only preserves delayed pause output during native context reads",
  testOptions,
  async () => {
    const existingRoot = process.env.OMP_NATIVE_E2E_ROOT;
    assert.ok(
      existingRoot,
      "Reuse an existing isolated native model fixture with a real plan draft",
    );
    const fixture = await prepareNativeFixture(existingRoot);
    const harness = await start(fixture, await nativeCredentialEnv());
    try {
      const listing = await harness.request("session/list", {});
      const parent = listing.sessions.filter(
        (entry: RecordValue) => entry.title === "NATIVE_MODEL_COMMAND_ACCEPTANCE",
      );
      assert.equal(parent.length, 1);
      const session = parent[0].sessionId;
      await harness.subscribe(session, "desktop-continuous");
      await harness.subscribe(session, "web-remote-replayable");
      const initial = harness.cursor(session);
      assert.equal(
        (await harness.command(session, "sendText", { text: "/plan" })).status,
        "accepted",
      );
      const initialOutput = await harness.output(
        session,
        initial,
        /Plan mode disabled|Plan mode enabled/i,
        15_000,
      );
      if (/disabled/iu.test(initialOutput))
        await harness.send(session, "/plan", /Plan mode enabled/i);
      await harness.dialog(session, "/plan", [true]);
      await harness.output(session, initial, /Plan mode paused/i, 15_000);
      await harness.send(session, "/plan", /Plan mode disabled/i);
      await writeFile(
        join(fixture.evidence, "plan-controls-result.json"),
        JSON.stringify(
          {
            session,
            result: "passed",
            scope:
              "real local plan state controls, native confirmation and delayed visible output; no model call",
          },
          null,
          2,
        ),
      );
    } finally {
      await harness.close();
    }
  },
);

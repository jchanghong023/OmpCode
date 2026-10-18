// 真实已安装 omp 二进制 → omp-agent 适配器 → ZCode v4 公开协议的 E2E。
// 仅模型响应由本地模拟服务提供；工具、ask、子代理及记录读取都由真实 OMP 执行。
// 移除对外部模型可用性及用户凭据的依赖，避免网络、配额和认证波动污染本地验收。
// 独立临时 OMP 根与工作区；没有安装核时跳过，不下载或安装，门禁将跳过视为未验证。

import { readFile } from "node:fs/promises";
import { test } from "node:test";
import assert from "node:assert/strict";
import { join } from "node:path";
import { z } from "zod";
import {
  pendingInteractionSchema,
  sessionsIndexTopicFrameSchema,
  sessionsIndexTopicWireFrameSchema,
  TopicWireFrameAssembler,
  v4ConversationRowsRangeResultSchema,
} from "@zcode/shared/zcode-protocol-v4";
import { MOCK_MODEL_SELECTOR } from "./fixtures/ompMockServer.mjs";
import {
  realOmpSkip,
  startRealOmpHarness,
  type RealOmpHarness,
} from "./fixtures/realOmpHarness.js";

function indexSessionIds(harness: RealOmpHarness): string[] {
  const assembler = new TopicWireFrameAssembler(sessionsIndexTopicFrameSchema);
  const ids = new Set<string>();
  for (const frame of harness.frames) {
    if (frame.method !== "v4/conversation/frame") continue;
    const wire = sessionsIndexTopicWireFrameSchema.safeParse(frame.params);
    if (!wire.success || wire.data.topic !== "sessions-index/real-e2e-workspace") continue;
    for (const event of assembler.accept(wire.data)) {
      if (event.kind === "fault") assert.fail(JSON.stringify(event.fault));
      const payload = event.frame.payload;
      if (payload.kind === "snapshot") {
        ids.clear();
        for (const session of payload.snapshot.sessions) ids.add(session.sessionId);
      } else {
        for (const delta of payload.deltas) {
          if (delta.op === "session.upserted") ids.add(delta.session.sessionId);
          if (delta.op === "session.removed") ids.delete(delta.sessionId);
        }
      }
    }
  }
  return [...ids];
}

test(
  `真实 OMP + 模拟模型 ${MOCK_MODEL_SELECTOR}：流式、write、ask 作答及真实子代理记录`,
  { skip: realOmpSkip },
  async () => {
    const harness = await startRealOmpHarness();
    const { mock, workspace } = harness;
    try {
      await harness.request("v4/conversation/subscribe", {
        topic: "sessions-index/real-e2e-workspace",
        connectionId: "real-core-identity-index",
        clientMode: "desktop-continuous",
      });
      const writeSession = await harness.create("write", "ZCODE_MOCK_WRITE greeting-real.txt");
      const writeRows = await harness.complete(writeSession, "OMP_MOCK_WRITE_DONE", "write");
      assert.equal(
        await readFile(join(workspace, "greeting-real.txt"), "utf8"),
        "real omp wrote this\n",
      );
      mock.assertHealthy();

      const askMarker = "CORE_ASK";
      const askSession = await harness.create("ask", `ZCODE_MOCK_ASK ${askMarker}`);
      const ask = await harness.interaction(askSession);
      assert.equal(ask.params.questions?.length, 1, "真实 ask 必须携带完整问题集");
      const question = ask.params.questions![0]!;
      assert.equal(question.question, `Choose the mock answer for ${askMarker}`);
      assert.deepEqual(
        question.options.map((option) => option.label),
        ["Mock answer A", "Mock answer B"],
      );
      const askCard = pendingInteractionSchema
        .array()
        .parse(harness.state(askSession).pendingInteractions)
        .find((item) => item.interactionId === ask.params.requestId);
      assert.ok(askCard?.payload.kind === "userInput");
      assert.equal(askCard.payload.toolName, "AskUserQuestion");
      assert.deepEqual(askCard.payload.questions, ask.params.questions, "问答投影须保留真实选项");
      harness.respond(ask.id, { action: "accept", content: { answer_0: ["Mock answer A"] } });
      const askRows = await harness.complete(askSession, `${askMarker}_ASK_DONE`, "ask");
      const askOutput = z
        .object({ text: z.string().min(1), answers: z.record(z.string(), z.array(z.string())) })
        .parse(askRows.find((row) => row.kind === "toolCall" && row.toolName === "ask")?.output);
      assert.deepEqual(askOutput.answers, {
        [`Choose the mock answer for ${askMarker}`]: ["Mock answer A"],
      });
      assert.deepEqual(harness.state(askSession).pendingInteractions, [], "ask 应答后必须收口");
      mock.assertHealthy();

      const taskMarker = "CORE_TASK";
      const taskSession = await harness.create("task", `ZCODE_MOCK_TASK ${taskMarker}`);
      const taskRows = await harness.complete(taskSession, `${taskMarker}_TASK_DONE`, "task");
      const subagent = await harness.waitUntil(() =>
        [...harness.rows(taskSession).values()].find(
          (row) => row.kind === "subagent" && row.status === "success",
        ),
      );
      assert.equal(subagent.subagentType, "task");
      const childSessionId = z.string().min(1).parse(subagent.childSessionId);
      assert.notEqual(childSessionId, taskSession, "子代理必须拥有独立身份");
      assert.match(childSessionId, /^omp-subagent:MockChild_CORE_TASK@/u);
      const taskRow = taskRows.find((row) => row.kind === "toolCall" && row.toolName === "task")!;
      assert.equal(subagent.parentToolCallId, taskRow.toolCallId, "子代理必须关联真实父工具调用");
      // 详情订阅触发 get_subagent_messages 读取子代理真实保存记录，不从父代理完成文本取证。
      await harness.subscribe(childSessionId);
      const childRows = [...harness.rows(childSessionId).values()];
      assert.ok(
        childRows.some(
          (row) =>
            row.kind === "userInput" &&
            String(row.text ?? "").includes(`ZCODE_MOCK_CHILD ${taskMarker}`),
        ),
        "真实子记录必须包含派发输入",
      );
      assert.ok(
        childRows.some(
          (row) =>
            row.kind === "assistantText" &&
            String(row.text ?? "").includes(`${taskMarker}_CHILD_DONE`),
        ),
        "真实子记录必须包含实际子输出",
      );
      // 父工具参数本身也含 CHILD，必须核对独立请求的 user 内容，不能只搜索所有请求字符串。
      const childRequests = mock.calls.filter((call: unknown) => {
        const parsed = z
          .object({
            context: z.object({
              messages: z.array(z.object({ role: z.string(), content: z.unknown() })),
            }),
          })
          .parse(call);
        return parsed.context.messages.some((message) => {
          if (message.role !== "user") return false;
          const text =
            typeof message.content === "string"
              ? message.content
              : z
                  .array(z.looseObject({ type: z.string(), text: z.string().optional() }))
                  .parse(message.content)
                  .filter((block) => block.type === "text")
                  .map((block) => block.text ?? "")
                  .join("\n");
          // OMP date-cwd-reminder 仅前置固定提醒；字符串与独立 text block 分别产生两个或一个换行。
          // 只移除这个已知的首部信封，剩余 user 正文仍须完整匹配，父 task 参数不能充当子请求。
          const input = text.replace(
            /^<system-reminder>\nToday: \d{4}-\d{2}-\d{2}; current working directory: '[^\r\n]+'\. Do not repeat this information in your reply\.\n<\/system-reminder>\n{1,2}/u,
            "",
          );
          // tiny-model 的 task label 请求独立存在，不能作为实际执行子任务的 HTTP 证据。
          if (input === `<user>\nZCODE_MOCK_CHILD ${taskMarker}\n</user>`) return false;
          // 真实 structured-subagent 路径通过 renderSubagentPrompt 派发完整任务信封；
          // 裸 CHILD 标记同样不证明执行了真实 assignment。
          return input === `Complete assignment thoroughly:\n\nZCODE_MOCK_CHILD ${taskMarker}`;
        });
      });
      assert.equal(
        childRequests.length,
        1,
        "必须观察到一次携带完整 assignment 的独立真实子模型请求",
      );
      mock.assertHealthy();
      // 终态不是身份元数据屏障；观察既有公开索引的 UUID 绑定，再按精确 tool ID 关联场景。
      const canonicalIds = await harness.waitUntil(() => {
        const ids = indexSessionIds(harness);
        return ids.length === 3 && ids.every((id) => z.uuid().safeParse(id).success)
          ? ids
          : undefined;
      });
      const stableSessions: Partial<Record<"write" | "ask" | "task", string>> = {};
      for (const sessionId of canonicalIds) {
        const { rows } = v4ConversationRowsRangeResultSchema.parse(
          await harness.request("v4/conversation/rowsRange", { sessionId, limit: 100 }),
        );
        for (const [toolName, liveRows] of [
          ["write", writeRows],
          ["ask", askRows],
          ["task", taskRows],
        ] as const) {
          const liveTool = liveRows.find(
            (row) => row.kind === "toolCall" && row.toolName === toolName,
          );
          assert.ok(liveTool);
          if (
            !rows.some((row) => row.kind === "toolCall" && row.toolCallId === liveTool.toolCallId)
          )
            continue;
          assert.equal(stableSessions[toolName], undefined, "每个真实工具只属于一个持久会话");
          stableSessions[toolName] = sessionId;
        }
      }
      const stableWrite = z.uuid().parse(stableSessions.write);
      const stableAsk = z.uuid().parse(stableSessions.ask);
      const stableTask = z.uuid().parse(stableSessions.task);
      assert.equal(new Set([stableWrite, stableAsk, stableTask]).size, 3);
      // 卸载各会话的真实进程，再从同一隔离根按持久 UUID 读取 OMP journal。
      const modelCallsBeforeRecovery = mock.calls.length;
      for (const [sessionId, marker, toolName, liveRows] of [
        [stableWrite, "OMP_MOCK_WRITE_DONE", "write", writeRows],
        [stableAsk, `${askMarker}_ASK_DONE`, "ask", askRows],
        [stableTask, `${taskMarker}_TASK_DONE`, "task", taskRows],
      ] as const) {
        assert.deepEqual(await harness.request("session/close", { sessionId }), { closed: true });
        const frameCount = harness.conversationFrames(sessionId).length;
        await harness.subscribe(sessionId);
        // 冷 journal 原子发布历史快照，不重放 live turnHeader/agent_end。
        const snapshot = await harness.waitUntil(() => {
          for (const frame of harness.conversationFrames(sessionId).slice(frameCount)) {
            if (frame.payload.kind === "snapshot") return frame.payload.snapshot;
          }
          return undefined;
        });
        const liveTool = liveRows.find(
          (row) => row.kind === "toolCall" && row.toolName === toolName,
        );
        assert.ok(liveTool);
        const coldTool = snapshot.rows.window.find(
          (row) => row.kind === "toolCall" && row.toolCallId === liveTool.toolCallId,
        );
        assert.ok(coldTool?.kind === "toolCall", `冷快照缺少原始 ${toolName} 调用`);
        assert.equal(coldTool.toolName, toolName);
        assert.equal(coldTool.status, "success", `冷 ${toolName} 必须有已落盘的成功结果`);
        assert.deepEqual(coldTool.input, liveTool.input, "冷工具参数必须与实际调用一致");
        assert.deepEqual(coldTool.output, liveTool.output, "冷工具结果必须与实际执行结果一致");
        const inputMarker = {
          write: "ZCODE_MOCK_WRITE greeting-real.txt",
          ask: `ZCODE_MOCK_ASK ${askMarker}`,
          task: `ZCODE_MOCK_TASK ${taskMarker}`,
        }[toolName];
        assert.ok(
          snapshot.rows.window.some(
            (row) => row.kind === "userInput" && row.text.includes(inputMarker),
          ),
          `冷 ${toolName} 必须保留真实派发输入`,
        );
        assert.ok(
          snapshot.rows.window.some(
            (row) =>
              row.kind === "assistantText" && row.state === "complete" && row.text.includes(marker),
          ),
          `冷 ${toolName} 必须保留已完成的真实最终正文`,
        );
      }
      const coldAsk = [...harness.rows(stableAsk).values()].find(
        (row) => row.kind === "toolCall" && row.toolName === "ask",
      );
      assert.deepEqual(coldAsk?.output, askOutput, "冷恢复必须保留实际结构化答案及原结果正文");
      assert.equal(
        await readFile(join(workspace, "greeting-real.txt"), "utf8"),
        "real omp wrote this\n",
      );
      const coldSubagent = [...harness.rows(stableTask).values()].find(
        (row) => row.kind === "subagent" && row.parentToolCallId === taskRow.toolCallId,
      );
      assert.ok(coldSubagent, "冷父记录必须保留同一个实际子代理");
      assert.equal(coldSubagent.status, "success");
      assert.equal(coldSubagent.parentToolCallId, taskRow.toolCallId);
      const coldChildId = z.string().parse(coldSubagent.childSessionId);
      assert.equal(coldChildId, `omp-subagent:MockChild_${taskMarker}@${stableTask}`);
      await harness.subscribe(coldChildId);
      await harness.waitUntil(() =>
        [...harness.rows(coldChildId).values()].some((row) => row.kind === "assistantText"),
      );
      const coldChildRows = [...harness.rows(coldChildId).values()];
      for (const [kind, marker] of [
        ["userInput", `ZCODE_MOCK_CHILD ${taskMarker}`],
        ["assistantText", `${taskMarker}_CHILD_DONE`],
      ] as const) {
        assert.ok(
          coldChildRows.some((row) => row.kind === kind && String(row.text ?? "").includes(marker)),
          `冷子记录必须保留 ${kind} 的实际内容`,
        );
      }
      assert.equal(mock.calls.length, modelCallsBeforeRecovery, "冷读取不能额外调用模型");
      mock.assertHealthy();
      console.log(
        "[real-e2e] 真实 OMP + 模拟模型：流式、write 精确落盘、ask 持久答案及独立子代理记录通过",
      );
    } finally {
      await harness.close();
    }
  },
);

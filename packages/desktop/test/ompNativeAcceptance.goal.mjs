import assert from "node:assert/strict";
import {
  diagnostics,
  visibleText,
  idle,
  taskIds,
  confirm,
  orchestrate,
  journalEvidence,
} from "./ompNativeAcceptance.helpers.mjs";
import { commandRows } from "./ompNativeAcceptance.commandRows.mjs";
import { commandOutput, goalStatus } from "./ompNativeAcceptance.history.mjs";

const activeGoal = /(?:^|\s)Status: active(?=\sTokens:)/u;
const pausedGoal = /(?:^|\s)Status: paused(?=\sTokens:)/u;
const budgetLimitedGoal = /(?:^|\s)Status: budget-limited(?=\sTokens:)/u;

export async function exerciseGoal(page, runtime, manifest) {
  const { values } = manifest;
  const callsBefore = (await diagnostics(runtime)).calls.length;
  await orchestrate(page, runtime, "/goal", "设置目标", { 目标正文: values.goal });
  await visibleText(page, "NATIVE_GOAL_READY_731");
  await idle(page);
  await commandOutput(
    page,
    () => orchestrate(page, runtime, "/goal", "暂停目标"),
    /(?:paused|暂停)/iu,
    "Goal pause",
  );
  await goalStatus(page, runtime, pausedGoal, values.goal);
  await commandOutput(
    page,
    () => orchestrate(page, runtime, "/goal", "恢复目标"),
    /(?:resumed|active|恢复)/iu,
    "Goal resume",
  );
  const resumedGoal = await goalStatus(page, runtime, activeGoal, values.goal);
  const resumedUsage = resumedGoal.text.match(/\bTokens: (\d+) \(no budget\)(?=\sTime spent:)/u);
  assert.ok(resumedUsage, "Resumed Goal must expose its actual accumulated token usage");
  // 预算调整沿用核心累计用量；此用例显式覆盖已耗尽预算，不把它误判为 active。
  assert.ok(
    Number(resumedUsage[1]) >= Number(values.goalBudget),
    "Requested Goal budget must exercise the budget-limited transition",
  );
  await commandOutput(
    page,
    () =>
      orchestrate(
        page,
        runtime,
        "/goal",
        "调整预算",
        { "Token 预算（正整数或 off）": values.goalBudget },
        `/goal budget ${values.goalBudget}`,
      ),
    new RegExp(`(?:budget|预算)[^\\n]*\\b${values.goalBudget}\\b`, "iu"),
    "Goal requested budget adjustment",
  );
  await goalStatus(page, runtime, budgetLimitedGoal, values.goal, values.goalBudget);
  await commandOutput(
    page,
    () => orchestrate(page, runtime, "/goal", "暂停目标"),
    /(?:paused|暂停)/iu,
    "Goal second pause",
  );
  const beforeCancelledDrop = await goalStatus(
    page,
    runtime,
    pausedGoal,
    values.goal,
    values.goalBudget,
  );
  const beforeCancelledDropRows = await commandRows(page);
  const beforeCancelledDropTasks = await taskIds(page);
  const beforeCancelledDropJournals = await journalEvidence(runtime);
  const beforeCancelledDropCalls = (await diagnostics(runtime)).calls.length;
  // 核心确认 false 直接返回，不发送取消文案；以真实请求结束和状态不变验收。
  await orchestrate(page, runtime, "/goal", "删除目标");
  await confirm(page, false);
  await idle(page);
  assert.deepEqual(
    await commandRows(page),
    beforeCancelledDropRows,
    "Cancelled Goal drop must not add, delete, reorder or rewrite command history",
  );
  assert.deepEqual(
    await taskIds(page),
    beforeCancelledDropTasks,
    "Cancelled Goal drop must retain the same session identities",
  );
  assert.deepEqual(
    await journalEvidence(runtime),
    beforeCancelledDropJournals,
    "Cancelled Goal drop must not mutate any native session or Goal state",
  );
  assert.equal(
    (await diagnostics(runtime)).calls.length,
    beforeCancelledDropCalls,
    "Cancelled Goal drop must not issue a model request",
  );
  const afterCancelledDrop = await goalStatus(
    page,
    runtime,
    pausedGoal,
    values.goal,
    values.goalBudget,
  );
  assert.equal(
    afterCancelledDrop.text,
    beforeCancelledDrop.text,
    "Cancelled Goal drop must preserve the exact objective, paused state, usage and budget",
  );
  await commandOutput(
    page,
    async () => {
      await orchestrate(page, runtime, "/goal", "删除目标");
      await confirm(page, true);
    },
    /(?:dropped|deleted|removed|No goal set|已删除|已移除)/iu,
    "Goal confirmed drop",
  );
  await goalStatus(page, runtime, /^No goal set\.$/mu);
  assert.equal(
    (await diagnostics(runtime)).calls.length,
    callsBefore + 1,
    "Native Goal state/control must not resend model rounds",
  );
}

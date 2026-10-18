import assert from "node:assert/strict";
import { readFile, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { chromium } from "playwright-core";
import { captureIsolationScreenshot, readIsolationEvidence } from "./ompCore.evidence.cjs";
import {
  diagnostics,
  eventually,
  visibleText,
  timelineContains,
  idle,
  send,
  taskIds,
  canonicalTask,
  panel,
  orchestrate,
  selectValue,
  indexSnapshot,
  journalEvidence,
  assertToolResult,
} from "./ompNativeAcceptance.helpers.mjs";
import {
  assertNoSkillLeak,
  skillCatalogParity,
  exerciseInitialDraft,
  exerciseSkills,
} from "./ompNativeAcceptance.skills.mjs";
import { commandRows } from "./ompNativeAcceptance.commandRows.mjs";
import {
  assertCommandHistory,
  assertRepoHistory,
  commandOutput,
} from "./ompNativeAcceptance.history.mjs";
import { teamEvidence } from "./ompNativeAcceptance.teamHistory.mjs";
import { exerciseIndexes, deleteIndexes } from "./ompNativeAcceptance.indexes.mjs";
import { exerciseGoal } from "./ompNativeAcceptance.goal.mjs";

const phase = process.env.OMP_E2E_PHASE;
assert.ok(
  ["live", "recovery"].includes(phase),
  "Native acceptance requires explicit same-root live/recovery phases",
);
assert.ok(process.env.OMP_E2E_RUNTIME_MANIFEST && process.env.OMP_E2E_CDP_URL);
const runtime = JSON.parse(await readFile(process.env.OMP_E2E_RUNTIME_MANIFEST, "utf8"));
assert.equal(runtime.suite, "native");
assert.equal(runtime.endpoint, process.env.OMP_E2E_CDP_URL);
assert.ok(runtime.acceptance?.paths && runtime.configRoot && runtime.ompBinary);
const manifest = runtime.acceptance;
const { paths, values } = manifest;
const evidence = process.env.OMP_E2E_EVIDENCE_DIR;
assert.ok(evidence);
const receiptPath = join(evidence, "native-acceptance-receipt.json");
const browser = await chromium.connectOverCDP(runtime.endpoint);
try {
  const pages = browser
    .contexts()
    .flatMap((context) => context.pages())
    .filter((page) => page.url().startsWith(runtime.rendererUrl));
  assert.equal(pages.length, 1, "Use only this owned renderer");
  const page = pages[0];
  page.setDefaultTimeout(90_000);
  const errors = [];
  page.on("pageerror", (error) => errors.push(error.message));
  const isolation = async () => {
    const report = await readIsolationEvidence(runtime.isolationEvidence);
    assert.equal(report.electronPid, runtime.electronPid);
    assert.equal(report.verified, true);
    assert.equal(report.mode, "hidden-native-windows");
    assert.ok(report.windows.length > 0);
    for (const win of report.windows)
      assert.deepEqual([win.visible, win.focused, win.focusable], [false, false, false]);
  };
  await isolation();
  assert.equal(
    (await diagnostics(runtime)).calls.length,
    0,
    "Opening native GUI/catalog must not call a model",
  );
  const input = page.getByTestId("v4-composer-input");
  await input.waitFor({ state: "visible" });
  let receipt;
  if (phase === "live") {
    const before = await taskIds(page);
    const mainTask = await exerciseInitialDraft(page, runtime, manifest, before, input);
    const names = await exerciseSkills(page, runtime, manifest);

    // 空参数不能靠表单预览或模型的通用回复伪装已完成。
    const callsBefore = (await diagnostics(runtime)).calls.length;
    let dialog = await panel(page, runtime, "知识与代码索引");
    const query = dialog.getByRole("textbox", { name: "代码检索内容", exact: true });
    await query.fill(" \n\t ");
    assert.equal(
      await dialog
        .getByRole("button", { name: "通过当前会话模型使用 repo 工具", exact: true })
        .isEnabled(),
      false,
    );
    await page.keyboard.press("Escape");
    dialog = await panel(page, runtime, "编排快捷操作");
    await selectValue(page, dialog.getByRole("combobox", { name: "命令", exact: true }), "/goal");
    await selectValue(
      page,
      dialog.getByRole("combobox", { name: "目标操作", exact: true }),
      "设置目标",
    );
    await dialog.getByRole("textbox", { name: "目标正文", exact: true }).fill("");
    assert.equal(
      await dialog.getByRole("button", { name: "在当前会话执行", exact: true }).isEnabled(),
      false,
      "Empty Goal objective cannot execute",
    );
    // 同一 Electron 构建的 CDP Input 回执会挂起；用 renderer 键盘事件关闭验收面板。
    await page.evaluate(() =>
      document.dispatchEvent(
        new KeyboardEvent("keydown", { key: "Escape", bubbles: true, cancelable: true }),
      ),
    );
    assert.equal((await diagnostics(runtime)).calls.length, callsBefore);

    const indexIdentities = await exerciseIndexes(page, runtime, manifest);

    await exerciseGoal(page, runtime, manifest);

    await orchestrate(page, runtime, "/loop", "启动有限循环", {
      循环限制: "2",
      任务正文: values.loop,
    });
    await visibleText(page, "NATIVE_LOOP_ITERATION_1_731");
    await visibleText(page, "NATIVE_LOOP_ITERATION_2_731");
    // 无间隔的限制 2 表示首次执行后再重复两次，而不是总共两轮。
    await visibleText(page, "NATIVE_LOOP_ITERATION_3_731");
    await idle(page);
    assert.equal((await diagnostics(runtime)).acceptance.finiteTurns, 3);
    await orchestrate(page, runtime, "/loop", "启动有限循环", {
      循环限制: "3",
      任务正文: values.stopLoop,
    });
    await eventually(
      () => diagnostics(runtime),
      (data) => data.acceptance.stopTurns === 1,
      "Stop loop HTTP barrier",
    );
    await page.getByTestId("v4-stop").click();
    await idle(page);
    await eventually(
      () => diagnostics(runtime),
      (data) => data.calls.some((call) => call.aborted),
      "Actual loop HTTP cancellation",
    );
    assert.equal(await page.getByText("FORBIDDEN_LATE_LOOP_REPLY_731", { exact: true }).count(), 0);
    // Stop 只暂停原生 Loop；下一条模型输入会恢复它并替换循环正文。
    // 先保留上面的真实取消验收，再显式关闭，不能让后续独立 Repo 查询进入循环。
    const stoppedLoop = await diagnostics(runtime);
    assert.equal(stoppedLoop.acceptance.stopTurns, 1);
    await commandOutput(
      page,
      () => orchestrate(page, runtime, "/loop", "裸 /loop（关闭或切换）", {}, "/loop"),
      /^Loop mode disabled\.$/u,
      "Explicitly disable the paused native Loop",
    );
    assert.equal(
      (await diagnostics(runtime)).calls.length,
      stoppedLoop.calls.length,
      "Disabling the paused Loop is local and must not call a model",
    );

    // A separate real session proves loop ownership, not just two labels in one transcript.
    // 真实侧栏入口为“新建任务”；旧“新任务”按钮定位不存在，不能靠延长等待证明隔离。
    await page.getByText("新建任务", { exact: true }).click();
    await send(page, "NATIVE_ISOLATION_PROBE_731", "NATIVE_ISOLATION_REPLY_731");
    const isolatedTask = await canonicalTask(page, [...before, mainTask]);
    assert.notEqual(mainTask, isolatedTask);
    assert.equal(
      await page
        .getByTestId("v4-timeline")
        .getByText(/NATIVE_LOOP_ITERATION_|NATIVE_GOAL_READY_731/u)
        .count(),
      0,
    );
    await page.evaluate((id) => document.querySelector(`[data-testid="${id}"]`)?.click(), mainTask);
    const beforeTeam = await journalEvidence(runtime);
    await orchestrate(page, runtime, "/team", null, { 任务正文: values.team });
    await timelineContains(page, /NATIVE_TEAM_REPORT_731/u);
    await idle(page);
    const teamData = await eventually(
      () => diagnostics(runtime),
      (data) => {
        const reads = data.acceptance.issued.filter((item) => item.key.startsWith("team-read-"));
        const yields = data.acceptance.issued.filter((item) => item.key.startsWith("team-yield-"));
        return (
          reads.length === 8 &&
          yields.length === reads.length &&
          data.acceptance.completed.filter((item) => item.key.startsWith("team-read-")).length ===
            reads.length &&
          data.acceptance.pending.length === 0
        );
      },
      "Actual Team read callbacks and terminal yield submissions",
    );
    const participants = await teamEvidence(runtime, mainTask, beforeTeam, teamData, manifest);
    await timelineContains(page, /NATIVE_REAL_READ_731/u);
    assert.equal(await readFile(paths.read, "utf8"), values.read, "Native Team is read-only");
    assert.equal(await readFile(paths.document, "utf8"), values.document);
    assert.equal(
      await readFile(paths.code, "utf8"),
      values.rebuiltCode,
      "Team must not alter the freshly rebuilt indexed source",
    );
    assert.equal(await readFile(paths.attachment, "utf8"), values.attachment);

    await deleteIndexes(page, runtime, indexIdentities);
    const deletedIndexes = await indexSnapshot(runtime);
    dialog = await panel(page, runtime, "知识与代码索引");
    await dialog
      .getByRole("textbox", { name: "代码检索内容", exact: true })
      .fill("nativeMissingSymbol731");
    await dialog
      .getByRole("button", { name: "通过当前会话模型使用 repo 工具", exact: true })
      .click();
    await dialog.waitFor({ state: "hidden" });
    await visibleText(page, "NATIVE_REPO_UNAVAILABLE_731");
    await idle(page);
    const failedRepo = await diagnostics(runtime);
    // 设备成功返回 missing，不代表索引查询成功；必须展示真实缺索引原因。
    await assertToolResult(
      page,
      runtime,
      "repo-search-failed-docs",
      "Execute by writing JSON to xd://repo.",
    );
    await assertToolResult(
      page,
      runtime,
      "repo-search-failed",
      "No repository index exists. Open /repo to build one; use read/grep for current files meanwhile.",
    );
    await assertRepoHistory(page, runtime, failedRepo, manifest);
    assert.deepEqual(
      await indexSnapshot(runtime),
      deletedIndexes,
      "A failed model lookup must not recreate deleted native indexes",
    );
    await assertNoSkillLeak(page, manifest);
    assert.equal(
      (await diagnostics(runtime)).acceptance.stopTurns,
      1,
      "Switching sessions, Team and independent Repo queries must not restart the explicitly disabled loop",
    );
    receipt = {
      root: runtime.runRoot,
      launcherPid: runtime.launcherPid,
      mainTask,
      isolatedTask,
      before,
      names,
      indexes: await indexSnapshot(runtime),
      indexIdentities,
      participants,
      journalPhase: "live",
      journalsObservedAt: new Date().toISOString(),
      journals: await journalEvidence(runtime),
      commandOutputs: await commandRows(page),
      repoEvidence: failedRepo,
      replies: [
        "NATIVE_ATTACHMENT_CONSUMED_731",
        "NATIVE_SKILL_BEFORE_REPLY_731",
        "NATIVE_PROJECT_READ_DONE_731",
        "NATIVE_SKILL_AFTER_REPLY_731",
        "NATIVE_COLLISION_READ_DONE_731",
        "NATIVE_USER_READ_DONE_731",
        "NATIVE_SHARED_READ_DONE_731",
        "NATIVE_REPO_SEARCH_DONE_731",
        "NATIVE_REPO_UPDATED_DONE_732",
        "NATIVE_REPO_REBUILT_DONE_733",
        "NATIVE_REPO_OLD_REMOVED_731",
        "NATIVE_REPO_UPDATED_REMOVED_732",
        "NATIVE_GOAL_READY_731",
        "NATIVE_LOOP_ITERATION_1_731",
        "NATIVE_LOOP_ITERATION_2_731",
        "NATIVE_LOOP_ITERATION_3_731",
        "NATIVE_REPO_UNAVAILABLE_731",
      ],
    };
    await writeFile(receiptPath, JSON.stringify(receipt, null, 2));
  } else {
    receipt = JSON.parse(await readFile(receiptPath, "utf8"));
    assert.equal(
      receipt.journalPhase,
      "post-shutdown",
      "Cold native recovery requires the owned-shutdown receipt",
    );
    assert.equal(receipt.root, runtime.runRoot);
    assert.notEqual(receipt.launcherPid, runtime.launcherPid);
    assert.deepEqual(
      (await taskIds(page)).filter((id) => !receipt.before.includes(id)).sort(),
      [receipt.mainTask, receipt.isolatedTask].sort(),
    );
    await page.evaluate(
      (id) => document.querySelector(`[data-testid="${id}"]`)?.click(),
      receipt.mainTask,
    );
    for (const reply of receipt.replies) await visibleText(page, reply);
    await assertCommandHistory(page, receipt.commandOutputs);
    // Compact read summaries recover in the GUI; journal/HTTP evidence retains all three bodies.
    await assertRepoHistory(page, runtime, receipt.repoEvidence, manifest);
    await timelineContains(page, /NATIVE_TEAM_REPORT_731/u);
    await timelineContains(page, /NATIVE_REAL_READ_731/u);
    await timelineContains(page, /skill-argument-731 and retain this context/u);
    await timelineContains(page, /skill-collision-731/u);
    // 技能 chip 由既有展示层将 slug 格式化为可读标题；冷恢复不绑定裸 slug 的字面排版。
    await timelineContains(page, /skill-user-731/u);
    await timelineContains(page, /skill-shared-731/u);
    await assertNoSkillLeak(page, manifest);
    assert.equal(await page.getByText("FORBIDDEN_LATE_LOOP_REPLY_731", { exact: true }).count(), 0);
    const dialog = await panel(page, runtime, "编排快捷操作");
    await page.keyboard.press("Escape");
    await dialog.waitFor({ state: "hidden" });
    assert.deepEqual(await skillCatalogParity(page, runtime, manifest), receipt.names);
    await page.evaluate(
      (id) => document.querySelector(`[data-testid="${id}"]`)?.click(),
      receipt.isolatedTask,
    );
    await visibleText(page, "NATIVE_ISOLATION_REPLY_731");
    assert.equal(
      await page
        .getByTestId("v4-timeline")
        .getByText(/NATIVE_LOOP_ITERATION_|NATIVE_TEAM_REPORT_731/u)
        .count(),
      0,
    );
    await page.evaluate(
      (id) => document.querySelector(`[data-testid="${id}"]`)?.click(),
      receipt.mainTask,
    );
    await assertCommandHistory(page, receipt.commandOutputs);
    assert.deepEqual(
      await indexSnapshot(runtime),
      receipt.indexes,
      "Cold navigation must not recreate/deleting/rebuild indexes",
    );
    assert.deepEqual(
      await journalEvidence(runtime),
      receipt.journals,
      "Cold native history must not append/replay commands or Team/tool effects",
    );
    assert.equal(
      (await diagnostics(runtime)).calls.length,
      0,
      "Every cold history/panel/catalog operation must remain model-free",
    );
  }
  await isolation();
  assert.deepEqual(errors, [], "Native interactions must not raise renderer errors");
  await captureIsolationScreenshot(join(evidence, `native-${phase}.png`), runtime.screenshotUrl);
  console.log(
    `Native acceptance ${phase}: actual panels, index/control/tool/skill evidence asserted`,
  );
} finally {
  await browser.close();
}

import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { readFile, readdir, writeFile } from "node:fs/promises";
import { basename, join } from "node:path";
import { captureIsolationScreenshot } from "./ompCore.evidence.cjs";

const answer = "Mock answer A";
const tool = (page, name) => page.locator(`[data-tool-call-id][data-tool-name="${name}"]`);

async function submit(page, prompt) {
  await page.getByTestId("v4-composer-input").fill(prompt);
  await page.getByTestId("v4-composer-send").click();
}

async function complete(page, marker) {
  await page.getByText(marker, { exact: true }).waitFor({ state: "visible", timeout: 90_000 });
  await page.getByTestId("v4-composer-send").waitFor({ state: "visible" });
}

// ConversationTimeline is virtualized. Scroll its real DOM viewport, never its store/projection.
async function reveal(page, target, scope) {
  if (await target.isVisible()) return;
  const timeline = scope
    ? scope.locator('[data-v4-timeline-scroll="true"]')
    : page.getByTestId("v4-timeline").first();
  assert.equal(await timeline.count(), 1, "Browse exactly one actual timeline viewport");
  const settleLayout = () =>
    timeline.evaluate(
      () => new Promise((done) => requestAnimationFrame(() => requestAnimationFrame(done))),
    );
  const openWorkDisclosures = async () => {
    const collapsed = timeline.locator(
      'button[data-testid^="chat-assistant-history-trigger-"][data-history-open="false"], ' +
        '[data-tool-name="ChangesGroup"] [data-testid^="tool-summary-trigger-"][aria-expanded="false"]',
    );
    for (;;) {
      if (await target.isVisible()) return;
      const id = await collapsed.evaluateAll((nodes) => {
        for (const node of nodes) {
          const viewport = node.closest('[data-v4-timeline-scroll="true"]');
          if (!viewport) continue;
          const bounds = viewport.getBoundingClientRect();
          const rect = node.getBoundingClientRect();
          const x = (rect.left + rect.right) / 2;
          const y = (rect.top + rect.bottom) / 2;
          if (
            !node.checkVisibility({ checkOpacity: true, checkVisibilityCSS: true }) ||
            rect.width <= 0 ||
            rect.height <= 0 ||
            x < Math.max(0, bounds.left) ||
            x >= Math.min(innerWidth, bounds.right) ||
            y < Math.max(0, bounds.top) ||
            y >= Math.min(innerHeight, bounds.bottom)
          )
            continue;
          return node.getAttribute("data-testid");
        }
        return null;
      });
      if (!id) break;
      // 候选预检只限定 viewport 与身份；未选中候选的瞬时遮挡不是最终 UI 契约。
      // 测高/贴底可能移动控件；标准 click 重新测量并强验选中控件的 stable/receives-events。
      await timeline.getByTestId(id).click();
      await timeline
        .getByTestId(id)
        .and(timeline.locator('[aria-expanded="true"]'))
        .waitFor({ state: "visible" });
      await settleLayout();
      if (await target.isVisible()) return;
    }
  };
  await settleLayout();
  // 正常 following 会在展开后的内容测高时贴底，先展开尾部会把候选挤出 viewport。
  // 先真实微量上滚解除 following，从当前 viewport 向后找；到末尾才回顶部完整扫一次。
  await timeline.hover();
  await page.mouse.wheel(0, -1);
  await settleLayout();
  let wrapped = false;
  for (;;) {
    await openWorkDisclosures();
    if (await target.isVisible()) return;
    const before = await timeline.evaluate((node) => ({
      top: node.scrollTop,
      height: node.clientHeight,
      end: node.scrollTop + node.clientHeight >= node.scrollHeight - 1,
    }));
    if (before.end) {
      if (wrapped) break;
      wrapped = true;
      await timeline.hover();
      await page.mouse.wheel(0, -(await timeline.evaluate((node) => node.scrollHeight)));
      await settleLayout();
      continue;
    }
    await timeline.hover();
    await page.mouse.wheel(0, Math.max(1, Math.floor(before.height * 0.7)));
    await settleLayout();
    if ((await timeline.evaluate((node) => node.scrollTop)) <= before.top) break;
  }
  await target.waitFor({ state: "visible" });
}

async function expandTool(page, name, expectedId) {
  const block = expectedId ? page.locator(`[data-tool-call-id="${expectedId}"]`) : tool(page, name);
  await reveal(page, block);
  assert.equal(
    await block.getAttribute("data-status"),
    "completed",
    `${name} must have a real successful result`,
  );
  const id = await block.getAttribute("data-tool-call-id");
  assert.ok(id);
  const summary = block.getByTestId(`tool-summary-trigger-${id}`);
  if ((await summary.getAttribute("aria-expanded")) === "false") {
    // 隔离 GUI 实测：write 摘要行可视中心是文件名 chip（内层按钮），点击打开预览并停止冒泡，
    // 因此 .click() 不会展开摘要；沿用同一真实控件已验证的 focus + Enter 键盘激活路径。
    await summary.focus();
    await page.keyboard.press("Enter");
  }
  return { block, id };
}

export async function exerciseMockInteractions(page, runtime, evidenceDir, runId) {
  await submit(page, "ZCODE_MOCK_WRITE greeting-real.txt");
  await complete(page, "OMP_MOCK_WRITE_DONE");
  assert.equal(
    await readFile(join(runtime.requestedWorkspace, "greeting-real.txt"), "utf8"),
    "real omp wrote this\n",
  );
  const write = await expandTool(page, "write");
  assert.match(await write.block.innerText(), /greeting-real\.txt/u);
  await captureIsolationScreenshot(join(evidenceDir, `write-result-${runId}.png`));

  const askMarker = `GUI_ASK_${runId}`;
  await submit(page, `ZCODE_MOCK_ASK ${askMarker}`);
  const card = page.locator('[data-elicitation-dialog-card="true"]');
  await card
    .getByRole("listbox", { name: `Choose the mock answer for ${askMarker}`, exact: true })
    .waitFor({ state: "visible" });
  const choice = card.getByRole("option", { name: /Mock answer A/u });
  await captureIsolationScreenshot(join(evidenceDir, `ask-choice-${runId}.png`));
  await choice.click();
  await card.waitFor({ state: "hidden" });
  await complete(page, `${askMarker}_ASK_DONE`);
  const ask = await expandTool(page, "ask");
  assert.match(await ask.block.innerText(), /Mock answer A/u);
  await captureIsolationScreenshot(join(evidenceDir, `ask-result-${runId}.png`));

  const taskMarker = `GUI_TASK_${runId}`;
  await submit(page, `ZCODE_MOCK_TASK ${taskMarker}`);
  await complete(page, `${taskMarker}_TASK_DONE`);
  const child = await inspectChild(page, `${taskMarker}_CHILD_DONE`);
  await captureIsolationScreenshot(join(evidenceDir, `child-details-${runId}.png`));
  const requests = await readMockRequests(runtime);
  assert.ok(
    requests.calls.some((call) =>
      call.messages.some((message) => {
        if (message.role !== "user") return false;
        const text =
          typeof message.content === "string"
            ? message.content
            : (message.content ?? [])
                .filter((part) => part.type === "text")
                .map((part) => part.text)
                .join("\n");
        // OMP prepends this reminder as a string or a separate text block.
        // Match the actual assignment, never the title generator's <user> wrapper.
        const assignment = text.replace(
          /^<system-reminder>\nToday: \d{4}-\d{2}-\d{2}; current working directory: '[^\r\n]*'\. Do not repeat this information in your reply\.\n<\/system-reminder>\n{1,2}/u,
          "",
        );
        return assignment === `Complete assignment thoroughly:\n\nZCODE_MOCK_CHILD ${taskMarker}`;
      }),
    ),
    "The fixture must receive the actual framed child assignment, not a task label or parent tool arguments",
  );
  return { writeToolCallId: write.id, askToolCallId: ask.id, askMarker, taskMarker, ...child };
}

async function inspectChild(page, marker, expected) {
  const children = page.locator('[data-testid^="v4-subagent-open-side-pane-"]');
  // @ 后是父会话路由：冷恢复改用持久 UUID；不变的身份是 OMP 原始子代理 ID 和独立 JSONL。
  const open = expected
    ? page.getByTestId(
        `v4-subagent-open-side-pane-omp-subagent:${expected.childAgentId}@${expected.parentSessionId}`,
      )
    : children;
  await reveal(page, open);
  assert.equal(await children.count(), 1, "One real task must expose one child identity");
  const childSessionId = (await open.getAttribute("data-testid")).slice(
    "v4-subagent-open-side-pane-".length,
  );
  const address = /^omp-subagent:([A-Za-z0-9_-]+)@(.+)$/u.exec(childSessionId);
  assert.ok(address, "Child detail must carry its raw OMP ID and parent route");
  const childAgentId = address[1];
  if (expected) {
    assert.equal(childAgentId, expected.childAgentId, "Cold recovery must retain the raw child ID");
    assert.equal(
      address[2],
      expected.parentSessionId,
      "Cold child route must belong to the saved parent UUID",
    );
  }
  await open.click();
  const pane = page.locator(`[data-subagent-session-id="${childSessionId}"]`);
  await pane.waitFor({ state: "visible" });
  await pane.getByText(marker, { exact: true }).waitFor({ state: "visible" });
  assert.equal(await pane.getByTestId("v4-subagent-unavailable").count(), 0);
  assert.equal(await pane.getByTestId("v4-subagent-readonly-error").count(), 0);
  return { childSessionId, childAgentId };
}

export async function assertRecoveredInteractions(page, saved, parentSessionId) {
  const write = await expandTool(page, "write", saved.writeToolCallId);
  assert.match(await write.block.innerText(), /greeting-real\.txt/u);
  const ask = await expandTool(page, "ask", saved.askToolCallId);
  assert.match(await ask.block.innerText(), /Mock answer A/u);
  await inspectChild(page, `${saved.taskMarker}_CHILD_DONE`, {
    childAgentId: saved.childAgentId,
    parentSessionId,
  });
}

export async function readMockRequests(runtime) {
  const response = await fetch(runtime.mock.diagnosticsUrl);
  const diagnostics = await response.json();
  assert.equal(response.status, 200, JSON.stringify(diagnostics));
  assert.equal(diagnostics.baseUrl, runtime.mock.baseUrl);
  return diagnostics;
}

async function jsonlFiles(directory) {
  const entries = await readdir(directory, { withFileTypes: true });
  const groups = await Promise.all(
    entries.map((entry) =>
      entry.isDirectory()
        ? jsonlFiles(join(directory, entry.name))
        : entry.name.endsWith(".jsonl")
          ? [join(directory, entry.name)]
          : [],
    ),
  );
  return groups.flat();
}

const messages = (entries) =>
  entries.filter((entry) => entry.type === "message").map((entry) => entry.message);
const textOf = (message) =>
  typeof message.content === "string"
    ? message.content
    : (message.content ?? []).map((part) => part.text ?? "").join("\n");
const readEntries = async (path) =>
  (await readFile(path, "utf8"))
    .split(/\r?\n/u)
    .filter(Boolean)
    .map((line) => JSON.parse(line));

export async function assertStoredInteractions(runtime, taskTestId, interaction, previous) {
  const files = await jsonlFiles(join(runtime.runRoot, "omp", "agent", "sessions"));
  const uuid = taskTestId.slice("task-item-".length);
  const parentPath = files.find((path) => basename(path).endsWith(`_${uuid}.jsonl`));
  assert.ok(parentPath, "Independently locate the stable parent JSONL by its persisted UUID");
  const parentEntries = await readEntries(parentPath);
  assert.equal(
    parentEntries.find((entry) => entry.type === "session")?.id,
    uuid,
    "Parent JSONL header must retain the sidebar's stable UUID",
  );
  const parent = messages(parentEntries);
  for (const [id, toolName, expected] of [
    [interaction.writeToolCallId, "write", ""],
    [interaction.askToolCallId, "ask", answer],
  ]) {
    const result = parent.find(
      (message) =>
        message.role === "toolResult" && message.toolCallId === id && message.toolName === toolName,
    );
    assert.ok(result, `Persist actual ${toolName} result correlated to its issued tool ID`);
    assert.notEqual(result.isError, true);
    assert.ok(textOf(result).includes(expected));
  }
  const taskResult = parent.find(
    (message) =>
      message.role === "toolResult" &&
      message.toolName === "task" &&
      textOf(message).includes(`${interaction.taskMarker}_CHILD_DONE`),
  );
  assert.ok(taskResult, "Persist the actual task result, not only the parent completion marker");
  assert.notEqual(taskResult.isError, true);
  assert.ok(
    parent.some(
      (message) =>
        message.role === "assistant" &&
        Array.isArray(message.content) &&
        message.content.some(
          (part) =>
            part.type === "toolCall" && part.id === taskResult.toolCallId && part.name === "task",
        ),
    ),
    "Task result must correlate to an actual issued task call",
  );
  const childAgentId = interaction.childAgentId;
  assert.match(childAgentId, /^[A-Za-z0-9_-]+$/u);
  assert.equal(
    interaction.childSessionId.slice("omp-subagent:".length).split("@")[0],
    childAgentId,
    "Live detail route must identify the saved raw child",
  );
  assert.deepEqual(
    taskResult.details?.results?.map((result) => result.id),
    [childAgentId],
    "The correlated parent task must have exactly this one actual child",
  );
  const childPath = join(parentPath.slice(0, -6), `${childAgentId}.jsonl`);
  assert.ok(
    files.includes(childPath),
    "Child identity must resolve to an actual independent OMP JSONL",
  );
  const childEntries = await readEntries(childPath);
  const header = childEntries.find((entry) => entry.type === "session");
  assert.ok(
    header?.id && header.id !== uuid,
    "The real child must have its own persisted session identity",
  );
  assert.equal(
    header.parentSession,
    parentPath,
    "Child JSONL must belong to this exact parent file",
  );
  const childOutput = messages(childEntries).find(
    (message) =>
      message.role === "assistant" &&
      textOf(message).includes(`${interaction.taskMarker}_CHILD_DONE`),
  );
  assert.ok(
    childOutput,
    "Actual child assistant output must be readable independently of the parent final marker",
  );
  for (const marker of [
    `GUI_IDENTITY_FIRST_${interaction.runId}`,
    `GUI_IDENTITY_SECOND_${interaction.runId}`,
  ]) {
    assert.equal(
      parent.filter((message) => message.role === "assistant" && textOf(message).includes(marker))
        .length,
      1,
      `Original assistant turn ${marker} must persist exactly once`,
    );
  }
  assert.equal(
    await readFile(join(runtime.requestedWorkspace, "greeting-real.txt"), "utf8"),
    "real omp wrote this\n",
  );
  const receipt = {
    parentPath,
    parentId: uuid,
    childPath,
    childId: header.id,
    childAgentId,
    childContentHash: createHash("sha256").update(JSON.stringify(childEntries)).digest("hex"),
    taskToolCallId: taskResult.toolCallId,
    parentMessageCount: parent.length,
    parentContentHash: createHash("sha256").update(JSON.stringify(parent)).digest("hex"),
  };
  if (previous)
    assert.deepEqual(
      receipt,
      previous,
      "Cold process must read the same persisted parent/child records",
    );
  return receipt;
}

export async function finalizeStoredInteractions(runtime, receiptPath) {
  const saved = JSON.parse(await readFile(receiptPath, "utf8"));
  const entries = await readEntries(saved.records.childPath);
  const hash = (value) => createHash("sha256").update(JSON.stringify(value)).digest("hex");
  // live 正文已完成不代表核心已 dispose；退出诊断必须纳入最终 receipt，
  // 但不能借“定稿”接纳任何正文改写或恢复阶段追加。
  if (hash(entries) !== saved.records.childContentHash) {
    assert.equal(
      hash(entries.slice(0, -1)),
      saved.records.childContentHash,
      "Shutdown must preserve the entire observed child journal prefix",
    );
    const exit = entries.at(-1);
    assert.equal(exit.type, "custom");
    assert.equal(exit.customType, "session_exit");
    assert.equal(exit.data?.reason, "dispose");
    assert.equal(exit.data?.kind, "normal");
  }
  const records = await assertStoredInteractions(runtime, saved.taskTestId, saved.interactions);
  assert.deepEqual(
    { ...records, childContentHash: saved.records.childContentHash },
    saved.records,
    "Shutdown may only append the child's normal exit diagnostic",
  );
  await writeFile(receiptPath, JSON.stringify({ ...saved, records }, null, 2));
}

export { reveal };

import assert from "node:assert/strict";
import {
  diagnostics,
  eventually,
  visibleText,
  timelineContains,
  idle,
  send,
  taskIds,
  canonicalTask,
  orchestrate,
  assertToolResult,
} from "./ompNativeAcceptance.helpers.mjs";
import {
  readTimelineViewport,
  scrollTimelineViewport,
  settleTimelineLayout,
} from "./ompMockInteractions.viewport.mjs";

export async function assertNoSkillLeak(page, manifest) {
  const timeline = page.getByTestId("v4-timeline");
  const started = Date.now();
  const deadline = started + 90_000;
  const visited = new Set();
  const scroll = (reset, lastIndex) =>
    scrollTimelineViewport(timeline, { reset, lastIndex, fraction: 0.5 });
  console.log("Native skill leak scan: start");
  await scroll(true);
  for (;;) {
    assert.ok(Date.now() < deadline, "Skill leak history scan exceeded 90s");
    // 宿主 yield 不是提交证据；必须同时检查真实起点几何、following 与首索引。
    await settleTimelineLayout();
    const state = await readTimelineViewport(timeline, { includeText: true });
    if (
      visited.size === 0 &&
      (state.top !== 0 ||
        (state.height > state.viewport && state.following !== "false") ||
        (state.count > 0 && !state.indices.includes(0)))
    ) {
      await scroll(true);
      continue;
    }
    for (const skill of manifest.skills)
      assert.ok(
        !state.text.includes(skill.sentinel),
        `Visible skill body leaked: ${skill.scope}/${skill.name}`,
      );
    assert.ok(!/<skill-prompt>|<\/skill-prompt>/u.test(state.text), "Skill prompt tags leaked");
    for (const index of state.indices) visited.add(index);
    if (state.bottom && (state.count === 0 || state.indices.includes(state.count - 1))) {
      assert.ok(
        Array.from({ length: state.count }, (_, index) => index).every((index) =>
          visited.has(index),
        ),
        "Skill leak scan must inspect every virtual timeline unit, in full",
      );
      break;
    }
    await scroll(false, state.indices.at(-1));
  }
  console.log(
    `Native skill leak scan: complete units=${visited.size} elapsedMs=${Date.now() - started}`,
  );
}
function displaySkillName(name) {
  return name
    .split("-")
    .map((part) => part[0].toUpperCase() + part.slice(1))
    .join(" ");
}

async function skillCandidates(list) {
  await list.getByRole("option").first().waitFor({ state: "visible" });
  const rows = new Map();
  await list.evaluate((element) => {
    element.scrollTop = 0;
  });
  const deadline = Date.now() + 90_000;
  for (;;) {
    assert.ok(Date.now() < deadline, "Skill candidate scan exceeded 90s");
    await settleTimelineLayout();
    const mounted = await list.getByRole("option").evaluateAll((nodes) =>
      nodes.map((node) => ({
        id: node.getAttribute("data-option-id"),
        index: Number(node.getAttribute("data-option-index")),
        name: node
          .querySelector(":scope > span > span:first-of-type")
          .textContent.trim()
          .replace(/^\/skill:/u, ""),
        description: node.querySelector(":scope > span > span:last-of-type").textContent.trim(),
        disabled: node.getAttribute("aria-disabled"),
      })),
    );
    assert.equal(new Set(mounted.map((row) => row.index)).size, mounted.length);
    for (const row of mounted) {
      assert.ok(
        row.id && row.name,
        "Every mounted candidate must expose its identity and visible name",
      );
      assert.equal(row.disabled, "false", "The real callable skill must be selectable");
      if (rows.has(row.index)) assert.deepEqual(rows.get(row.index), row);
      else rows.set(row.index, row);
    }
    const finished = await list.evaluate((element) => {
      if (element.scrollTop + element.clientHeight >= element.scrollHeight - 1) return true;
      element.scrollTop += Math.max(1, element.clientHeight / 2);
      return false;
    });
    if (finished) break;
  }
  const candidates = [...rows.values()].sort((a, b) => a.index - b.index);
  assert.deepEqual(
    candidates.map((row) => row.index),
    candidates.map((_, index) => index),
  );
  assert.equal(new Set(candidates.map((row) => row.id)).size, candidates.length);
  return candidates;
}

export async function skillCatalogParity(page, runtime, manifest) {
  const data = await diagnostics(runtime);
  const callsBefore = data.calls.length;
  const input = page.getByTestId("v4-composer-input");
  const draftBefore = await input.evaluate((element) => element.innerHTML);
  // 设置页只呈现 skills.md 规定的 OMP 可调用技能；其他 scope 的发现项不进入此列表。
  const expected = [...manifest.expectedSkillNames].sort();
  assert.equal(new Set(expected).size, expected.length, "OMP resolves shadowed skills once");
  for (const name of manifest.expectedSkillNames)
    assert.ok(expected.includes(name), `Real OMP must retain ${name}`);
  await page.getByRole("button", { name: "设置", exact: true }).last().click();
  const settingsPage = page.getByTestId("settings-page");
  await settingsPage.waitFor({ state: "visible" });
  await settingsPage.getByRole("button", { name: "技能", exact: true }).click();
  const settings = settingsPage.getByTestId("omp-available-skills");
  await settings.waitFor({ state: "visible" });
  await settings.getByRole("button", { name: "刷新", exact: true }).click();
  const readNames = () =>
    settings
      .locator("[data-omp-skill-name] > div:first-child")
      .evaluateAll((nodes) => nodes.map((node) => node.textContent.trim()).sort());
  await eventually(
    readNames,
    (names) => names.length === expected.length,
    "settings skill catalog",
  );
  assert.deepEqual(
    await readNames(),
    expected,
    "Settings must use the exact real OMP callable set",
  );
  assert.equal(await settings.getByRole("switch").count(), 0);
  assert.equal(
    await settings.getByRole("button", { name: /安装|导入|删除|卸载/u }).count(),
    0,
    "Skill settings are read-only, not a second scanner",
  );
  for (const name of expected) {
    const command = data.acceptance.catalog.find((item) => item.name === `skill:${name}`);
    assert.ok(command, `OMP callable catalog must include ${name}`);
    const row = settings.locator("[data-omp-skill-name]").filter({
      has: page.getByText(name, { exact: true }),
    });
    assert.equal(await row.count(), 1, `One Settings row for the OMP callable ${name}`);
    assert.equal(
      await row.evaluate((node) => node.children[1]?.textContent ?? ""),
      command.description ?? "",
      "Settings must preserve the real resolved source description",
    );
  }
  for (const skill of manifest.skills) {
    const selected = data.acceptance.catalog.find(
      (command) => command.name === `skill:${skill.name}`,
    );
    assert.equal(
      (await settings.innerText()).includes(skill.description),
      selected.description === skill.description,
      `Settings must expose only the selected ${skill.scope}/${skill.name} discovery`,
    );
  }
  await settingsPage.getByTestId("settings-back-button").click();
  await settingsPage.waitFor({ state: "hidden" });
  await page.getByTestId("v4-composer-input").waitFor({ state: "visible" });
  assert.equal(
    await input.evaluate((element) => element.innerHTML),
    draftBefore,
    "Read-only Settings navigation must not consume or replace the current rich draft",
  );
  for (const prefix of ["$", "/skill:"]) {
    await input.fill(prefix);
    const list = page.getByRole("listbox");
    await list.waitFor({ state: "visible" });
    // MentionPanel virtualizes options; compare the entire scroll range, not only mounted rows.
    const candidates = await skillCandidates(list);
    assert.deepEqual(
      candidates.map((row) => row.name).sort(),
      expected,
      `${prefix} must agree with the same target OMP, including shadowing`,
    );
    for (const row of candidates) {
      const command = data.acceptance.catalog.find((item) => item.name === `skill:${row.name}`);
      assert.equal(
        row.description,
        command.description ? `omp · ${command.description}` : "omp",
        `${prefix}${row.name} must retain the actual resolved source description`,
      );
    }
    await page.keyboard.press("Escape");
  }
  await input.fill("");
  assert.equal(
    (await diagnostics(runtime)).calls.length,
    callsBefore,
    "Settings, refresh and both skill candidate surfaces must remain model-free",
  );
  return expected;
}
async function pickSkill(page, prefix, name, before, after) {
  const input = page.getByTestId("v4-composer-input");
  await input.fill(`${before}${prefix}${name}`);
  await page
    .getByRole("listbox")
    .getByRole("option")
    .filter({ has: page.getByText(prefix === "$" ? name : `/skill:${name}`, { exact: true }) })
    .click();
  await input.press("End");
  await page.keyboard.insertText(after);
  const rich = await input.evaluate((element) => ({
    html: element.innerHTML,
    text: element.textContent,
  }));
  assert.deepEqual(
    await input.locator("[data-mention-id]").evaluateAll((nodes) =>
      nodes.map((node) => ({
        id: node.getAttribute("data-mention-id"),
        category: node.getAttribute("data-mention-category"),
        text: node.textContent,
      })),
    ),
    [{ id: `skill:omp:skill:${name}`, category: "skills", text: name }],
    "Selection must create exactly the real OMP skill node, not a styled plain-text substitute",
  );
  return rich;
}

export async function exerciseInitialDraft(page, runtime, manifest, before, input) {
  const { paths, values } = manifest;
  // 原生首发必须迁移完整富草稿与真实附件；只比纯文本会漏掉 chip/ref 被清空的问题。
  const rich = await pickSkill(
    page,
    "$",
    "native-project",
    `${values.draft} `,
    " draft-argument-731",
  );
  await page.locator('input[type="file"]').setInputFiles(paths.attachment);
  await page.getByText("native-draft.txt", { exact: true }).waitFor({ state: "visible" });
  await orchestrate(page, runtime, "/goal", "查看目标");
  await visibleText(page, "No goal set.");
  await idle(page);
  assert.equal(
    (await diagnostics(runtime)).calls.length,
    0,
    "Native-first show must not submit composer draft/skill/attachment",
  );
  const mainTask = await canonicalTask(page, before);
  assert.deepEqual(
    await input.evaluate((element) => ({ html: element.innerHTML, text: element.textContent })),
    rich,
  );
  // Electron 此构建的 CDP Input 点击回执会挂起，但同页 Runtime.evaluate 耗时 1–11ms；
  // 诊断确认 DOM click 可选中任务，因此在验收中由 renderer 派发点击并检查 active 态。
  await page.evaluate((id) => document.querySelector(`[data-testid="${id}"]`)?.click(), mainTask);
  await page.getByTestId(mainTask).waitFor({ state: "visible" });
  assert.ok(
    await page
      .getByTestId(mainTask)
      .evaluate((element) => element.classList.contains("bg-selected")),
    "DOM-dispatched click must select the canonical task",
  );
  assert.deepEqual(
    await input.evaluate((element) => ({ html: element.innerHTML, text: element.textContent })),
    rich,
    "Clicking canonical UUID must retain rich nodes, not just draft text",
  );
  assert.equal(await page.getByText("native-draft.txt", { exact: true }).count(), 1);
  await page.getByTestId("v4-composer-send").click();
  await visibleText(page, "NATIVE_ATTACHMENT_CONSUMED_731");
  await idle(page);
  assert.deepEqual(
    await input.evaluate((element) => ({
      text: element.textContent,
      mentions: element.querySelectorAll("[data-mention-id]").length,
    })),
    { text: "", mentions: 0 },
    "Accepted send must clear all literal draft text and rich skill nodes, not rendered paragraph spacing",
  );
  assert.equal(
    await page.getByText("native-draft.txt", { exact: true }).count(),
    0,
    "Ordinary send consumes the migrated attachment once",
  );
  assert.deepEqual(
    (await taskIds(page)).filter((id) => !before.includes(id)),
    [mainTask],
  );
  const draftCall = (await diagnostics(runtime)).calls;
  assert.equal(draftCall.length, 1);
  assert.ok(JSON.stringify(draftCall[0].messages).includes(values.attachment.trim()));
  return mainTask;
}

export async function exerciseSkills(page, runtime, manifest) {
  const { values } = manifest;
  const names = await skillCatalogParity(page, runtime, manifest);
  await send(page, "NATIVE_SKILL_BEFORE_731", "NATIVE_SKILL_BEFORE_REPLY_731");
  await pickSkill(
    page,
    "$",
    "native-project",
    "Please inspect ",
    " skill-argument-731 and retain this context",
  );
  await page.getByTestId("v4-composer-send").click();
  await visibleText(page, "NATIVE_PROJECT_READ_DONE_731");
  await idle(page);
  await assertToolResult(page, runtime, "skill-native-project", values.read.trim());
  await timelineContains(page, /skill-argument-731 and retain this context/u);
  await timelineContains(page, new RegExp(`^${displaySkillName("native-project")}$`, "u"));
  await assertNoSkillLeak(page, manifest);
  await send(page, "NATIVE_SKILL_AFTER_731", "NATIVE_SKILL_AFTER_REPLY_731");
  await pickSkill(page, "/skill:", "native-collision", "", " skill-collision-731");
  // Electron 这条 CDP Input 点击回执会挂起；DOM click 派发后应用已正常接收请求。
  await page.evaluate(() => document.querySelector('[data-testid="v4-composer-send"]')?.click());
  await visibleText(page, "NATIVE_COLLISION_READ_DONE_731");
  await idle(page);
  await assertToolResult(page, runtime, "skill-native-collision", values.read.trim());
  await timelineContains(page, new RegExp(`^${displaySkillName("native-collision")}$`, "u"));
  await assertNoSkillLeak(page, manifest);
  for (const [name, argument] of [
    ["native-user", "skill-user-731"],
    ["native-shared", "skill-shared-731"],
  ]) {
    await pickSkill(page, "$", name, "", ` ${argument}`);
    await page.evaluate(() => document.querySelector('[data-testid="v4-composer-send"]')?.click());
    await visibleText(page, `${name.toUpperCase().replaceAll("-", "_")}_READ_DONE_731`);
    await idle(page);
    await assertToolResult(page, runtime, `skill-${name}`, values.read.trim());
    await timelineContains(page, new RegExp(`^${displaySkillName(name)}$`, "u"));
    await timelineContains(page, new RegExp(argument, "u"));
    await assertNoSkillLeak(page, manifest);
  }
  return names;
}

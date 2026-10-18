import assert from "node:assert/strict";
import { reveal } from "./ompMockInteractions.assertions.mjs";

export function assertRecordedChildModel(messages, name) {
  const assistants = messages.filter((message) => message.role === "assistant");
  assert.ok(assistants.length > 0, `Child ${name} requires actual persisted assistant evidence`);
  const modelId = name === "b" ? "scripted-alt" : "scripted";
  for (const assistant of assistants) {
    assert.equal(assistant.provider, "zcode-mock", `Child ${name} must use the isolated provider`);
    assert.equal(
      assistant.model,
      modelId,
      `Child ${name}'s persisted execution must match its actual assigned model`,
    );
  }
  return `${assistants[0].provider}/${assistants[0].model}`;
}

export function observedChildModels(children, observed) {
  return children.map((child) => {
    const model = observed.children[child.name]?.model;
    assert.equal(model, `zcode-mock/${child.name === "b" ? "scripted-alt" : "scripted"}`);
    return { ...child, model };
  });
}

async function assertModelLabel(scope, child) {
  assert.equal(child.model, `zcode-mock/${child.name === "b" ? "scripted-alt" : "scripted"}`);
  const escaped = child.model.replace(/[.*+?^${}()|[\]\\]/gu, "\\$&");
  const label = scope.getByText(new RegExp(`^(?:模型[：:]\\s*|Model:\\s*)${escaped}$`, "u"));
  await label.waitFor({ state: "visible" });
  assert.equal(await label.count(), 1, "One visible full actual model label per own child surface");
  assert.equal(
    await label.getAttribute("title"),
    await label.innerText(),
    "The full provider/model must remain readable even when its compact label is truncated",
  );
}

export async function assertCardModel(page, child, parentId) {
  const route = `omp-subagent:${child.rawId}@${parentId ?? child.liveParent}`;
  const open = page.getByTestId(`v4-subagent-open-side-pane-${route}`);
  await reveal(page, open);
  assert.equal(await open.count(), 1);
  const card = open.locator("xpath=ancestor::*[@data-tool-call-id][1]");
  assert.equal(await card.getAttribute("data-tool-call-id"), `omp-subagent:${child.rawId}`);
  const row = open.locator("xpath=ancestor::*[@data-row-id][1]");
  assert.equal(await row.count(), 1, "The actual child opener must own its model-bearing row");
  await assertModelLabel(row, child);
}

export async function assertRunningModel(page, panel, child) {
  const row = panel.locator(`[data-child-session-id="${child.route}"][data-work-status="running"]`);
  assert.equal(
    await row.count(),
    1,
    "Every running status row must retain its exact actual child identity",
  );
  await assertModelLabel(row, child);
  await assertCardModel(page, child);
}

export async function assertDetailModel(pane, child) {
  const controls = pane.locator("[data-subagent-control-state]");
  await controls.waitFor({ state: "visible" });
  assert.equal(await controls.count(), 1);
  await assertModelLabel(controls, child);
}

export async function assertDirectoryModels(page, directory, children, parentId) {
  const owners = [...new Set([parentId, ...children.map((child) => child.liveParent)])];
  const directoryTab = page.locator(
    owners
      .map(
        (owner) =>
          `[data-side-pane-tab-type="subagent-directory"][data-side-pane-tab-id$=":${encodeURIComponent(owner)}"]`,
      )
      .join(","),
  );
  assert.equal(await directoryTab.count(), 1, "The ended directory must belong to this parent");
  for (const child of children) {
    const row = directory.getByRole("button").filter({
      has: page.getByText(new RegExp(`\\bAGENTS_CHILD_${child.name}\\b`, "u")),
    });
    await row.waitFor({ state: "visible" });
    assert.equal(await row.count(), 1, "Exactly one ended row must own the real assignment");
    await assertModelLabel(row, child);
    await row.click();
    const pane = page
      .getByRole("tabpanel")
      .and(page.locator('[data-state="active"]'))
      .locator(`[data-subagent-session-id^="omp-subagent:${child.rawId}@"]`);
    await pane.waitFor({ state: "visible" });
    assert.equal(await pane.count(), 1, "The directory must open this exact raw child once");
    assert.ok(
      owners
        .map((owner) => `omp-subagent:${child.rawId}@${owner}`)
        .includes(await pane.getAttribute("data-subagent-session-id")),
      "The real directory route must retain a previously proven parent identity",
    );
    await assertDetailModel(pane, child);
    await directoryTab.click();
    await directory.waitFor({ state: "visible" });
  }
}

export async function assertEndedModels(page, panel, children, parentId) {
  await panel.getByRole("button", { name: /^(?:已结束|Ended)\s+5$/u }).click();
  const directory = page
    .getByRole("tabpanel")
    .and(page.locator('[data-state="active"]'))
    .filter({ has: page.getByRole("heading", { name: /^(?:子智能体目录|Subagents)$/u }) });
  await directory.waitFor({ state: "visible" });
  await assertDirectoryModels(page, directory, children, parentId);
}

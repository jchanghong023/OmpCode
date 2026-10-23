import { access, readFile, rm, stat, writeFile } from "node:fs/promises";
import { resolve } from "node:path";
import { TID_V4_SESSION_PANE, TID_V4_STOP, testId } from "@zcode/shared/test-ids";
import { DEFAULT_WORKSPACE } from "./helpers/desktop-app.js";
import { startDraftFromProject } from "./helpers/project-sidebar.js";
import { waitForPermissionInteractionId } from "./helpers/permission-interaction-id.js";
import {
  OMP_MODEL_ID,
  OMP_PROVIDER_ID,
  type ModelRequest,
} from "./helpers/omp-integration-fixture.js";
import {
  V4_MAIN_PANE_ID,
  getV4PaneSnapshot,
  prepareV4ConversationE2E,
  selectV4TaskById,
  sendV4Prompt,
  switchV4Mode,
  switchV4Model,
  waitForV4PermissionDialogInComposerDock,
  waitForV4TimelineContaining,
} from "./helpers/v4-conversation.js";

const paneSelector = `[data-testid="${testId(TID_V4_SESSION_PANE, V4_MAIN_PANE_ID)}"]`;
const permissionSelector =
  '[role="listbox"][aria-label="Permission required"], [role="listbox"][aria-label="需要权限"]';
const file = (name: string, index = 1) =>
  resolve(DEFAULT_WORKSPACE, `omp-permission-${name}-${index}.txt`);
const absent = async (path: string) =>
  access(path).then(
    () => false,
    (error: NodeJS.ErrnoException) => {
      if (error.code !== "ENOENT") throw error;
      return true;
    },
  );
async function requests(): Promise<ModelRequest[]> {
  const url = process.env.OMP_E2E_PROVIDER_URL;
  if (!url || new URL(url).hostname !== "127.0.0.1")
    throw new Error("Isolated OMP provider required");
  const response = await fetch(`${url}/__requests`);
  if (!response.ok) throw new Error(`Provider ledger: ${response.status}`);
  return response.json() as Promise<ModelRequest[]>;
}
async function sessionId() {
  let id: string | null = null;
  await browser.waitUntil(
    async () => {
      id = await $(paneSelector).getAttribute("data-session-id");
      return Boolean(id && id !== "draft");
    },
    { timeout: 30000, timeoutMsg: "Native permission session did not bind" },
  );
  return id!;
}
async function draft() {
  await startDraftFromProject(DEFAULT_WORKSPACE);
  await switchV4Model(OMP_PROVIDER_ID, OMP_MODEL_ID, "disabled");
  await switchV4Mode("guarded");
}
async function pending(name: string, index = 1) {
  const dock = await waitForV4PermissionDialogInComposerDock();
  expect(dock.inDock).toBe(true);
  expect(await absent(file(name, index))).toBe(true);
  const interaction = await waitForPermissionInteractionId(`OMP permission ${name}:${index}`);
  await browser.saveScreenshot(
    resolve(process.env.ZCODE_E2E_ARTIFACT_DIR!, `omp-permission-${name}-${index}-pending.png`),
  );
  return interaction;
}
async function answer(kind: "allowOnce" | "reject") {
  const selector =
    kind === "reject"
      ? '[data-permission-option-kind^="reject"]'
      : '[data-permission-option-kind="allowOnce"]';
  const option = $(permissionSelector).$(selector);
  await option.waitForClickable({ timeout: 15000 });
  // WebDriver 点击会先聚焦；PermissionDialog 的 onFocus 先选中该项，
  // 随后的 onClick 已提交，因此不能按点击前的 aria-selected 再补点旧按钮。
  await option.click();
}
async function idle() {
  await browser.waitUntil(
    async () => {
      const stop = $(paneSelector).$(`[data-testid="${TID_V4_STOP}"]`);
      return !(await stop.isExisting());
    },
    { timeout: 30000, timeoutMsg: "Native permission execution did not settle" },
  );
}
async function prepare() {
  await prepareV4ConversationE2E({ skipProvider: true });
  await switchV4Model(OMP_PROVIDER_ID, OMP_MODEL_ID, "disabled");
  await switchV4Mode("guarded");
}

describe("OMP native permission / real Desktop Host and file tool", () => {
  before(async () => {
    // 只清理本 spec 拥有的隔离产物，不 seed 会话、运行或权限状态。
    for (const name of ["allow", "deny", "stop", "refresh"]) {
      for (const index of [1, 2]) await rm(file(name, index), { force: true });
    }
  });
  afterEach(async function () {
    const name = this.currentTest!.title.replace(/[^a-z0-9-]/giu, "-").slice(0, 100);
    await writeFile(
      resolve(process.env.ZCODE_E2E_ARTIFACT_DIR!, `${name}-provider-requests.json`),
      JSON.stringify(await requests(), null, 2),
    );
    await browser.saveScreenshot(resolve(process.env.ZCODE_E2E_ARTIFACT_DIR!, `${name}.png`));
  });

  it("OMP-P01: zero writes before approval; Allow once writes exactly once and the next write asks again", async function () {
    this.timeout(90000);
    await prepare();
    await sendV4Prompt("OMP_E2E_PERMISSION_ALLOW");
    const first = await pending("allow");
    expect(await absent(file("allow", 2))).toBe(true);
    await answer("allowOnce");
    await browser.waitUntil(async () => !(await absent(file("allow"))), { timeout: 30000 });
    expect(await readFile(file("allow"), "utf8")).toBe("OMP_E2E_PERMISSION_ALLOW:1\n");
    const committed = await stat(file("allow"));
    const second = await pending("allow", 2);
    expect(second).not.toBe(first);
    await answer("reject");
    await waitForV4TimelineContaining("OMP_E2E_PERMISSION_ALLOW_DONE", 30000);
    await idle();
    expect(await absent(file("allow", 2))).toBe(true);
    expect((await stat(file("allow"))).mtimeMs).toBe(committed.mtimeMs);
    const completed = (await requests()).find(
      (request) =>
        request.messages.some((message) => message.role === "tool") &&
        JSON.stringify(request.messages).includes("omp-permission-allow-2.txt"),
    );
    expect(completed).toBeDefined();
    expect(
      completed!.messages.filter(
        (message) =>
          message.role === "assistant" &&
          JSON.stringify(message).includes("omp-permission-allow-1.txt"),
      ),
    ).toHaveLength(1);
  });

  it("OMP-P02: native deny returns a tool result without creating the file", async function () {
    this.timeout(60000);
    await prepare();
    await sendV4Prompt("OMP_E2E_PERMISSION_DENY");
    await pending("deny");
    await answer("reject");
    await waitForV4TimelineContaining("OMP_E2E_PERMISSION_DENY_DONE", 30000);
    await idle();
    expect(await absent(file("deny"))).toBe(true);
  });

  it("OMP-P03: Stop cancels approval and a late click on the old GUI option cannot write", async function () {
    this.timeout(60000);
    await prepare();
    await sendV4Prompt("OMP_E2E_PERMISSION_STOP");
    await pending("stop");
    // 只保留真实 DOM 按钮来模拟迟到点击，不读取 React 私有状态、不调用服务应答。
    await browser.execute(() => {
      Reflect.set(
        window,
        "ompPermissionLateButton",
        document.querySelector('[data-permission-option-kind="allowOnce"]'),
      );
    });
    // 权限 dock 隐藏 composer；使用正式 GUI 的 Esc Stop 快捷键。
    await browser.keys("Escape");
    await $(permissionSelector).waitForExist({ reverse: true, timeout: 30000 });
    await idle();
    await browser.execute(() => {
      const button: unknown = Reflect.get(window, "ompPermissionLateButton");
      if (button instanceof HTMLButtonElement) button.click();
      Reflect.deleteProperty(window, "ompPermissionLateButton");
    });
    await draft();
    await sendV4Prompt("OMP_E2E_PERMISSION_OTHER");
    await waitForV4TimelineContaining("OMP_E2E_PERMISSION_OTHER_DONE", 30000);
    await idle();
    expect(await absent(file("stop"))).toBe(true);
  });

  it("OMP-P04: another session completes while A waits; view switching and refresh never bypass approval", async function () {
    this.timeout(120000);
    await prepare();
    await sendV4Prompt("OMP_E2E_PERMISSION_REFRESH");
    const owner = await sessionId();
    const interaction = await pending("refresh");
    await draft();
    await sendV4Prompt("OMP_E2E_PERMISSION_OTHER");
    expect(await sessionId()).not.toBe(owner);
    await waitForV4TimelineContaining("OMP_E2E_PERMISSION_OTHER_DONE", 30000);
    await idle();
    expect(await absent(file("refresh"))).toBe(true);
    await selectV4TaskById(owner);
    expect(await pending("refresh")).toBe(interaction);
    const requestFloor = (await requests()).length;
    await browser.refresh();
    await selectV4TaskById(owner);
    // 连接关闭会以 denied tool result 结束审批，然后模型仍可正常输出终态；
    // 不能仅凭 Stop 消失或要求整轮一定显示 stopped 来判定取消。
    await browser.waitUntil(
      async () => {
        if (await $(permissionSelector).isExisting()) return true;
        const state = await getV4PaneSnapshot();
        if (
          state.sessionId !== owner ||
          state.canStop ||
          !state.timelineText.includes("OMP_E2E_PERMISSION_REFRESH_DONE")
        )
          return false;
        return (await requests())
          .slice(requestFloor)
          .some(
            (request) =>
              JSON.stringify(request.messages).includes("omp-permission-refresh-1.txt") &&
              request.messages.some(
                (message) =>
                  message.role === "tool" &&
                  typeof message.content === "string" &&
                  /^Tool call denied by user: _?write\b/u.test(message.content),
              ),
          );
      },
      { timeout: 30000, timeoutMsg: "Refresh neither restored permission nor cancelled execution" },
    );
    expect(await absent(file("refresh"))).toBe(true);
    if (await $(permissionSelector).isExisting()) {
      expect(await pending("refresh")).toBe(interaction);
      await answer("reject");
      await waitForV4TimelineContaining("OMP_E2E_PERMISSION_REFRESH_DONE", 30000);
    }
    await idle();
    expect(await absent(file("refresh"))).toBe(true);
  });
});

import { resolve } from "node:path";
import { readFile, readdir, writeFile } from "node:fs/promises";
import { parseDocument } from "yaml";
import { ompTeamRunSchema, type OmpTeamRun } from "@zcode/shared";
import {
  TID_TASK_ITEM,
  TID_V4_COMPOSER_INPUT,
  TID_V4_SESSION_PANE,
  testId,
} from "@zcode/shared/test-ids";
import { DEFAULT_WORKSPACE } from "./helpers/desktop-app.js";
import { startDraftFromProject } from "./helpers/project-sidebar.js";
import {
  prepareV4ConversationE2E,
  getV4ConversationState,
  getV4PaneSnapshot,
  V4_MAIN_PANE_ID,
  sendV4Prompt,
  switchV4Mode,
  switchV4Model,
  waitForV4AssistantMessageContaining,
  waitForV4Pane,
} from "./helpers/v4-conversation.js";
import {
  OMP_MODEL_ID,
  OMP_PROVIDER_ID,
  type ModelRequest,
} from "./helpers/omp-integration-fixture.js";
import { restartIntoWorkspacePreservingProfile } from "./helpers/model-provider-restart-runtime.js";
import { setPluginPresentation } from "./helpers/plugin-management-lifecycle.js";

// SidePane 的旧 run tab 会 forceMount 保留；详情与取消必须命中当前活动 tab。
const tid = (id: string) =>
  $(
    `${id === "omp-team-details" || id === "omp-team-stop" ? '[role="tabpanel"][data-state="active"] ' : ""}[data-testid="${id}"]`,
  );
async function click(id: string) {
  const control = tid(id);
  await control.waitForDisplayed({ timeout: 30000 });
  await control.scrollIntoView();
  await control.waitForClickable({ timeout: 15000 });
  await control.click();
}
async function readTeamDetailsShell() {
  return browser.execute(() => {
    const details = document.querySelector(
      '[role="tabpanel"][data-state="active"] [data-testid="omp-team-details"]',
    );
    const frame = details?.closest("[data-workspace-side-frame]");
    const panel = frame?.parentElement;
    const rect = panel?.getBoundingClientRect();
    const opacity = panel ? getComputedStyle(panel).opacity : null;
    return {
      // AnimatedSidePanePanel 常驻详情 DOM；仅子节点 displayed 不能证明外层未被裁切。
      expanded: Boolean(
        frame?.getAttribute("aria-hidden") === "false" &&
        rect &&
        rect.width > 1 &&
        rect.height > 1 &&
        rect.right > 0 &&
        rect.left < window.innerWidth &&
        opacity === "1",
      ),
      collapsed: Boolean(
        frame?.getAttribute("aria-hidden") === "true" && rect && rect.width <= 1 && opacity === "0",
      ),
    };
  });
}
async function waitForTeamDetailsExpanded() {
  await browser.waitUntil(async () => (await readTeamDetailsShell()).expanded, {
    timeout: 30000,
    timeoutMsg: "Team details did not expand into the visible workspace panel",
  });
}
async function closeTeamDetails() {
  // 收起控件由 workspace shell 持有，不属于 Team 详情；先证明已展开，再实际点击公共收起按钮。
  // 禁止把已折叠当成关闭成功，否则无法覆盖运行中关闭详情但不取消讨论的验收。
  await waitForTeamDetailsExpanded();
  const control = $(
    '[data-testid="side-pane-toggle"][aria-label="收起侧边面板"], ' +
      '[data-testid="side-pane-toggle"][aria-label="Collapse side pane"]',
  );
  await control.waitForDisplayed({ timeout: 30000 });
  await control.waitForClickable({ timeout: 15000 });
  await control.click();
  await browser.waitUntil(async () => (await readTeamDetailsShell()).collapsed, {
    timeout: 30000,
    timeoutMsg: "Team details shell did not collapse to its hidden zero-width panel",
  });
}
async function screenshot(name: string) {
  await browser.saveScreenshot(resolve(process.env.ZCODE_E2E_ARTIFACT_DIR!, `${name}.png`));
}
async function screenshotPresentationVariants(name: string, focusTestId: string) {
  const original = await browser.execute(() => ({
    locale: (localStorage.getItem("zcode-locale-preference") === "en-US" ||
    (localStorage.getItem("zcode-locale-preference") !== "zh-CN" &&
      !navigator.language.startsWith("zh"))
      ? "en-US"
      : "zh-CN") as "en-US" | "zh-CN",
    theme: (document.documentElement.classList.contains("theme-zai-light")
      ? "zai-light"
      : "zai-dark") as "zai-light" | "zai-dark",
    width: window.innerWidth,
    height: window.innerHeight,
  }));
  const teamJobId = (await readTeamDetailsShell()).expanded
    ? await tid("omp-team-details").getAttribute("data-team-job-id")
    : null;
  const assertPageFits = async () => {
    const layout = await browser.execute(() => {
      const page =
        document.querySelector<HTMLElement>('[data-testid="omp-team-details"]') ??
        document.querySelector<HTMLElement>('[data-testid="omp-team-page"]');
      return {
        clientWidth: page?.clientWidth ?? 0,
        scrollWidth: page?.scrollWidth ?? 0,
        viewportWidth: window.innerWidth,
        documentWidth: document.documentElement.scrollWidth,
      };
    });
    expect(layout.clientWidth).toBeGreaterThan(0);
    expect(layout.scrollWidth).toBeLessThanOrEqual(layout.clientWidth + 1);
    expect(layout.clientWidth).toBeLessThanOrEqual(layout.viewportWidth);
    expect(layout.documentWidth).toBeLessThanOrEqual(layout.viewportWidth + 1);
  };
  try {
    await setPluginPresentation({ ...original, theme: "zai-light" });
    await tid(focusTestId).scrollIntoView({ block: "start" });
    await assertPageFits();
    await screenshot(`${name}-zai-light`);
    await setPluginPresentation({ ...original, theme: "zai-light", width: 900, height: 720 });
    await tid(focusTestId).scrollIntoView({ block: "start" });
    await assertPageFits();
    await screenshot(`${name}-zai-light-narrow-900x720`);
  } finally {
    await setPluginPresentation(original);
    // 900px 截图会触发响应式收起，恢复尺寸不会恢复 owner 的展开状态。
    // 通过原 Team 卡片的公开详情入口恢复，而非把常驻详情 DOM 误判为展开或重复点击关闭。
    if (teamJobId) {
      await $(
        `[data-testid="omp-team-chat-card"][data-job-id="${teamJobId}"] [data-testid="workflow-card-open-details"]`,
      ).click();
      await waitForTeamDetailsExpanded();
    }
  }
}
async function requests(): Promise<ModelRequest[]> {
  const url = process.env.OMP_E2E_PROVIDER_URL;
  if (!url || new URL(url).hostname !== "127.0.0.1")
    throw new Error("Isolated scripted native Team provider required");
  const response = await fetch(`${url}/__requests`);
  if (!response.ok) throw new Error(`Provider ledger ${response.status}`);
  return response.json() as Promise<ModelRequest[]>;
}

async function nativeSessionFiles(profile: string): Promise<string[]> {
  try {
    return (await readdir(resolve(profile, "sessions"), { recursive: true }))
      .filter((path) => path.endsWith(".jsonl"))
      .sort();
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
    return [];
  }
}

async function nativeCompletedTeamRun(
  profile: string,
  sessionId: string,
  jobId: string,
): Promise<OmpTeamRun> {
  // 读取真实父会话持久化的原生观测，不通过 GUI store/service 注入或重写 Team resolver。
  const files = await nativeSessionFiles(profile);
  const journal = files.find((path) => path.endsWith(`_${sessionId}.jsonl`));
  if (!journal) throw new Error(`Native Team parent journal missing: ${sessionId}`);
  const source = await readFile(resolve(profile, "sessions", journal), "utf8");
  const entries = source
    .split("\n")
    .filter((line) => line.trim())
    .map(
      (line) =>
        JSON.parse(line) as {
          type: string;
          customType?: string;
          data?: { version?: number; run?: OmpTeamRun };
        },
    );
  const entry = entries.findLast(
    (entry) =>
      entry.type === "custom" &&
      entry.customType === "zcode_team_observation_v1" &&
      entry.data?.version === 1 &&
      entry.data.run?.sessionId === sessionId &&
      entry.data.run.jobId === jobId &&
      entry.data.run.status === "completed",
  );
  if (!entry?.data?.run) throw new Error(`Completed native Team observation missing: ${jobId}`);
  return ompTeamRunSchema.parse(entry.data.run);
}

async function openTeamSettings() {
  await click("omp-team-sidebar-open");
  await tid("omp-team-page").waitForDisplayed({ timeout: 30000 });
  await tid("omp-team-panel").waitForDisplayed({ timeout: 30000 });
  expect(await $('[data-testid="omp-configuration-panel"][role="dialog"]').isExisting()).toBe(
    false,
  );
}

async function selectedTeamMembers(): Promise<unknown[]> {
  await tid("omp-team-member-1").$("select").waitForDisplayed({ timeout: 30000 });
  const members = await $$('[data-testid^="omp-team-member-"] select');
  return Promise.all(
    Array.from(members).map(async (select) => JSON.parse(await select.getValue()) as unknown),
  );
}

describe("OMP native Team / global settings and current conversation", () => {
  it("configures without a session, shares duplicate slots across sessions, discusses, cancels and restores without rerunning", async () => {
    await prepareV4ConversationE2E({ skipProvider: true });
    const profile = process.env.PI_CODING_AGENT_DIR;
    if (!profile) throw new Error("Isolated OMP profile missing");
    expect((await getV4PaneSnapshot()).sessionId).toBe("draft");
    const sessionsBeforeConfiguration = await nativeSessionFiles(profile);
    const requestsBeforeConfiguration = (await requests()).length;
    // 从侧栏无聊天入口编辑全局配置；不能为解禁按钮偷偷创建 native session 或触发模型。
    await openTeamSettings();
    const moreOptions = tid("omp-team-default").parentElement().parentElement().$("summary");
    await moreOptions.click();
    await click("omp-team-default");
    await moreOptions.click();
    // 原生目录按空白分词搜索 provider/id/name；provider/model 是保存 selector，不是目录搜索词。
    await tid("omp-team-model-search").setValue(`${OMP_PROVIDER_ID} ${OMP_MODEL_ID}`);
    const add = tid("omp-team-model-catalog").$(
      `button[data-omp-model-provider="${OMP_PROVIDER_ID}"][data-omp-model-id="${OMP_MODEL_ID}"]`,
    );
    await add.waitForDisplayed({ timeout: 30000 });
    await add.scrollIntoView({ block: "center" });
    await add.waitForClickable({ timeout: 30000 });
    await add.click();
    await click("omp-team-copy-0");
    await tid("omp-team-member-1").waitForDisplayed({ timeout: 15000 });
    await click("omp-team-save");
    await browser.waitUntil(
      async () => (await tid("omp-team-receipt").getAttribute("data-save-state")) === "complete",
      { timeout: 30000, timeoutMsg: "Global Team models were not saved" },
    );
    // 设置页不展示运行预览；执行槽位稍后与真实 /team journal 核对。
    const globalPreview = await browser.execute(() => ({
      text: document.querySelector('[data-testid="omp-team-preview"]')?.textContent ?? "",
      receipt: document.querySelector('[data-testid="omp-team-receipt"]')?.textContent ?? "",
    }));
    await writeFile(
      resolve(process.env.ZCODE_E2E_ARTIFACT_DIR!, "omp-team-native-config-preview.json"),
      JSON.stringify(globalPreview, null, 2),
    );
    await screenshot("omp-team-config-saved");
    await screenshotPresentationVariants("omp-team-config-saved", "omp-team-panel");
    const config = parseDocument(await readFile(resolve(profile, "config.yml"), "utf8")).toJS() as {
      team?: { members?: string[] };
    };
    expect(config.team?.members).toHaveLength(2);
    expect(config.team?.members?.[0]).toBe(config.team?.members?.[1]);
    const savedMembers = await selectedTeamMembers();
    expect(savedMembers).toEqual([
      { provider: OMP_PROVIDER_ID, modelId: OMP_MODEL_ID },
      { provider: OMP_PROVIDER_ID, modelId: OMP_MODEL_ID },
    ]);
    // 初始化夹具可能回收预热会话；配置边界禁止创建新会话，不要求保留预热临时文件。
    expect(
      (await nativeSessionFiles(profile)).filter(
        (path) => !sessionsBeforeConfiguration.includes(path),
      ),
    ).toEqual([]);
    const requestsAfterConfiguration = await requests();
    await writeFile(
      resolve(process.env.ZCODE_E2E_ARTIFACT_DIR!, "omp-team-global-config-without-session.json"),
      JSON.stringify(
        {
          members: config.team?.members,
          nativeSessionsBefore: sessionsBeforeConfiguration,
          nativeSessionsAfter: await nativeSessionFiles(profile),
          modelRequestsBefore: requestsBeforeConfiguration,
          modelRequestsAfter: requestsAfterConfiguration.length,
          modelRequestsDuringConfiguration: requestsAfterConfiguration.slice(
            requestsBeforeConfiguration,
          ),
        },
        null,
        2,
      ),
    );
    expect(requestsAfterConfiguration.length).toBe(requestsBeforeConfiguration);
    await click("omp-config-cancel");
    expect(await tid("omp-team-task").isExisting()).toBe(false);
    expect(await tid("omp-team-start").isExisting()).toBe(false);
    await startDraftFromProject(DEFAULT_WORKSPACE);
    await switchV4Model(OMP_PROVIDER_ID, OMP_MODEL_ID, "disabled");
    await switchV4Mode("yolo");
    await sendV4Prompt("OMP_E2E_TEAM_PARENT_READY");
    // 首轮必须等待真实会话绑定和原生回复，不能提前切页卸载创建会话的 composer。
    await waitForV4AssistantMessageContaining("OMP_E2E_TEAM_PARENT_READY");
    await waitForV4Pane(
      (pane) => Boolean(pane.sessionId && pane.sessionId !== "draft") && !pane.canStop,
      "Native Team parent session did not bind and settle before navigation",
    );
    const parent = await getV4ConversationState();
    if (!parent.taskId || !parent.sessionId) throw new Error("Native Team parent identity missing");
    const reopenParent = async () => {
      await click(testId(TID_TASK_ITEM, parent.taskId!));
      await waitForV4Pane(
        (pane) => pane.sessionId === parent.sessionId,
        "Team run must remain scoped to the original conversation",
      );
      // 原因：sessionId 先随选择态更新，Composer 随后才在 RAF 恢复草稿，
      // 再下一帧回焦；bridge 提前存在不代表可以写入，否则空草稿会覆盖 /team。
      // 先等真实连接解除编辑禁用，再跨过现有恢复/回焦两阶段；只观察，不重写正文。
      await browser.waitUntil(
        async () =>
          browser.executeAsync(
            (paneTestId, inputTestId, sessionId, done) => {
              const readReadyInput = () => {
                const pane = document.querySelector<HTMLElement>(`[data-testid="${paneTestId}"]`);
                const input = pane?.querySelector<HTMLElement>(`[data-testid="${inputTestId}"]`);
                return pane?.dataset.sessionId === sessionId &&
                  pane.dataset.projectionSeq !== "" &&
                  input?.isContentEditable &&
                  input.getAttribute("data-e2e-lexical-bridge") === "ready"
                  ? input
                  : null;
              };
              const input = readReadyInput();
              if (!input) {
                done(false);
                return;
              }
              requestAnimationFrame(() =>
                requestAnimationFrame(() => done(readReadyInput() === input)),
              );
            },
            testId(TID_V4_SESSION_PANE, V4_MAIN_PANE_ID),
            TID_V4_COMPOSER_INPUT,
            parent.sessionId!,
          ),
        {
          timeout: 30000,
          timeoutMsg: "Original Team conversation composer did not finish draft restoration",
        },
      );
    };
    await openTeamSettings();
    expect(await selectedTeamMembers()).toEqual(savedMembers);
    await click("omp-config-cancel");
    await reopenParent();
    // 第二条真实聊天只证明配置共享，不重跑讨论；全局配置读取本身不得产生额外模型调用。
    await startDraftFromProject(DEFAULT_WORKSPACE);
    await switchV4Model(OMP_PROVIDER_ID, OMP_MODEL_ID, "disabled");
    await switchV4Mode("yolo");
    await sendV4Prompt("OMP_E2E_TEAM_SECOND_SESSION_READY");
    await waitForV4AssistantMessageContaining("OMP_E2E_TEAM_SECOND_SESSION_READY");
    await waitForV4Pane(
      (pane) => Boolean(pane.sessionId && pane.sessionId !== "draft") && !pane.canStop,
      "Second real Team settings session did not bind and settle",
    );
    const second = await getV4ConversationState();
    expect(second.sessionId).toBeTruthy();
    expect(second.sessionId).not.toBe(parent.sessionId);
    expect(second.taskId).not.toBe(parent.taskId);
    const requestsBeforeSharedRead = (await requests()).length;
    const sessionsBeforeSharedRead = await nativeSessionFiles(profile);
    await openTeamSettings();
    expect(await selectedTeamMembers()).toEqual(savedMembers);
    expect(await nativeSessionFiles(profile)).toEqual(sessionsBeforeSharedRead);
    expect((await requests()).length).toBe(requestsBeforeSharedRead);
    await screenshot("omp-team-global-config-second-session");
    await click("omp-config-cancel");
    await reopenParent();
    const floor = (await requests()).length;
    const prompt = "/team OMP_E2E_TEAM_COMPLETE: investigate read-only options";
    await sendV4Prompt(prompt);
    const card = $('[data-testid="omp-team-chat-card"][data-status="running"]');
    await card.waitForDisplayed({ timeout: 60000 });
    const completedJobId = await card.getAttribute("data-job-id");
    expect(completedJobId).toBeTruthy();
    expect((await getV4PaneSnapshot()).sessionId).toBe(parent.sessionId);
    // /team 由原生 controlOnly dispatch 留存，问题在卡片标题而非普通 user row。
    // getV4Messages 只读已挂载且有 user/assistant 样式的行，innerText 还包含复制/编辑按钮。
    expect(await card.$('[data-testid="workflow-card-name"]').getText()).toBe(prompt);
    await screenshot("omp-team-running-chat-command");
    await card.$('[data-testid="workflow-card-open-details"]').click();
    await tid("omp-team-details").waitForDisplayed({ timeout: 30000 });
    await waitForTeamDetailsExpanded();
    await browser.waitUntil(
      async () => Array.from(await $$('[data-testid="omp-team-node"]')).length >= 2,
      { timeout: 60000, timeoutMsg: "Native Team never projected independent Agent calls" },
    );
    await screenshot("omp-team-native-stage");
    // 收起只是关闭观测，不得把原生执行的 stop 当作详情关闭。
    await closeTeamDetails();
    expect((await readTeamDetailsShell()).collapsed).toBe(true);
    const completedCard = $(`[data-testid="omp-team-chat-card"][data-job-id="${completedJobId}"]`);
    await browser.waitUntil(
      async () => (await completedCard.getAttribute("data-status")) === "completed",
      { timeout: 120000, timeoutMsg: "Closing Team details cancelled or lost the native run" },
    );
    expect(await completedCard.getText()).toContain(
      "OMP_E2E_TEAM_REPORT: native orchestration completed read-only.",
    );
    await completedCard.$('[data-testid="workflow-card-open-details"]').click();
    await tid("omp-team-details").waitForDisplayed({ timeout: 30000 });
    await waitForTeamDetailsExpanded();
    await screenshotPresentationVariants("omp-team-native-stage", "omp-team-run");
    const nodes = await $$('[data-testid="omp-team-node"]');
    const ids = await Promise.all(
      Array.from(nodes).map((node) => node.getAttribute("data-node-id")),
    );
    expect(new Set(ids).size).toBe(ids.length);
    expect(ids.length).toBeGreaterThanOrEqual(2);
    const nativeRun = await nativeCompletedTeamRun(profile, parent.sessionId, completedJobId!);
    await writeFile(
      resolve(process.env.ZCODE_E2E_ARTIFACT_DIR!, "omp-team-native-completed-run.json"),
      JSON.stringify(nativeRun, null, 2),
    );
    expect(ids.slice().sort()).toEqual(nativeRun.nodes.map((node) => node.id).sort());
    for (const node of nodes) {
      const nodeId = await node.getAttribute("data-node-id");
      const nativeNode = nativeRun.nodes.find((item) => item.id === nodeId);
      expect(nativeNode).toBeDefined();
      expect(await node.getAttribute("data-model")).toBe(nativeNode!.model);
      expect(await node.getAttribute("data-role")).toBe(nativeNode!.role);
    }
    expect(
      await Promise.all(Array.from(nodes).map((node) => node.getAttribute("data-role"))),
    ).toEqual(
      expect.arrayContaining(["proposer", "aligner", "reviewer", "reviser", "synthesizer"]),
    );
    const proposers = await $$('[data-testid="omp-team-node"][data-role="proposer"]');
    // 公共 wire 保留 participants 为 unknown[]；原生 journal 的身份字段必须先实际校验再比较。
    const nativeParticipants = nativeRun.participants.map((item) => {
      if (
        typeof item !== "object" ||
        item === null ||
        !("role" in item) ||
        typeof item.role !== "string" ||
        !("label" in item) ||
        typeof item.label !== "string"
      )
        throw new Error("Native Team participant is missing a string role or label");
      return { role: item.role, label: item.label };
    });
    const nativeProposers = nativeParticipants.filter((item) => item.role === "proposer");
    expect(nativeProposers.length).toBeGreaterThan(0);
    expect(proposers.length).toBe(nativeProposers.length);
    expect(
      (
        await Promise.all(
          Array.from(proposers).map((node) => node.$("strong[title]").getAttribute("title")),
        )
      ).sort(),
    ).toEqual(nativeProposers.map((item) => `team-proposal-${item.label}`).sort());
    for (const proposer of proposers)
      expect(await proposer.getAttribute("data-model")).toBe(config.team?.members?.[0]);
    const edges = await $$('[data-testid="omp-team-edge"]');
    for (const edge of edges) {
      expect(ids).toContain(await edge.getAttribute("data-source"));
      expect(ids).toContain(await edge.getAttribute("data-target"));
      expect(await edge.getAttribute("data-source")).not.toBe(
        await edge.getAttribute("data-target"),
      );
    }
    expect(
      await Promise.all(Array.from(edges).map((edge) => edge.getAttribute("data-kind"))),
    ).toEqual(expect.arrayContaining(["reviews", "revises"]));
    const observedOutputs: string[] = [];
    const observedStages = new Set<string>();
    for (const node of nodes) {
      observedStages.add((await node.getAttribute("data-stage")) ?? "");
      await node.click();
      const detail = tid("omp-team-node-detail");
      await detail.waitForDisplayed({ timeout: 15000 });
      // 原生输出必须作为可读内容呈现，不能只在 raw JSON 的 pre/details 中命中。
      observedOutputs.push(
        await browser.execute(() => {
          const root = document.querySelector('[data-testid="omp-team-node-detail"]');
          return Array.from(root?.querySelectorAll("p, li, dd, span") ?? [])
            .filter(
              (item) => !item.closest("details, pre") && (item as HTMLElement).checkVisibility(),
            )
            .map((item) => item.textContent ?? "")
            .join("\\n");
        }),
      );
      const tool = detail.$("summary=yield");
      await tool.waitForDisplayed({ timeout: 15000 });
      // 选中下一个节点时 React 会复用工具 details；仅在未展开时点击，避免反向收起。
      if ((await tool.parentElement().getAttribute("open")) === null) await tool.click();
      expect(await tool.parentElement().getText()).toContain("OMP_E2E_TEAM_");
    }
    for (const marker of ["PROPOSAL", "ALIGNMENT", "REVIEW", "REVISION", "REPORT"]) {
      expect(observedOutputs.join("\\n")).toContain(`OMP_E2E_TEAM_${marker}`);
    }
    expect([...observedStages]).toEqual(
      expect.arrayContaining(["investigation", "alignment", "review", "revision", "synthesis"]),
    );
    await screenshot("omp-team-relations-and-details");
    await screenshotPresentationVariants("omp-team-relations-and-details", "omp-team-node-detail");
    const nativeRequests = (await requests()).slice(floor);
    await writeFile(
      resolve(process.env.ZCODE_E2E_ARTIFACT_DIR!, "omp-team-provider-requests.json"),
      JSON.stringify(nativeRequests, null, 2),
    );
    // 原生还会请求无 tools 的命名/辅助轮；忽略它们的工具目录，但仍必须在真实执行请求中找到严格 yield schema。
    expect(
      nativeRequests.some(
        (request) =>
          request.tools?.some((tool) => JSON.stringify(tool).includes("noViableProposal")) === true,
      ),
    ).toBe(true);
    expect(
      nativeRequests.some(
        (request) =>
          request.tools?.some((tool) => JSON.stringify(tool).includes("reportMarkdown")) === true,
      ),
    ).toBe(true);
    await closeTeamDetails();
    await sendV4Prompt("OMP_E2E_TEAM_FOLLOWUP: continue in this conversation");
    await waitForV4AssistantMessageContaining("OMP_E2E_TEAM_FOLLOWUP_OK");
    expect((await getV4PaneSnapshot()).sessionId).toBe(parent.sessionId);
    expect(await tid(TID_V4_COMPOSER_INPUT).isDisplayed()).toBe(true);
    expect(await completedCard.isExisting()).toBe(true);
    await sendV4Prompt("/team OMP_E2E_TEAM_CANCEL: hold the real native proposer");
    const live = $('[data-testid="omp-team-chat-card"][data-status="running"]');
    await live.waitForDisplayed({ timeout: 30000 });
    const cancelledJobId = await live.getAttribute("data-job-id");
    await live.$('[data-testid="workflow-card-open-details"]').click();
    await tid("omp-team-details").waitForDisplayed({ timeout: 30000 });
    await waitForTeamDetailsExpanded();
    await click("omp-team-stop");
    const cancelledCard = $(`[data-testid="omp-team-chat-card"][data-job-id="${cancelledJobId}"]`);
    await browser.waitUntil(
      async () => (await cancelledCard.getAttribute("data-status")) === "cancelled",
      { timeout: 30000, timeoutMsg: "Native Team cancellation was not observed in chat" },
    );
    await screenshot("omp-team-cancelled");
    await closeTeamDetails();
    const beforeColdRead = (await requests()).length;
    const assertRestored = async () => {
      await reopenParent();
      // 冷启动会更换 WebDriver session；按持久化 job ID 重定位，不能复用旧 session 的 Element。
      const completedCard = $(
        `[data-testid="omp-team-chat-card"][data-job-id="${completedJobId}"]`,
      );
      const cancelledCard = $(
        `[data-testid="omp-team-chat-card"][data-job-id="${cancelledJobId}"]`,
      );
      await completedCard.waitForDisplayed({ timeout: 30000 });
      expect(await completedCard.getAttribute("data-status")).toBe("completed");
      expect(await completedCard.getText()).toContain("OMP_E2E_TEAM_REPORT");
      expect(await completedCard.$('[data-testid="workflow-card-name"]').getText()).toBe(prompt);
      expect(await cancelledCard.getAttribute("data-status")).toBe("cancelled");
      expect(Array.from(await $$('[data-testid="omp-team-chat-card"]')).length).toBe(2);
      await completedCard.$('[data-testid="workflow-card-open-details"]').click();
      await tid("omp-team-details").waitForDisplayed({ timeout: 30000 });
      await waitForTeamDetailsExpanded();
      expect(
        Array.from(await tid("omp-team-details").$$('[data-testid="omp-team-node"]')).length,
      ).toBe(ids.length);
      await closeTeamDetails();
      expect((await requests()).length).toBe(beforeColdRead);
    };
    await browser.refresh();
    await assertRestored();
    await restartIntoWorkspacePreservingProfile(DEFAULT_WORKSPACE);
    await assertRestored();
    await screenshot("omp-team-reopened-history");
    await writeFile(
      resolve(process.env.ZCODE_E2E_ARTIFACT_DIR!, "omp-team-chat-history.txt"),
      await tid(testId(TID_V4_SESSION_PANE, V4_MAIN_PANE_ID)).getText(),
    );
  });
});

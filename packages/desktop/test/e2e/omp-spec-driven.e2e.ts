import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { access, mkdir, readFile, readdir, writeFile } from "node:fs/promises";
import { relative, resolve } from "node:path";
import {
  TID_CHAT_ERROR_BANNER,
  TID_CHAT_ERROR_DETAILS_BUTTON,
  TID_V4_COMPOSER_INPUT,
} from "@zcode/shared/test-ids";
import { DEFAULT_WORKSPACE, setInputValueByTestIdDom } from "./helpers/desktop-app.js";
import {
  selectNativeProjectDirectories,
  startDraftFromProject,
} from "./helpers/project-sidebar.js";
import {
  clickV4Send,
  clickV4SlashOption,
  getV4ComposerText,
  getV4PaneSnapshot,
  prepareV4ConversationE2E,
  switchV4Model,
  waitForV4Pane,
  waitForV4SlashOption,
  waitForV4TimelineContaining,
} from "./helpers/v4-conversation.js";
import {
  OMP_MODEL_ID,
  OMP_PROVIDER_ID,
  type ModelRequest,
} from "./helpers/omp-integration-fixture.js";
import {
  SPEC_CHANGE_ID,
  SPEC_FIXTURE_MARKER,
  SPEC_IMPLEMENTATION,
  SPEC_IMPLEMENTATION_PATH,
  SPEC_TEST,
  SPEC_TEST_PATH,
  SPEC_VALIDATION_COMMAND,
} from "./helpers/omp-spec-driven-fixture.js";

const execute = promisify(execFile);
async function git(...args: string[]): Promise<string> {
  return (await execute("git", args, { cwd: DEFAULT_WORKSPACE, windowsHide: true })).stdout.trim();
}
async function exists(path: string, workspace = DEFAULT_WORKSPACE): Promise<boolean> {
  try {
    await access(resolve(workspace, path));
    return true;
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return false;
    throw error;
  }
}
async function requests(): Promise<ModelRequest[]> {
  const url = process.env.OMP_E2E_PROVIDER_URL;
  if (!url || new URL(url).hostname !== "127.0.0.1")
    throw new Error("Spec acceptance requires the isolated localhost provider");
  const response = await fetch(`${url}/__requests`);
  if (!response.ok) throw new Error(`Spec request ledger: ${response.status}`);
  return response.json() as Promise<ModelRequest[]>;
}
async function artifact(name: string) {
  const dir = process.env.ZCODE_E2E_ARTIFACT_DIR;
  if (!dir) throw new Error("Runner-owned artifact directory required");
  await browser.saveScreenshot(resolve(dir, `${name}.png`));
  await writeFile(resolve(dir, `${name}-requests.json`), JSON.stringify(await requests(), null, 2));
  await writeFile(resolve(dir, `${name}-timeline.txt`), (await getV4PaneSnapshot()).timelineText);
}
async function input(value: string) {
  await setInputValueByTestIdDom(TID_V4_COMPOSER_INPUT, value, {
    timeout: 15000,
    timeoutMsg: "Native spec composer missing",
  });
  expect(await getV4ComposerText()).toBe(value);
}
async function submit(command: string) {
  await input(command);
  await clickV4Send();
}
async function idle() {
  await waitForV4Pane((pane) => !pane.canStop, "Native spec command did not settle", 90000);
}
async function nextCommand(action: string, argumentsCount: number): Promise<string> {
  const pattern = new RegExp(`/spec ${action}(?: [A-Za-z0-9_.:-]+){${argumentsCount}}`, "gu");
  let command = "";
  await browser.waitUntil(
    async () => {
      command = [...(await getV4PaneSnapshot()).timelineText.matchAll(pattern)].at(-1)?.[0] ?? "";
      return Boolean(command);
    },
    { timeout: 120000, timeoutMsg: `OMP did not publish exact /spec ${action} approval command` },
  );
  return command;
}
async function noProductionWrites(baseline: string, workspace = DEFAULT_WORKSPACE) {
  expect(await exists(SPEC_IMPLEMENTATION_PATH, workspace)).toBe(false);
  expect(await exists(SPEC_TEST_PATH, workspace)).toBe(false);
  expect(
    (
      await execute("git", ["rev-parse", "HEAD"], { cwd: workspace, windowsHide: true })
    ).stdout.trim(),
  ).toBe(baseline);
}
async function prepareDisposableRepository(workspace = DEFAULT_WORKSPACE): Promise<string> {
  const home = process.env.ZCODE_E2E_HOME_DIR;
  if (!home || !process.env.ZCODE_E2E_RUN_ID || relative(resolve(home), workspace).startsWith(".."))
    throw new Error("Refusing Git fixture setup outside this runner's disposable HOME");
  if (await exists(".git", workspace))
    throw new Error(
      "Spec acceptance needs a fresh disposable workspace, never an existing Git repository",
    );
  await writeFile(
    resolve(workspace, "spec-fixture-baseline.txt"),
    "isolated spec acceptance baseline\n",
    { flag: "wx" },
  );
  const runGit = async (...args: string[]) =>
    (await execute("git", args, { cwd: workspace, windowsHide: true })).stdout.trim();
  await runGit("init", "-b", "main");
  await runGit("config", "user.name", "OMP Spec E2E");
  await runGit("config", "user.email", "omp-spec-e2e@example.invalid");
  await runGit("add", "--", "spec-fixture-baseline.txt");
  await runGit("commit", "-m", "test: initialize disposable spec acceptance workspace");
  // This unrelated new file must survive and must never enter a task-owned commit.
  await writeFile(
    resolve(workspace, "spec-unrelated-user.txt"),
    "preserve unrelated untracked data\n",
    { flag: "wx" },
  );
  return runGit("rev-parse", "HEAD");
}
async function configureNativeTeam() {
  await $('[data-testid="omp-team-sidebar-open"]').click();
  const defaults = $('[data-testid="omp-team-default"]');
  await defaults.waitForExist({ timeout: 30000 });
  const more = defaults.parentElement().parentElement().$("summary");
  await more.click();
  await defaults.click();
  await more.click();
  for (const modelId of [OMP_MODEL_ID, "omp-alternate"]) {
    await $('[data-testid="omp-team-model-search"]').setValue(`${OMP_PROVIDER_ID} ${modelId}`);
    const add = $(
      `[data-testid="omp-team-model-catalog"] button[data-omp-model-provider="${OMP_PROVIDER_ID}"][data-omp-model-id="${modelId}"]`,
    );
    await add.waitForDisplayed({ timeout: 30000 });
    await add.scrollIntoView({ block: "center" });
    await add.click();
  }
  await $('[data-testid="omp-team-save"]').click();
  await browser.waitUntil(
    async () =>
      (await $('[data-testid="omp-team-receipt"]').getAttribute("data-save-state")) === "complete",
    { timeout: 30000, timeoutMsg: "Native Team settings did not save valid localhost members" },
  );
  await $('[data-testid="omp-config-cancel"]').click();
}

describe("OMP native /spec / real Electron command consumer", () => {
  it("discovers /spec, gates all versions, executes real RED/GREEN with task-owned commits, then accepts", async function () {
    this.timeout(600000);
    await prepareV4ConversationE2E({ skipProvider: true });
    await configureNativeTeam();
    // Team 设置会切离草稿；保存关闭后按现有项目入口恢复 composer，再选回 localhost 模型。
    await startDraftFromProject(DEFAULT_WORKSPACE);
    await switchV4Model(OMP_PROVIDER_ID, OMP_MODEL_ID, "disabled");
    const baseline = await prepareDisposableRepository();
    await input("/spe");
    await waitForV4SlashOption("slash:spec");
    await clickV4SlashOption("slash:spec");
    expect((await getV4ComposerText())?.trim()).toBe("/spec");
    await artifact("omp-spec-discovery");

    const ordinaryStart = (await requests()).length;
    await submit(`${SPEC_FIXTURE_MARKER} ordinary chat only; do not start a workflow.`);
    try {
      await waitForV4TimelineContaining(`${SPEC_FIXTURE_MARKER}_CHAT_READY`);
    } catch (error) {
      // 原因：RPC OK 只证明传输成功；折叠横幅曾隐藏 admission 拒绝原因，不能据此归因模型或加等待。
      const banner = $(`[data-testid="${TID_CHAT_ERROR_BANNER}"]`);
      const code = (await banner.isExisting())
        ? await banner.getAttribute("data-error-code")
        : null;
      const details = $(`[data-testid="${TID_CHAT_ERROR_DETAILS_BUTTON}"]`);
      if (await details.isExisting()) await details.click();
      const detail = await browser.execute(
        () => document.querySelector<HTMLElement>('[role="dialog"] pre')?.innerText ?? "",
      );
      await artifact("omp-spec-ordinary-send-failure");
      const diagnostics = {
        code,
        detail,
        pane: await getV4PaneSnapshot(),
        providerRequestsSinceSend: (await requests()).slice(ordinaryStart),
      };
      await writeFile(
        resolve(process.env.ZCODE_E2E_ARTIFACT_DIR!, "omp-spec-ordinary-send-failure.json"),
        JSON.stringify(diagnostics, null, 2),
      );
      throw new Error(`Native ordinary send failed: ${JSON.stringify(diagnostics)}`, {
        cause: error,
      });
    }
    await idle();
    const ordinary = (await requests())
      .slice(ordinaryStart)
      .filter((request) => JSON.stringify(request.messages).includes("ordinary chat only"));
    expect(ordinary.length).toBeGreaterThan(0);
    for (const request of ordinary) {
      const instructions = JSON.stringify(request.messages);
      expect(instructions).not.toContain("openspec-explore");
      expect(instructions).not.toContain("openspec-propose");
      expect(instructions).not.toContain("using-superpowers");
      expect(instructions).not.toContain("superpowers:using-superpowers");
      expect(instructions).not.toContain("skills/test-driven-development/SKILL.md");
    }
    await submit(
      `/spec start ${SPEC_CHANGE_ID} ${SPEC_FIXTURE_MARKER}: implement greet(name), trim outer whitespace, empty names use world, preserve internal whitespace. Use real Bun tests, native tools, local task commits and independent reviews.`,
    );
    const confirmSpec = await nextCommand("confirm-spec", 1);
    await idle();
    const changeDir = `openspec/changes/${SPEC_CHANGE_ID}`;
    expect(await readFile(resolve(DEFAULT_WORKSPACE, changeDir, "proposal.md"), "utf8")).toContain(
      SPEC_FIXTURE_MARKER,
    );
    expect(
      await readFile(resolve(DEFAULT_WORKSPACE, changeDir, "specs/greeting/spec.md"), "utf8"),
    ).toContain("#### Scenario: Blank name");
    expect(await exists(`${changeDir}/plan.md`)).toBe(false);
    await noProductionWrites(baseline);
    await artifact("omp-spec-before-specification-approval");

    const beforeStale = (await requests()).length;
    await submit("/spec confirm-spec stale-version-never-approved");
    await idle();
    await submit("/spec status");
    await idle();
    expect(await nextCommand("confirm-spec", 1)).toBe(confirmSpec);
    expect((await requests()).length).toBe(beforeStale);
    await noProductionWrites(baseline);
    await submit("/spec pause");
    await idle();
    const pausedRequests = (await requests()).length;
    await submit("/spec status");
    await idle();
    expect((await getV4PaneSnapshot()).timelineText).toMatch(/paused["\s:]*true|暂停/u);
    expect((await requests()).length).toBe(pausedRequests);
    await noProductionWrites(baseline);
    await submit("/spec resume");
    await idle();
    expect((await requests()).length).toBe(pausedRequests);
    await submit(confirmSpec);
    const choose = await nextCommand("choose", 3);
    await idle();
    await noProductionWrites(baseline);
    await artifact("omp-spec-real-team-candidates");
    await submit(choose);
    const confirmPlan = await nextCommand("confirm-plan", 1);
    await idle();
    const plan = await readFile(resolve(DEFAULT_WORKSPACE, changeDir, "plan.md"), "utf8");
    expect(plan).toContain(SPEC_VALIDATION_COMMAND);
    expect(plan).toContain(SPEC_IMPLEMENTATION_PATH);
    await noProductionWrites(baseline);
    await submit("/spec confirm-plan stale-plan-never-approved");
    await idle();
    await noProductionWrites(baseline);
    await artifact("omp-spec-before-implementation-approval");
    // This exact-version command is also the explicit authority for native local task commits.
    await submit(confirmPlan);
    const accept = await nextCommand("accept", 1);
    await idle();
    expect(await readFile(resolve(DEFAULT_WORKSPACE, SPEC_IMPLEMENTATION_PATH), "utf8")).toBe(
      SPEC_IMPLEMENTATION,
    );
    expect(await readFile(resolve(DEFAULT_WORKSPACE, SPEC_TEST_PATH), "utf8")).toBe(SPEC_TEST);
    expect(await git("rev-parse", "HEAD")).not.toBe(baseline);
    const owned = (await git("diff", "--name-only", `${baseline}..HEAD`))
      .split(/\r?\n/u)
      .filter(Boolean)
      .sort();
    expect(owned).toEqual([SPEC_IMPLEMENTATION_PATH, SPEC_TEST_PATH].sort());
    const commits = (await git("log", "--format=%H", `${baseline}..HEAD`))
      .split(/\r?\n/u)
      .filter(Boolean);
    expect(commits.length).toBeGreaterThan(0);
    for (const commit of commits) {
      const paths = (await git("diff-tree", "--no-commit-id", "--name-only", "-r", commit))
        .split(/\r?\n/u)
        .filter(Boolean);
      expect(paths.length).toBeGreaterThan(0);
      expect(paths.every((path) => [SPEC_IMPLEMENTATION_PATH, SPEC_TEST_PATH].includes(path))).toBe(
        true,
      );
    }
    expect(await git("status", "--porcelain", "--", SPEC_IMPLEMENTATION_PATH, SPEC_TEST_PATH)).toBe(
      "",
    );
    expect(await git("ls-files", "--", "spec-unrelated-user.txt")).toBe("");
    expect(await readFile(resolve(DEFAULT_WORKSPACE, "spec-unrelated-user.txt"), "utf8")).toBe(
      "preserve unrelated untracked data\n",
    );
    // Execute the declared public behavior entry independently, not fixture status or model self-report.
    const validation = await execute("bun", ["test", SPEC_TEST_PATH], {
      cwd: DEFAULT_WORKSPACE,
      windowsHide: true,
    });
    expect(`${validation.stdout}\n${validation.stderr}`).toMatch(/3 pass/u);
    const ledger = await requests();
    const nativeRoles = ledger
      .map((request) =>
        JSON.stringify(request.messages.filter((message) => message.role === "user")),
      )
      .join("\n");
    expect(nativeRoles).toContain("requirements");
    expect(nativeRoles).toContain("planner");
    expect(nativeRoles).toContain("reviewer");
    const reviewInputs = ledger
      .flatMap((request) => request.messages.filter((message) => message.role === "user"))
      .map((message) =>
        typeof message.content === "string"
          ? message.content
          : Array.isArray(message.content)
            ? message.content.map((part: { text?: string }) => part.text ?? "").join("\n")
            : "",
      )
      .filter((content) => /"specDrivenRole"\s*:\s*"reviewer"/u.test(content));
    for (const kind of ["requirements", "plan", "task", "overall"])
      expect(
        reviewInputs.some((content) => new RegExp(`"kind"\\s*:\\s*"${kind}"`, "u").test(content)),
      ).toBe(true);
    const toolMessages = ledger
      .flatMap((request) => request.messages.filter((message) => message.role === "tool"))
      .map((message) => JSON.stringify(message))
      .join("\n");
    expect(toolMessages).toMatch(/3 fail|expect\(received\).*toBe|Expected:.*Hello/u);
    expect(toolMessages).toContain("3 pass");
    await artifact("omp-spec-red-green-commits-reviewed");
    await submit("/spec accept stale-acceptance-never-approved");
    await idle();
    expect(await exists(`${changeDir}/proposal.md`)).toBe(true);
    await submit(accept);
    await waitForV4TimelineContaining('"phase":"completed"', 120000);
    await idle();
    expect(await exists("openspec/specs/greeting/spec.md")).toBe(true);
    const archives = await readdir(resolve(DEFAULT_WORKSPACE, "openspec/changes/archive"));
    expect(archives.some((name) => name.endsWith(SPEC_CHANGE_ID))).toBe(true);
    await artifact("omp-spec-final-acceptance");
  });

  it("keeps a real provider failure stopped with no implementation or local commit", async function () {
    this.timeout(120000);
    await prepareV4ConversationE2E({ skipProvider: true });
    await configureNativeTeam();
    // 原因：新会话不等于新项目；已验收项目的 openspec/specs 会成为下一次需求的真实 originals，
    // 连同嵌套标题映射计入有限上下文，先于 provider 故障阻塞。独立项目保持故障注入前置条件，
    // 不删除 happy-path 归档、不调大上下文，也不注入会话/工作流状态。
    const workspace = resolve(process.env.ZCODE_E2E_HOME_DIR!, "OmpSpecFailure");
    await mkdir(workspace, { recursive: false });
    const before = await prepareDisposableRepository(workspace);
    await $('[data-testid="virtual-project-add"]').click();
    await $('[data-testid="virtual-project-name"]').setValue("OmpSpecFailure");
    await selectNativeProjectDirectories([workspace]);
    await $('[data-testid="virtual-project-save"]').click();
    await $('[data-testid="project-folder-trust-confirm"]').waitForDisplayed();
    await $('[data-testid="project-folder-trust-confirm"]').click();
    await startDraftFromProject(workspace);
    await switchV4Model(OMP_PROVIDER_ID, OMP_MODEL_ID, "disabled");
    const requestStart = (await requests()).length;
    await submit(
      `/spec start omp-greeting-failure ${SPEC_FIXTURE_MARKER} OMP_E2E_SPEC_FORCE_FAILURE`,
    );
    await waitForV4TimelineContaining("OMP_E2E_SPEC_EXPECTED_PROVIDER_FAILURE", 90000);
    await idle();
    const failureRequests = (await requests()).slice(requestStart);
    expect(
      failureRequests.some(
        (request) =>
          Boolean(request.tools?.length) &&
          JSON.stringify(request.messages).includes("OMP_E2E_SPEC_FORCE_FAILURE"),
      ),
    ).toBe(true);
    const stopped = (await requests()).length;
    await submit("/spec status");
    await idle();
    expect((await getV4PaneSnapshot()).timelineText).toMatch(
      /paused["\s:]*true|blockedReason|暂停/u,
    );
    expect((await requests()).length).toBe(stopped);
    await noProductionWrites(before, workspace);
    expect(await exists("openspec/changes/omp-greeting-failure/plan.md", workspace)).toBe(false);
    await artifact("omp-spec-stopped-provider-failure");
    await submit("/spec cancel");
    await idle();
  });
});

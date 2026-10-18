import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { readFile, rename, writeFile } from "node:fs/promises";
import { isAbsolute, join, resolve } from "node:path";
import { captureIsolationScreenshot } from "./ompCore.evidence.cjs";
import { eventually } from "./ompAgentsAcceptance.assertions.mjs";
import { sourceEvents } from "./ompAgentsAcceptance.sources.mjs";

async function observations(runtime) {
  const response = await fetch(runtime.observationsUrl);
  assert.equal(response.status, 200);
  const result = await response.json();
  assert.ok(result.interactionQueryHosts?.length, "Require this launch's instrumented real Host");
  for (const host of result.interactionQueryHosts) assert.equal(host.root, runtime.runRoot);
  return result;
}
async function graph(panel) {
  return {
    nodes: await panel
      .getByTestId("omp-agent-interaction-node")
      .evaluateAll((nodes) => nodes.map((node) => node.getAttribute("data-agent-id")).sort()),
    edges: await panel
      .getByTestId("omp-agent-interaction-edge")
      .evaluateAll((edges) =>
        edges.map((edge) => [edge.getAttribute("data-from"), edge.getAttribute("data-to")]).sort(),
      ),
  };
}
async function clickWithFrozenFrames(locator) {
  assert.equal(await locator.count(), 1, "Only one existing public control may receive the click");
  assert.equal(await locator.isVisible(), true);
  assert.equal(await locator.isEnabled(), true);
  await locator.evaluate((element) =>
    element.scrollIntoView({ block: "center", inline: "center", behavior: "instant" }),
  );
  const bounds = await locator.boundingBox();
  assert.ok(bounds && bounds.width > 0 && bounds.height > 0);
  assert.deepEqual(await locator.boundingBox(), bounds, "The real control must remain stationary");
  assert.equal(
    await locator.evaluate((element) => {
      const rect = element.getBoundingClientRect();
      const hit = document.elementFromPoint(rect.x + rect.width / 2, rect.y + rect.height / 2);
      return element === hit || element.contains(hit);
    }),
    true,
    "An overlay must not intercept the genuine click target",
  );
  // Only RAF-based Playwright stability polling is bypassed: visibility, enabled state,
  // geometry and actual hit target were checked above. Dispatch the normal mouse click.
  await locator.click({ force: true });
}

// Admission is a root-owned file; no public product API, service replacement or port relay.
// Freeze already-installed fixture time so the existing 2s automatic poll cannot perform
// the successful retry. The genuine Retry DOM click must be the sole subsequent query.
export async function assertInteractionQueryRetry(
  page,
  runtime,
  records,
  parentId,
  evidenceDir,
  phase,
) {
  assert.equal(runtime.suite, "agents");
  assert.equal(
    runtime.interactionQueryClock,
    true,
    "Install fixture time before application timers",
  );
  assert.ok(isAbsolute(runtime.runRoot));
  const ownerPath = join(runtime.runRoot, "evidence", "interaction-query-owner.json");
  const controlPath = join(runtime.runRoot, "evidence", "interaction-query-control.json");
  const owner = JSON.parse(await readFile(ownerPath, "utf8"));
  assert.equal(owner.root, runtime.runRoot);
  assert.equal(owner.electronPid, runtime.electronPid);
  assert.equal(resolve(runtime.requestedWorkspace), resolve(runtime.runRoot, "workspace"));
  let hostPid;
  const setFault = async (armed, token) => {
    await writeFile(
      `${controlPath}.next`,
      JSON.stringify({
        root: runtime.runRoot,
        nonce: owner.nonce,
        hostPid,
        sessionId: parentId,
        armed,
        token,
      }),
    );
    await rename(`${controlPath}.next`, controlPath);
  };
  const events = sourceEvents(records, parentId);
  assert.equal(events.length, 17, "Keep all independently sourced events in Retry acceptance");
  const panel = page.getByTestId("omp-agent-interactions");
  const tab = page.locator('[data-side-pane-tab-type="omp-agent-interactions"]');
  const open = page.getByRole("button", { name: /^(?:Agent 交互|Agent interactions)$/u });
  const expectedGraph = await graph(panel);
  const expectedEventCount = Number(await panel.getAttribute("data-message-count"));
  assert.ok(expectedEventCount >= events.length);
  assert.ok(expectedGraph.nodes.length > 1 && expectedGraph.edges.length > 0);
  const token = randomUUID();
  await page.clock.pauseAt(new Date(await page.evaluate(() => Date.now() + 100)));
  let clockPaused = true;
  try {
    await eventually(
      async () => {
        const state = await observations(runtime);
        return state.interactionQueryHosts.every((host) => host.queries === host.replies.length);
      },
      Boolean,
      "Drain real in-flight observations before arming a one-request fault",
    );
    await clickWithFrozenFrames(tab.getByRole("button", { name: /关闭|Close/u }));
    await page.clock.runFor(32);
    await panel.waitFor({ state: "hidden" });
    const before = await observations(runtime);
    const hosts = before.interactionQueryHosts.filter((host) =>
      host.replies.some((reply) => reply.type === 201 && reply.rootSessionId === parentId),
    );
    assert.equal(hosts.length, 1, "Bind fault to the unique Host that already served this session");
    hostPid = hosts[0].hostPid;
    await setFault(true, token);
    await clickWithFrozenFrames(open);
    await page.clock.runFor(32);
    const rejected = await eventually(
      async () => {
        const state = await observations(runtime);
        return state.interactionQueryHosts
          .flatMap((host) =>
            host.replies.map((reply) => ({
              ...reply,
              hostPid: host.hostPid,
            })),
          )
          .find((reply) => reply.faultToken === token);
      },
      Boolean,
      "The unchanged real Host must answer the malformed query",
    );
    assert.ok([202, 203].includes(rejected.type), "Only a real Host RPC rejection qualifies");
    assert.equal(rejected.sessionId, parentId);
    await page.clock.runFor(32);
    const alert = panel.getByRole("alert");
    await alert.waitFor({ state: "visible" });
    const retry = alert.getByRole("button", { name: /^(?:重试|Retry)$/u });
    await retry.waitFor({ state: "visible" });
    assert.equal(await retry.isEnabled(), true);
    assert.equal(
      Number(await panel.getAttribute("data-message-count")),
      0,
      "The failed initial query must not be disguised as stale successful records",
    );
    await captureIsolationScreenshot(
      join(evidenceDir, `agents-${phase}-interaction-query-error.png`),
    );
    await setFault(false, token);
    const disarmed = await observations(runtime);
    // 中文原因：重开 live 别名会先成功解析真实根，再因根绑定重读；只有后者命中本次故障。
    // 两次均为显式打开链路，不是被冻结的自动轮询。
    const newReplies = disarmed.interactionQueryHosts
      .find((host) => host.hostPid === hostPid)
      .replies.slice(hosts[0].replies.length);
    const aliases = newReplies.filter((reply) => reply.sessionId !== parentId);
    assert.ok(aliases.length <= 1, "At most one live-alias resolution precedes the fault");
    for (const alias of aliases) {
      assert.equal(alias.type, 201);
      assert.equal(alias.rootSessionId, parentId);
      assert.equal(alias.faultToken, null);
    }
    assert.equal(newReplies.length, aliases.length + 1);
    assert.equal(
      disarmed.agentInteractionQueries,
      before.agentInteractionQueries + aliases.length + 1,
    );
    assert.equal(await alert.isVisible(), true, "Disarming alone cannot recover the query");
    const retryBefore = disarmed.agentInteractionQueries;
    await clickWithFrozenFrames(retry);
    const recovered = await eventually(
      async () => {
        const state = await observations(runtime);
        return {
          state,
          reply: state.interactionQueryHosts
            .find((host) => host.hostPid === rejected.hostPid)
            ?.replies.find(
              (reply) =>
                reply.requestId > rejected.requestId &&
                reply.type === 201 &&
                reply.sessionId === parentId &&
                reply.faultToken === null,
            ),
        };
      },
      (result) => Boolean(result.reply),
      "Clicking existing Retry must query the same real Host",
    );
    assert.equal(
      recovered.state.agentInteractionQueries,
      retryBefore + 1,
      "Exactly one real query follows Retry; automatic polling is frozen",
    );
    assert.equal(recovered.reply.rootSessionId, parentId);
    assert.equal(recovered.reply.eventCount, expectedEventCount);
    assert.equal(recovered.reply.totalEvents, expectedEventCount);
    await page.clock.runFor(32);
    await alert.waitFor({ state: "hidden" });
    await eventually(
      async () => Number(await panel.getAttribute("data-message-count")),
      (count) => count === expectedEventCount,
      "Retry must restore the full authoritative event collection",
    );
    assert.deepEqual(
      await graph(panel),
      expectedGraph,
      "Retry restores the original directed graph",
    );
    assert.equal(
      (await observations(runtime)).agentInteractionQueries,
      retryBefore + 1,
      "No automatic poll can explain error recovery before resuming renderer time",
    );
    await page.clock.resume();
    clockPaused = false;
    const search = panel.getByTestId("omp-agent-interactions-search");
    const rows = panel
      .getByRole("list", { name: /选择一条交互|Select an interaction/u })
      .getByRole("listitem");
    for (const event of events) {
      await search.fill(event.token);
      const sender =
        event.kind === "intervention"
          ? "user:operator"
          : event.sender === records.parentAgentId
            ? "main"
            : event.sender;
      const receiver = event.receiver === records.parentAgentId ? "main" : event.receiver;
      const row = rows
        .filter({
          has: page.locator(`button[data-from="${sender}"][data-to="${receiver}"]`),
        })
        .filter({ hasText: event.token });
      await eventually(
        () => row.count(),
        (count) => count === 1,
        "Recovered history must retain each independent original event",
      );
      await row.getByRole("button").click();
      assert.equal(
        await panel.getByTestId("omp-agent-interaction-detail").getAttribute("data-source-id"),
        event.sourceId,
      );
    }
    await search.fill("");
    await alert.waitFor({ state: "hidden" });
    await captureIsolationScreenshot(
      join(evidenceDir, `agents-${phase}-interaction-query-retry.png`),
    );
  } finally {
    await setFault(false, token);
    if (clockPaused) await page.clock.resume();
  }
}

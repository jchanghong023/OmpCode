import assert from "node:assert/strict";

// command_output 不进原生 journal。只读真实 DOM 的稳定行身份，不能用模型回复或文本计数替代。
export async function commandRows(page) {
  const timeline = page.getByTestId("v4-timeline");
  const rows = new Map();
  const positions = new Map();
  const occupants = new Map();
  const visitedUnits = new Set();
  const inspect = (mode, lastIndex) =>
    timeline.evaluate(
      (root, { action, lastIndex }) => {
        // testid 就在 ConversationTimeline.scrollRef 上。内容尚未溢出时也不能
        // 改选祖先/Markdown 内部的滚动区，否则 reset 和 advance 操作的不是虚拟视口。
        if (root.getAttribute("data-v4-timeline-scroll") !== "true") {
          throw new Error("Command history requires the actual timeline scroll viewport");
        }
        if (action === "reset" || action === "advance") {
          // 根因：逐半屏重扫已采集的长工具结果，重复全历史验收随正文增长耗尽总预算。
          // 只跨过本轮已读取的最后一个虚拟单元，并保留半屏重叠；未挂载时沿用半屏步长。
          const last = root.querySelector(`[data-v4-turn-unit="true"][data-index="${lastIndex}"]`);
          const step = Math.max(
            100,
            root.clientHeight / 2,
            last
              ? last.getBoundingClientRect().bottom -
                  root.getBoundingClientRect().top -
                  root.clientTop -
                  root.clientHeight / 2
              : 0,
          );
          const delta = action === "reset" ? -root.scrollHeight : step;
          // 保留真实滚动意图入口，避免测高 guard 把浏览误判为布局补偿并重新贴底。
          root.dispatchEvent(new WheelEvent("wheel", { bubbles: true, deltaY: delta }));
          root.scrollTop =
            action === "reset" ? 0 : Math.min(root.scrollHeight, root.scrollTop + step);
          // 隐藏原生窗口不保证及时派发浏览器 scroll；直接通知真实滚动监听器，
          // 让 virtualizer 先消费新 offset，再由宿主时钟等待 React 提交。
          root.dispatchEvent(new Event("scroll"));
          return null;
        }
        const viewport = {
          top: root.scrollTop,
          atBottom: root.scrollTop + root.clientHeight >= root.scrollHeight - 1,
          count: Number(root.getAttribute("data-render-unit-count")),
          indices: [...root.querySelectorAll('[data-v4-turn-unit="true"]')].map((node) =>
            Number(node.getAttribute("data-index")),
          ),
        };
        if (action === "viewport") return viewport;
        const mounted = [
          ...root.querySelectorAll('section[data-turn-id^="omp-command-output:"]'),
        ].flatMap((node) => {
          const entity = node.getAttribute("data-turn-id");
          const content = node.querySelector("[data-conversation-selectable]");
          if (!content) return [];
          return [
            {
              id: entity,
              text: content.innerText.replace(/\r\n/gu, "\n"),
              // 虚拟行测高及历史展开会移动像素坐标；逻辑槽位不随布局变化。
              position: Number(
                node.closest('[data-v4-turn-unit="true"]')?.getAttribute("data-index") ?? NaN,
              ),
            },
          ];
        });
        return { viewport, mounted };
      },
      { action: mode, lastIndex },
    );
  await inspect("reset");
  const deadline = Date.now() + 90_000;
  for (;;) {
    assert.ok(Date.now() < deadline, "Command history scan exceeded 90s");
    // 隐藏原生窗口可能暂停动画帧，使用宿主时钟等待虚拟列表提交。
    await new Promise((done) => setTimeout(done, 40));
    const viewport = await inspect("viewport");
    if (
      visitedUnits.size === 0 &&
      viewport.count > 0 &&
      (viewport.top !== 0 || !viewport.indices.includes(0))
    ) {
      await inspect("reset");
      continue;
    }
    const collapsed = timeline.locator(
      'button[data-testid^="chat-assistant-history-trigger-"][data-history-open="false"]',
    );
    while (await collapsed.count()) {
      assert.ok(Date.now() < deadline, "Command history expansion exceeded 90s");
      await collapsed.first().evaluate((node) => node.click());
    }
    // 展开可能改变测高/挂载范围；采集的覆盖范围必须属于实际读取正文的同一帧。
    const { viewport: coverage, mounted } = await inspect("rows");
    if (
      visitedUnits.size === 0 &&
      coverage.count > 0 &&
      (coverage.top !== 0 || !coverage.indices.includes(0))
    ) {
      await inspect("reset");
      continue;
    }
    for (const index of coverage.indices) visitedUnits.add(index);
    assert.equal(
      new Set(mounted.map((row) => row.id)).size,
      mounted.length,
      "A command_output stable ID may occur only once in a mounted viewport",
    );
    for (const { position, ...row } of mounted) {
      assert.ok(
        Number.isInteger(position) && position >= 0,
        `Command output ${row.id} must have a real timeline unit index`,
      );
      if (occupants.has(position)) {
        assert.equal(
          occupants.get(position),
          row.id,
          "One timeline unit index may not be reused by a different command ID",
        );
      } else {
        occupants.set(position, row.id);
      }
      assert.ok(row.text.trim(), `Command output ${row.id} must retain its actual text`);
      if (rows.has(row.id)) {
        assert.deepEqual(rows.get(row.id), row, "Scrolling must not change a command record");
        assert.equal(
          positions.get(row.id),
          position,
          "One stable command ID may not appear again at another logical timeline position",
        );
      } else {
        rows.set(row.id, row);
        positions.set(row.id, position);
      }
    }
    assert.ok(
      mounted.every((row, index) => index === 0 || mounted[index - 1].position < row.position),
      "Mounted command outputs must retain their logical timeline order",
    );
    if (
      coverage.atBottom &&
      (coverage.count === 0 || coverage.indices.includes(coverage.count - 1))
    ) {
      assert.ok(
        Array.from({ length: coverage.count }, (_, index) => index).every((index) =>
          visitedUnits.has(index),
        ),
        "Command history must visit every timeline unit, including the first and last",
      );
      break;
    }
    await inspect("advance", coverage.indices.at(-1));
  }
  return [...rows.values()].sort((left, right) => positions.get(left.id) - positions.get(right.id));
}

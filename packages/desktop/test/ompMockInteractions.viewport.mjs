import { setImmediate } from "node:timers/promises";

// Own real virtualized-timeline DOM scrolling and commit observations. Callers own
// their shared deadline and coverage assertions; no product store/projection is read.
export function readTimelineViewport(timeline, { includeText = false } = {}) {
  return timeline.evaluate(
    (root, includeText) => ({
      ...(includeText ? { text: root.innerText } : {}),
      top: root.scrollTop,
      height: root.scrollHeight,
      viewport: root.clientHeight,
      following: root.getAttribute("data-following"),
      bottom: root.scrollTop + root.clientHeight >= root.scrollHeight - 1,
      count: Number(root.getAttribute("data-render-unit-count")),
      indices: [...root.querySelectorAll('[data-v4-turn-unit="true"]')].map((node) =>
        Number(node.getAttribute("data-index")),
      ),
    }),
    includeText,
  );
}

export function timelineTargetInViewport(target) {
  // isVisible includes overscan, which can unmount on the next measurement.
  return target.evaluateAll((nodes) =>
    nodes.some((node) => {
      const viewport = node.closest('[data-v4-timeline-scroll="true"]');
      if (!viewport || !node.checkVisibility({ checkOpacity: true, checkVisibilityCSS: true }))
        return false;
      const bounds = viewport.getBoundingClientRect();
      const rect = node.getBoundingClientRect();
      return (
        rect.width > 0 &&
        rect.height > 0 &&
        rect.bottom > Math.max(0, bounds.top) &&
        rect.top < Math.min(innerHeight, bounds.bottom) &&
        rect.right > Math.max(0, bounds.left) &&
        rect.left < Math.min(innerWidth, bounds.right)
      );
    }),
  );
}

export async function scrollTimelineViewport(
  timeline,
  { reset = false, lastIndex, fraction = 0.7, target, deadline } = {},
) {
  const targetDelta = target
    ? await target.evaluateAll((nodes) => {
        if (nodes.length !== 1) return null;
        const node = nodes[0];
        const root = node.closest('[data-v4-timeline-scroll="true"]');
        if (!root || !node.checkVisibility({ checkOpacity: true, checkVisibilityCSS: true }))
          return null;
        const bounds = root.getBoundingClientRect();
        const rect = node.getBoundingClientRect();
        const top = Math.max(0, bounds.top + root.clientTop);
        const bottom = Math.min(innerHeight, bounds.top + root.clientTop + root.clientHeight);
        if (rect.width <= 0 || rect.height <= 0 || bottom <= top) return null;
        if (rect.bottom > top && rect.top < bottom) return 0;
        return rect.top - top - (bottom - top - Math.min(rect.height, bottom - top)) / 2;
      })
    : undefined;
  if (targetDelta === null || targetDelta === 0) return false;
  const delta = target
    ? targetDelta
    : await timeline.evaluate(
        (root, { reset, lastIndex, fraction }) => {
          if (root.getAttribute("data-v4-timeline-scroll") !== "true")
            throw new Error("History scan requires the actual timeline viewport");
          if (
            !reset &&
            fraction !== 0.5 &&
            root.scrollTop + root.clientHeight >= root.scrollHeight - 1
          )
            return null;
          const last = root.querySelector(`[data-v4-turn-unit="true"][data-index="${lastIndex}"]`);
          // Full mounted-unit text is inspected before advancing, with overlap.
          const step =
            fraction === 0.5
              ? Math.max(
                  1,
                  root.clientHeight / 2,
                  last
                    ? last.getBoundingClientRect().bottom -
                        root.getBoundingClientRect().top -
                        root.clientTop -
                        root.clientHeight / 2
                    : 0,
                )
              : Math.max(1, Math.floor(root.clientHeight * fraction));
          return reset ? -Math.max(1, root.scrollHeight) : step;
        },
        { reset, lastIndex, fraction },
        { timeout: deadline === undefined ? undefined : Math.max(1, deadline - Date.now()) },
      );
  if (delta === null) return false;
  // 根因：live tail 终态迁移/测高仍可贴底；先走 UI 的 wheel capture 交出 following
  // 所有权，再在独立 renderer 任务提交真实 offset，不能把同任务的赋值当成提交屏障。
  await timeline.dispatchEvent(
    "wheel",
    { deltaY: delta, bubbles: true },
    { timeout: deadline === undefined ? undefined : Math.max(1, deadline - Date.now()) },
  );
  await settleTimelineLayout();
  return timeline.evaluate(
    (root, { reset, delta, targeted }) => {
      const before = root.scrollTop;
      root.scrollTop = reset ? 0 : Math.min(root.scrollHeight, before + delta);
      root.dispatchEvent(new Event("scroll"));
      return reset
        ? root.scrollTop === 0
        : targeted
          ? root.scrollTop !== before
          : root.scrollTop > before;
    },
    { reset, delta, targeted: !!target },
    { timeout: deadline === undefined ? undefined : Math.max(1, deadline - Date.now()) },
  );
}

export function timelineBoundaryCommitted(timeline, boundary) {
  return timeline.evaluate((root, boundary) => {
    const count = Number(root.getAttribute("data-render-unit-count"));
    if (boundary === "start")
      return (
        root.scrollTop === 0 &&
        (root.scrollHeight <= root.clientHeight ||
          root.getAttribute("data-following") === "false") &&
        (!(count > 0) || !!root.querySelector('[data-v4-turn-unit="true"][data-index="0"]'))
      );
    return (
      root.scrollTop + root.clientHeight >= root.scrollHeight - 1 &&
      (count === 0 || !!root.querySelector(`[data-v4-turn-unit="true"][data-index="${count - 1}"]`))
    );
  }, boundary);
}

export function settleTimelineLayout() {
  // 只让出宿主事件循环；这不是“已提交”证据。调用者仍须检查真实几何/首尾索引，
  // 隐藏原生窗口也不依赖可能暂停的 rAF，更不以固定毫秒代替 React 提交。
  return setImmediate();
}

import assert from "node:assert/strict";
import test from "node:test";
import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { registerHooks } from "node:module";
import type { SubagentRow } from "@zcode/shared/zcode-protocol-v4";
import { ZCodeIntlProvider } from "../src/i18n/IntlProvider.js";
import type { ConversationRowRenderContext } from "../src/v4/conversationRowContext.js";
import { TooltipProvider } from "../src/components/ui/tooltip.js";
import { buildAssistantWorkRenderItems } from "../src/v4/conversationAssistantWorkItems.js";
import { ompSubagentCardItem } from "../src/v4/OmpSubagentCard.js";

// Node 单测不经 Vite；仅替代静态图标 URL，界面组件与会话事实仍使用真实实现。
registerHooks({
  load(url, context, nextLoad) {
    if (/\.svg(?:\?.*)?$/u.test(url))
      return { format: "module", shortCircuit: true, source: 'export default "test-icon.svg";' };
    return nextLoad(url, context);
  },
});
const { ConversationStatusPanel } = await import("../src/v4/ConversationStatusPanel.js");
const { OmpSubagentRow } = await import("../src/v4/OmpSubagentRow.js");

function render(node: ReturnType<typeof createElement>) {
  return renderToStaticMarkup(
    createElement(
      ZCodeIntlProvider,
      { initialLocale: "zh-CN" },
      createElement(TooltipProvider, {}, node),
    ),
  );
}

test("只有已结束子代理时保留独立面板及 mini 展开入口", () => {
  const props = {
    workspacePath: "C:/test",
    endedSubagentCount: 2,
    parentSessionId: "parent",
    onOpenSubagentDirectory: () => {},
  };
  for (const variant of ["panel", "mini"] as const) {
    const html = render(
      createElement(ConversationStatusPanel, { ...props, summaryPanelVariantOverride: variant }),
    );
    assert.match(html, /智能体/u);
    assert.match(html, /已结束/u);
    assert.match(html, /2/u);
  }
});

test("待办独立面板显示任务和进度，不依赖时间线工具显示开关", () => {
  const html = render(
    createElement(ConversationStatusPanel, {
      workspacePath: "C:/test",
      summaryPanelVariantOverride: "panel",
      plan: {
        updatedAt: 1000,
        items: [
          { id: "a", content: "确认完成", status: "completed" },
          { id: "b", content: "继续验证", status: "inProgress" },
        ],
      },
    }),
  );
  assert.match(html, /data-status-section="plan"/u);
  assert.match(html, /继续验证/u);
  assert.match(html.replace(/<[^>]*>/gu, ""), /1\/2/u);
});

test("每个 OMP 子代理使用真实任务、终态和独立详情入口渲染 Agent 卡片", () => {
  const context = {
    workspacePath: "C:/test",
    sessionId: "parent",
    theme: "dark",
    codePreviewSettings: {},
    onOpenSubagentSession: () => {},
  } as unknown as ConversationRowRenderContext;
  for (const [index, status] of ["running", "success", "failed", "cancelled"].entries()) {
    const row = {
      kind: "subagent",
      rowId: index + 1,
      turnId: "turn",
      entityId: `omp-subagent:${index}`,
      childSessionId: `omp-subagent:${index}@parent`,
      createdAt: 1000,
      createdAtSeq: index + 1,
      status,
      summaryText: `独立任务 ${index}`,
      subagentType: "scout",
    } as SubagentRow;
    const html = render(createElement(OmpSubagentRow, { row, context }));
    assert.match(html, new RegExp(`独立任务 ${index}`, "u"));
    assert.ok(html.includes(`omp-subagent:${index}@parent`));
    assert.doesNotMatch(html, /查看子代理记录/u);
  }
});

test("一对多 task 展示独立子代理卡片，未关联与失败的父工具仍可查看", () => {
  const children = ["a", "b"].map(
    (id, index) =>
      ({
        kind: "subagent",
        rowId: index + 2,
        turnId: "turn",
        entityId: `omp-subagent:${id}`,
        childSessionId: `omp-subagent:${id}@parent`,
        parentToolCallId: "task-parent",
        createdAt: 1000,
        createdAtSeq: index + 2,
        status: "running",
        summaryText: `任务 ${id}`,
        subagentType: "task",
      }) as SubagentRow,
  );
  const parent = {
    ...ompSubagentCardItem(children[0]).row,
    rowId: 1,
    toolName: "task",
    toolCallId: "task-parent",
  };
  const visibility = { showReasoning: false } as Parameters<
    typeof buildAssistantWorkRenderItems
  >[1];
  const items = buildAssistantWorkRenderItems([parent, ...children], visibility);
  assert.deepEqual(
    items.map((item) => (item.kind === "row" ? item.row.rowId : item.kind)),
    [2, 3],
  );
  for (const kept of [
    { ...parent, status: "error" as const },
    { ...parent, toolCallId: "unrelated" },
  ]) {
    assert.equal(buildAssistantWorkRenderItems([kept, ...children], visibility).length, 3);
  }
});

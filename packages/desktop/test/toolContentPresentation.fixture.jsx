// 隔离真实组件：不接入会话、模型或用户配置。
import React from "react";
import { createRoot } from "react-dom/client";
import { flushSync } from "react-dom";
import { ZCodeIntlProvider } from "../../ui/src/i18n/IntlProvider.tsx";
import { TooltipProvider } from "../../ui/src/components/ui/tooltip.tsx";
import { ToolInput, ToolOutput } from "../../ui/src/components/ai-elements/tool.tsx";
import { FallbackToolCallBlock } from "../../ui/src/ToolCallBlocks/renderers/fallback.tsx";
import { McpToolCallBlock } from "../../ui/src/ToolCallBlocks/renderers/mcp.tsx";
import { PlanGuidanceToolCallBlock } from "../../ui/src/ToolCallBlocks/renderers/plan-guidance.tsx";
import { applyTheme } from "../../ui/src/useTheme.ts";
import "../../ui/src/styles.css";

function context(id, overrides = {}) {
  return {
    toolCallNode: {
      toolCall: {
        toolId: id,
        toolName: "wait",
        kind: "wait",
        input: {},
        output: "fixture-result",
        status: "completed",
        raw: { marker: "raw-only-marker" },
        ...overrides,
      },
      childToolCalls: [],
    },
    displayModel: {
      inlinePreview: { type: "none" },
      planResult: null,
      viewerSource: null,
      viewerLabelId: "codeViewer.viewCode",
      showSummaryFileLink: false,
      showInput: true,
      showOutput: true,
      showKind: true,
    },
    workspacePath: "D:/fixture",
    viewerSource: null,
    rawFileSummaries: [],
    isRunning: false,
    statusLabel: "已执行",
    childToolList: null,
    forceOpen: true,
  };
}

const root = createRoot(document.getElementById("root"));
window.renderToolFixture = (theme = "light") => {
  applyTheme(theme);
  flushSync(() =>
    root.render(
      <ZCodeIntlProvider initialLocale="zh-CN">
        <TooltipProvider>
          <main className="min-w-0 space-y-4 bg-background p-4 text-foreground">
            <section id="empty">
              <ToolInput input={{}} />
              <ToolInput input={[]} />
            </section>
            <section id="zero">
              <ToolOutput output={0} />
            </section>
            <section id="false">
              <ToolOutput output={false} />
            </section>
            <section id="plain">
              <ToolOutput output={"first\n" + "long-text-".repeat(60) + "\nlast"} />
            </section>
            <section id="wait">
              <FallbackToolCallBlock {...context("fixture-wait")} />
            </section>
            <section id="json">
              <ToolOutput output={'{"value":0}'} />
            </section>
            <section id="markdown">
              <FallbackToolCallBlock
                {...context("fixture-markdown", {
                  output: "## Completed (1)\n\n```text\n<task-result>hello</task-result>\n```",
                })}
              />
            </section>
            <section id="mcp-empty">
              <McpToolCallBlock
                {...context("fixture-mcp-empty", {
                  toolName: "mcp__fixture__read",
                  output: "mcp-result",
                })}
              />
            </section>
            <section id="mcp-params">
              <McpToolCallBlock
                {...context("fixture-mcp-params", {
                  toolName: "mcp__fixture__read",
                  input: { id: "task-123" },
                  output: "mcp-result",
                })}
              />
            </section>
            <section id="plan-error">
              <PlanGuidanceToolCallBlock
                {...context("fixture-plan-error", {
                  status: "failed",
                  output: "hidden-guidance",
                  error: "visible-plan-error",
                })}
              />
            </section>
          </main>
        </TooltipProvider>
      </ZCodeIntlProvider>,
    ),
  );
};
window.renderToolFixture();

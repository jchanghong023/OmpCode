import { WrenchIcon } from "lucide-react";
import { useCallback, useState, type ReactNode } from "react";
import { MessageResponse } from "@/components/ai-elements/message.js";
import {
  Collapsible,
  CollapsibleContent,
  CollapsibleTrigger,
} from "@/components/ui/collapsible.js";
import { ToolCallBody } from "@/ToolCallBlocks/ToolCallBody.js";
import { ToolSnapshotFieldNotice } from "@/ToolCallBlocks/ToolSnapshotFieldNotice.js";
import { useZCodeIntl } from "@/i18n/IntlProvider.js";
import { ToolLayout } from "../ToolLayout.js";
import type { ToolCallBlockRenderContext } from "../shared.js";

const FALLBACK_TOOL_ICON = <WrenchIcon className="size-4 shrink-0 text-foreground-subtle" />;

interface FallbackToolCallBlockProps extends ToolCallBlockRenderContext {
  iconOverride?: ReactNode;
  hideRawFallback?: boolean;
  summaryOnly?: boolean;
  summaryTextOverride?: ReactNode;
}

export function FallbackToolCallBlock(context: FallbackToolCallBlockProps) {
  const { intl } = useZCodeIntl();
  const {
    toolCallNode,
    isRunning,
    statusLabel,
    errorText,
    childToolList,
    displayModel,
    workspacePath,
    theme,
    codePreviewSettings,
    onOpenCodeViewer,
    onOpenFileLink,
    onOpenBrowserUrl,
  } = context;
  const { toolCall } = toolCallNode;
  const [rawOpen, setRawOpen] = useState(false);
  // 修复依据：通用卡将文本当 JSON 且重复展开 raw，空参数和 kind 进一步挤占结果空间。
  const bodyDisplayModel = {
    ...displayModel,
    showKind: false,
  };
  const outputOverride =
    typeof toolCall.output === "string" && /^\s{0,3}(?:#{1,6}\s|```)/m.test(toolCall.output) ? (
      <MessageResponse
        workspacePath={workspacePath}
        theme={theme}
        codePreviewSettings={codePreviewSettings}
        onOpenCodeViewer={onOpenCodeViewer}
        onOpenFileLink={onOpenFileLink}
        onOpenExternalUrl={onOpenBrowserUrl}
        className="min-w-0 break-words px-3 py-2"
      >
        {toolCall.output}
      </MessageResponse>
    ) : undefined;
  const kindLabel =
    toolCall.kind.length > 0
      ? toolCall.kind[0]!.toUpperCase() + toolCall.kind.slice(1)
      : toolCall.kind;
  const hasInlinePreview = displayModel.inlinePreview.type !== "none";
  const handleLoadFullToolCallFields = context.onLoadFullToolCallFields;
  const renderContent = useCallback(
    () => (
      <>
        <ToolCallBody
          childToolList={childToolList}
          displayModel={bodyDisplayModel}
          outputOverride={outputOverride}
          toolCall={toolCall}
          workspacePath={workspacePath}
          theme={theme}
          codePreviewSettings={codePreviewSettings}
          onOpenCodeViewer={onOpenCodeViewer}
          onOpenFileLink={onOpenFileLink}
          onOpenBrowserUrl={onOpenBrowserUrl}
        />
        <ToolSnapshotFieldNotice
          refs={toolCall.snapshotRefs ?? []}
          onLoadFullToolCallFields={
            handleLoadFullToolCallFields
              ? () => handleLoadFullToolCallFields(toolCall.toolId)
              : undefined
          }
        />
        {!hasInlinePreview && !context.hideRawFallback ? (
          <Collapsible open={rawOpen} onOpenChange={setRawOpen} className="mt-2">
            <CollapsibleTrigger className="rounded-lg px-2 py-1 text-ui-caption text-foreground-subtle hover:bg-hover">
              {intl.formatMessage({ id: "chat.toolCall.cua.details.raw" })}
            </CollapsibleTrigger>
            <CollapsibleContent>
              {rawOpen ? (
                <pre className="px-3 py-2 rounded-lg bg-surface text-ui-xs mt-1 text-foreground-subtle max-h-50 overflow-auto whitespace-pre-wrap break-words">
                  {JSON.stringify(toolCall, null, 2)}
                </pre>
              ) : null}
            </CollapsibleContent>
          </Collapsible>
        ) : null}
      </>
    ),
    [
      childToolList,
      codePreviewSettings,
      bodyDisplayModel,
      handleLoadFullToolCallFields,
      hasInlinePreview,
      onOpenBrowserUrl,
      onOpenCodeViewer,
      onOpenFileLink,
      theme,
      toolCall,
      workspacePath,
      outputOverride,
      rawOpen,
      intl,
      context.hideRawFallback,
    ],
  );

  return (
    <ToolLayout
      toolId={toolCall.toolId}
      icon={context.iconOverride ?? FALLBACK_TOOL_ICON}
      showIcon={context.showIcon !== false}
      canToggle={context.canToggle ?? true}
      forceOpen={context.forceOpen ?? false}
      kindLabel={context.summaryOnly ? null : (context.kindLabelOverride ?? kindLabel)}
      sourceLabel={context.sourceLabel}
      primaryText={
        context.summaryOnly
          ? (context.summaryTextOverride ?? null)
          : (toolCall.title ?? intl.formatMessage({ id: "chat.toolCall.toolCall" }))
      }
      secondaryText={context.summaryOnly || toolCall.status === "failed" ? undefined : statusLabel}
      statusLabel={toolCall.status === "failed" ? statusLabel : undefined}
      statusTooltip={toolCall.status === "failed" ? errorText : undefined}
      showFailureStatus={toolCall.status === "failed"}
      isRunning={isRunning}
      title={
        context.summaryOnly && typeof context.summaryTextOverride === "string"
          ? context.summaryTextOverride
          : toolCall.title
      }
      renderContent={renderContent}
    />
  );
}

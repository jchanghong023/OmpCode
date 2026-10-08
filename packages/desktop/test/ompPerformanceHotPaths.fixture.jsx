// 真实组件 DOM 验收；只提供输入数据，不替换产品组件或其渲染实现。
import React from "react";
import { createRoot } from "react-dom/client";
import { flushSync } from "react-dom";
import { ZCodeIntlProvider } from "../../ui/src/i18n/IntlProvider.tsx";
import { TooltipProvider } from "../../ui/src/components/ui/tooltip.tsx";
import {
  Reasoning,
  ReasoningTrigger,
  ReasoningContent,
} from "../../ui/src/components/ai-elements/reasoning.tsx";
import { CodeBlock, CodeBlockHeader } from "../../ui/src/components/ai-elements/code-block.tsx";
import { ConversationTimeline } from "../../ui/src/v4/ConversationTimeline.tsx";
import { DEFAULT_CODE_PREVIEW_SETTINGS } from "../../ui/src/lib/codePreviewSettings.ts";
import { ConversationComposer } from "../../ui/src/v4/ConversationComposer.tsx";
import { createComposerDraftOwner } from "../../ui/src/v4/composer/composerDraftOwner.ts";
import { PlatformProvider } from "../../ui/src/hooks/usePlatform.tsx";
import { ServiceProvider } from "../../ui/src/hooks/useServices.tsx";
import { TabStoreProvider } from "../../ui/src/store/TabStoreProvider.tsx";
import { StoreProvider } from "../../ui/src/store/StoreProvider.tsx";
import { DiffsWorkerPoolProvider } from "../../ui/src/root/DiffsWorkerPoolProvider.tsx";
import { applyTheme } from "../../ui/src/useTheme.ts";
import { FileProviderFixture } from "./ompPerformanceHotPaths.fileProviderFixture.jsx";
import { DraftHookFixture } from "./ompPerformanceHotPaths.draftHookFixture.jsx";
import {
  readComposerAttachmentScope,
  updateComposerAttachmentScope,
} from "../../ui/src/store/composerAttachmentUploadStore.ts";
import "../../ui/src/styles.css";

const root = createRoot(document.getElementById("root"));
let state = {
  reasoning: "首行\r\n尾行\r\n\r\n",
  code: "const value = 1;\n",
  open: false,
  streaming: true,
  language: "typescript",
  theme: "github-light",
  mode: "blocks",
  rows: [],
  canLoadOlder: false,
  findQuery: "",
  composerScope: "a",
  externalTextInsertRequest: null,
  hookScope: "hook-a",
  secondPane: false,
};
const platform = { canSelectFilePath: false };
const services = { promptAttachmentTransferService: {} };
const broadcastService = { onMessage: () => ({ dispose: () => {} }), send: () => {} };
const snapshot = {
  inputRouting: { mode: "enqueue" },
  control: { canStop: true, phase: "running" },
  config: { provider: "fixture", model: "fixture", followupMode: "queue" },
  usage: {},
  backgroundWorks: [],
  hasHistoryMessages: true,
};
const latestSnapshot = { ...snapshot, queue: { items: [] } };
const owners = new Map();
const pendingSends = [];
const noop = () => {};
function getOwner(scope) {
  if (!owners.has(scope))
    owners.set(
      scope,
      createComposerDraftOwner({
        workspacePath: "component-fixture",
        scopeId: scope,
        draft: {
          text: "",
          mode: "build",
          modelSelection: { providerId: "fixture", modelId: "fixture" },
          updatedAt: 0,
        },
      }),
    );
  return owners.get(scope);
}
function ComposerFixture() {
  const owner = getOwner(state.composerScope);
  return (
    <TabStoreProvider>
      <PlatformProvider platform={platform}>
        <ServiceProvider services={services}>
          <ConversationComposer
            snapshot={snapshot}
            readLatestSnapshot={() => latestSnapshot}
            sessionId={state.composerScope}
            workspacePath="component-fixture"
            parentModelOnly
            attachmentSessionId={state.composerScope}
            attachmentPut={async () => {
              throw Error("Unexpected attachment");
            }}
            listenAddToChatEvents={false}
            externalTextInsertRequest={state.externalTextInsertRequest}
            composerDraft={owner.draft}
            updateComposerContent={(content) => {
              owner.draft = {
                ...owner.draft,
                editorStateJson: undefined,
                mention: undefined,
                ...content,
              };
              owner.schedule();
            }}
            markComposerDraftDirty={owner.schedule}
            flushComposerDraft={owner.flush}
            registerComposerContentReader={(reader) => {
              owner.contentReader = reader;
              return () => {
                owner.flush();
                owner.contentReader = null;
              };
            }}
            replaceComposerDraft={(draft) => {
              owner.draft = { ...draft, updatedAt: 0 };
              owner.schedule();
            }}
            submissionReady
            createSubmissionFromComposer={() => ({
              mode: "build",
              planEnabled: false,
              modelSelection: {
                providerId: "fixture",
                modelId: "fixture",
                options: { reasoningLevel: "off" },
              },
            })}
            onSendText={(text, options) =>
              new Promise((resolve, reject) =>
                pendingSends.push({ text, options, resolve, reject }),
              )
            }
            onStop={noop}
            onSelectModel={noop}
            onSelectThought={noop}
            onSwitchMode={noop}
          />
        </ServiceProvider>
      </PlatformProvider>
    </TabStoreProvider>
  );
}
const rowContext = {
  workspacePath: "component-fixture",
  theme: "light",
  codePreviewSettings: DEFAULT_CODE_PREVIEW_SETTINGS,
  messageStreamShowReasoning: true,
};
const timelineEvents = { olderLoads: 0, find: null };
const onFind = (value) => {
  timelineEvents.find = value;
};
function turnRows(turn, running = false) {
  const turnId = `fixture-turn-${turn}`;
  const startedAt = Date.now() - 2_000;
  return [
    {
      kind: "turnHeader",
      rowId: turn * 10,
      turnId,
      executionKind: "agent",
      state: running ? "running" : "completedSuccess",
      startedAt,
      ...(running ? {} : { endedAt: startedAt + 1_000 }),
    },
    {
      kind: "userInput",
      rowId: turn * 10 + 1,
      turnId,
      productTurnId: turnId,
      entityId: `input-${turn}`,
      createdAtSeq: turn * 10 + 1,
      origin: "realUser",
      text: `question-${turn}`,
    },
    {
      kind: "reasoning",
      rowId: turn * 10 + 2,
      turnId,
      text: `thinking-${turn}`,
      state: running ? "streaming" : "complete",
    },
    {
      kind: "assistantText",
      rowId: turn * 10 + 3,
      turnId,
      text: `answer-${turn}`,
      state: running ? "streaming" : "complete",
    },
  ];
}
function loadOlder() {
  timelineEvents.olderLoads++;
  render({ rows: [...turnRows(0), ...state.rows], canLoadOlder: false });
}
const observedContainers = new Set();
const errors = [];
window.addEventListener("error", (event) => errors.push(event.message));
window.addEventListener("unhandledrejection", (event) => errors.push(String(event.reason)));
function View() {
  return (
    <ZCodeIntlProvider initialLocale="zh-CN">
      <StoreProvider broadcastService={broadcastService}>
        <DiffsWorkerPoolProvider>
          <TooltipProvider>
            {state.mode === "draft-hooks" ? (
              <DraftHookFixture scope={state.hookScope} secondPane={state.secondPane} />
            ) : state.mode === "file-provider" ? (
              <FileProviderFixture />
            ) : state.mode === "composer" ? (
              <ComposerFixture />
            ) : state.mode === "timeline" ? (
              <div
                className="@container/conversation flex min-h-0 w-full flex-col"
                style={{ height: 720 }}
              >
                <ConversationTimeline
                  rows={state.rows}
                  totalCount={state.rows.length}
                  sessionKey="fixture-timeline"
                  rowContext={rowContext}
                  sessionPhase={state.streaming ? "running" : "idle"}
                  canLoadOlder={state.canLoadOlder}
                  onLoadOlder={loadOlder}
                  conversationFindQuery={state.findQuery}
                  onConversationFindMatchStateChange={onFind}
                />
              </div>
            ) : (
              <main className="mx-auto flex max-w-3xl flex-col gap-4 p-4 text-ui-base">
                <h1 className="text-ui-xl">流式组件验收</h1>
                <Reasoning isStreaming={state.streaming} open={state.open}>
                  <ReasoningTrigger streamingText={state.reasoning} />
                  <ReasoningContent>{state.reasoning}</ReasoningContent>
                </Reasoning>
                <CodeBlock
                  code={state.code}
                  language={state.language}
                  theme={state.theme}
                  enableSyntaxHighlighting={!state.streaming}
                  renderMermaid={false}
                  showLineNumbers
                >
                  <CodeBlockHeader language={state.language} />
                </CodeBlock>
              </main>
            )}
          </TooltipProvider>
        </DiffsWorkerPoolProvider>
      </StoreProvider>
    </ZCodeIntlProvider>
  );
}
const observer = new MutationObserver(() => {
  for (const element of document.querySelectorAll("diffs-container")) {
    observedContainers.add(element);
  }
});
observer.observe(document.getElementById("root"), { childList: true, subtree: true });
function render(next = {}) {
  state = { ...state, ...next };
  applyTheme(state.theme.includes("dark") ? "zai-dark" : "zai-light");
  flushSync(() => root.render(<View />));
}
window.performanceFixture = {
  render,
  state: () => ({ ...state }),
  timeline: () => ({ ...timelineEvents }),
  turnRows,
  composer: () => ({
    pending: pendingSends.map(({ text, options }) => ({ text, options })),
    owner: getOwner(state.composerScope).draft,
  }),
  respond: (result = "blocked") => {
    const request = pendingSends.shift();
    if (result === "throw") request.reject(new Error("fixture-send-failure"));
    else request.resolve(result);
  },
  flush: () => getOwner(state.composerScope).flush(),
  attachments: (scope) => readComposerAttachmentScope(`component-fixture\u0000${scope}`),
  addAttachment: (scope, id, uploadError) =>
    updateComposerAttachmentScope(`component-fixture\u0000${scope}`, (items) => [
      ...items,
      {
        id,
        filename: `${id}.txt`,
        mimeType: "text/plain",
        sizeBytes: 1,
        referenceOwnership: "session",
        uploadStatus: uploadError ? "failed" : "ready",
        uploadProgress: 100,
        uploadError,
        uploadErrorKind: uploadError ? "permanent" : undefined,
        attachmentRef: {
          ref: `fixture://${id}`,
          fileName: `${id}.txt`,
          mime: "text/plain",
          bytes: 1,
        },
        operationId: `session-owned-${id}`,
        autoRetryCount: 0,
        runtimeRebuildRetryCount: 0,
        staged: false,
        adopted: true,
        showComplete: false,
        localZeroCopy: false,
      },
    ]),
  status: () => ({
    errors,
    containerCount: observedContainers.size,
    content: [...document.querySelectorAll("diffs-container")]
      .map((element) => element.shadowRoot?.textContent ?? "")
      .join("\n"),
  }),
  highlightInspection: () => {
    const shadow = document.querySelector("diffs-container")?.shadowRoot;
    const tokens = [...(shadow?.querySelectorAll("[data-line] span") ?? [])].map((node) => ({
      text: node.textContent,
      color: getComputedStyle(node).color,
    }));
    return {
      tokens,
      colorScheme: shadow?.querySelector("pre")?.getAttribute("data-theme-type"),
      background: shadow?.querySelector("pre")
        ? getComputedStyle(shadow.querySelector("pre")).backgroundColor
        : null,
    };
  },
};
render();

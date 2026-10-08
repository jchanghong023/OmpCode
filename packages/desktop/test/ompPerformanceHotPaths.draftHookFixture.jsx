import React from "react";
import { V4_WIRE_PROTOCOL_VERSION } from "@zcode/shared/zcode-protocol-v4";
import { ComposerDraftMigrationEvents } from "../../ui/src/hooks/useComposerDraftMigrationEvents.tsx";
import { useDraftConfigControl } from "../../ui/src/v4/composer/useDraftConfigControl.ts";
import { ConversationComposer } from "../../ui/src/v4/ConversationComposer.tsx";
import { TabStoreProvider } from "../../ui/src/store/TabStoreProvider.tsx";
import { PlatformProvider } from "../../ui/src/hooks/usePlatform.tsx";
import { ServiceProvider } from "../../ui/src/hooks/useServices.tsx";
import { useTaskQueryCacheStore } from "../../ui/src/store/taskQueryCacheStore.ts";
import {
  readComposerAttachmentScope,
  updateComposerAttachmentScope,
} from "../../ui/src/store/composerAttachmentUploadStore.ts";

const WORKSPACE_PATH = "component-draft-hooks";
const MIGRATION_SCOPES = [{ workspacePath: WORKSPACE_PATH }];
const controls = new Map();
const pending = [];
const workspaceEventListeners = new Set();
const noop = () => {};
const platform = { canSelectFilePath: false };
const mentionFiles = [
  "共享文件.ts",
  "submitted-sent.ts",
  "newer-sent.ts",
  "submitted-throw.ts",
  "newer-throw.ts",
].map((name) => ({
  name,
  path: `${WORKSPACE_PATH}/${name}`,
  relativePath: name,
  type: "file",
}));
const fileService = {
  searchWorkspaceFiles: async ({ query }) =>
    mentionFiles.filter((file) => file.name.toLowerCase().includes(query.toLowerCase())),
};
const emptyPluginManagementService = {
  getPluginReferenceCatalog: async ({ sessionId }) => ({
    plugins: [],
    authority: sessionId ? "session" : "workspace",
  }),
};
const emptyZcodeAgentService = {
  helloConversationV4: async () => ({
    kind: "hello",
    protocolVersion: V4_WIRE_PROTOCOL_VERSION,
    connectionId: "draft-hook-fixture",
    clientMode: "desktop-continuous",
    deliveryProfile: "continuous",
    serverTime: Date.now(),
    capabilities: {
      nativeDialogs: false,
      localTerminal: false,
      binaryFrames: false,
      compression: "none",
    },
    auth: {},
  }),
  initializeConversationV4: async () => {},
  subscribeSessionsIndexV4: async () => ({
    ack: {
      subscriptionId: "draft-hook-empty-sessions-index",
      mode: "snapshot",
      logEpoch: "draft-hook-fixture",
    },
  }),
  resyncSessionsIndexV4: async () => ({
    ack: {
      subscriptionId: "draft-hook-empty-sessions-index",
      mode: "snapshot",
      logEpoch: "draft-hook-fixture",
    },
  }),
  unsubscribeSessionsIndexV4: async () => {},
  onDynamicSessionsIndexFrame: () => () => ({ dispose: noop }),
  onAgentRuntimeRestarted: () => ({ dispose: noop }),
};
const clientConfigService = {
  getSnapshot: async () => ({ pluginStoreOrder: null }),
};
const emptySubagentsService = {
  list: async () => ({
    agents: [],
    userAgents: [],
    pluginAgents: [],
    capability: { userScopeAvailable: false },
  }),
};
const services = {
  fileService,
  clientConfigService,
  pluginManagementService: emptyPluginManagementService,
  zcodeAgentService: emptyZcodeAgentService,
  settingService: { get: async () => ({}) },
  zcodeSessionService: {},
  subagentsService: emptySubagentsService,
  promptAttachmentTransferService: {},
  zcodeTaskService: {
    onDynamicWorkspaceEvent: (scope) => (listener) => {
      const subscription = { scope, listener };
      workspaceEventListeners.add(subscription);
      return { dispose: () => workspaceEventListeners.delete(subscription) };
    },
  },
  broadcastService: { onMessage: () => ({ dispose: noop }), send: noop },
};
const config = {
  mode: "build",
  provider: "fixture",
  model: "fixture",
  thought: "off",
  followupMode: "queue",
};
const snapshot = {
  inputRouting: { mode: "enqueue" },
  control: { canStop: true, phase: "running" },
  config,
  usage: {},
  backgroundWorks: [],
  hasHistoryMessages: true,
};
const latest = { ...snapshot, queue: { items: [] } };

function makeMigrationMeta(fromTaskId, toTaskId) {
  return {
    taskId: toTaskId,
    traceId: toTaskId,
    title: "draft migration fixture",
    workspacePath: WORKSPACE_PATH,
    createdAt: 1,
    updatedAt: 1,
    mode: "build",
    taskIdMigration: { fromTaskId, toTaskId },
  };
}
function attachmentScope(scope) {
  return `${WORKSPACE_PATH}\u0000${scope}`;
}
function addAttachment(scope, id) {
  updateComposerAttachmentScope(attachmentScope(scope), (items) => [
    ...items,
    {
      id,
      filename: `${id}.txt`,
      mimeType: "text/plain",
      sizeBytes: 1,
      referenceOwnership: "session",
      uploadStatus: "ready",
      uploadProgress: 100,
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
  ]);
}

function Pane({ paneId, scope }) {
  const control = useDraftConfigControl({
    workspacePath: WORKSPACE_PATH,
    sessionId: scope,
    sessionConfig: config,
    agentStartupAllowed: false,
    modelSelectionService: null,
  });
  controls.set(paneId, control);
  return (
    <section data-testid={`draft-hook-${paneId}`}>
      <ConversationComposer
        {...control}
        snapshot={snapshot}
        readLatestSnapshot={() => latest}
        sessionId={scope}
        workspacePath={WORKSPACE_PATH}
        parentModelOnly={false}
        attachmentSessionId={scope}
        attachmentPut={async () => {
          throw Error("Unexpected attachment upload");
        }}
        listenAddToChatEvents={false}
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
            pending.push({ paneId, scope, text, options, resolve, reject }),
          )
        }
        onStop={noop}
        onSelectModel={noop}
        onSelectThought={noop}
        onSwitchMode={noop}
      />
    </section>
  );
}

export function DraftHookFixture({ scope, secondPane, rightScope, migrationEvents = true }) {
  window.draftHookFixture = {
    read: (paneId) =>
      controls.get(paneId)?.readComposerDraft?.() ?? controls.get(paneId)?.composerDraft,
    pending: () =>
      pending.map(({ paneId, scope: target, text, options }) => ({
        paneId,
        scope: target,
        text,
        attachmentRefs: (options.attachments ?? []).map(({ ref }) => ref),
      })),
    respond: (result) => {
      const request = pending.shift();
      if (result === "throw") request.reject(new Error("source-scope-failure"));
      else request.resolve(result);
    },
    flush: (paneId) => controls.get(paneId).flushComposerDraft(),
    selectModel: (paneId, provider, model) =>
      controls.get(paneId).handleDraftSelectModel(provider, model),
    selectThought: (paneId, thought) => controls.get(paneId).handleDraftSelectThought(thought),
    attachments: (target) => readComposerAttachmentScope(attachmentScope(target)),
    addAttachment,
    primeCachedMigration: (fromTaskId, toTaskId) =>
      useTaskQueryCacheStore.getState().upsertTaskMeta(makeMigrationMeta(fromTaskId, toTaskId)),
    publishWorkspaceEvent: (event) => {
      let delivered = 0;
      const eventWorkspaceKey = event.workspaceIdentity?.trim() || event.workspacePath;
      for (const { scope: subscribedScope, listener } of workspaceEventListeners) {
        const subscribedWorkspaceKey =
          subscribedScope.workspaceIdentity?.trim() || subscribedScope.workspacePath;
        if (subscribedWorkspaceKey !== eventWorkspaceKey) continue;
        listener(event);
        delivered++;
      }
      return delivered;
    },
    migrationSubscriptionCount: () => workspaceEventListeners.size,
  };
  return (
    <TabStoreProvider>
      <PlatformProvider platform={platform}>
        <ServiceProvider services={services}>
          {migrationEvents ? <ComposerDraftMigrationEvents scopes={MIGRATION_SCOPES} /> : null}
          <Pane paneId="left" scope={scope} />
          {secondPane ? <Pane paneId="right" scope={rightScope ?? scope} /> : null}
        </ServiceProvider>
      </PlatformProvider>
    </TabStoreProvider>
  );
}

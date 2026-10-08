import React from "react";
import { useDraftConfigControl } from "../../ui/src/v4/composer/useDraftConfigControl.ts";
import { ConversationComposer } from "../../ui/src/v4/ConversationComposer.tsx";
import { TabStoreProvider } from "../../ui/src/store/TabStoreProvider.tsx";
import { PlatformProvider } from "../../ui/src/hooks/usePlatform.tsx";
import { ServiceProvider } from "../../ui/src/hooks/useServices.tsx";

const controls = new Map();
const pending = [];
const noop = () => {};
const platform = { canSelectFilePath: false };
const services = {
  settingService: { get: async () => ({}) },
  zcodeSessionService: {},
  promptAttachmentTransferService: {},
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
function Pane({ paneId, scope }) {
  const control = useDraftConfigControl({
    workspacePath: "component-draft-hooks",
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
        workspacePath="component-draft-hooks"
        parentModelOnly
        attachmentSessionId={scope}
        attachmentPut={async () => {
          throw Error("Unexpected attachment");
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
export function DraftHookFixture({ scope, secondPane }) {
  window.draftHookFixture = {
    read: (paneId) =>
      controls.get(paneId)?.readComposerDraft?.() ?? controls.get(paneId)?.composerDraft,
    pending: () => pending.map(({ scope: target, text }) => ({ scope: target, text })),
    respond: (result) => {
      const request = pending.shift();
      if (result === "throw") request.reject(new Error("source-scope-failure"));
      else request.resolve(result);
    },
    flush: (paneId) => controls.get(paneId).flushComposerDraft(),
  };
  return (
    <TabStoreProvider>
      <PlatformProvider platform={platform}>
        <ServiceProvider services={services}>
          <Pane paneId="left" scope={scope} />
          {secondPane ? <Pane paneId="right" scope={scope} /> : null}
        </ServiceProvider>
      </PlatformProvider>
    </TabStoreProvider>
  );
}

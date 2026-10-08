import assert from "node:assert/strict";
import test from "node:test";
import { registerHooks } from "node:module";
import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import {
  bindOmpAgentInteractionsRoot,
  closeVisibleSidePaneTabs,
  closeVisibleOtherSidePaneTabs,
  getVisibleSidePaneTabs,
  openOmpAgentInteractionsSidePane,
  resolveSidePaneScopeState,
  syncSubagentSessionSidePaneTabs,
} from "../src/lib/workspaceSidePane.js";
import { shouldMountOmpAgentInteractionsTab } from "../src/app-shell/animatedSidePanePanelModel.js";
import { ZCodeIntlProvider } from "../src/i18n/IntlProvider.js";
import { TooltipProvider } from "../src/components/ui/tooltip.js";

registerHooks({
  load(url, context, nextLoad) {
    if (/\.svg(?:\?.*)?$/u.test(url))
      return { format: "module", shortCircuit: true, source: 'export default "test-icon.svg";' };
    return nextLoad(url, context);
  },
});
const { ConversationStatusPanel } = await import("../src/v4/ConversationStatusPanel.js");

const request = {
  workspacePath: "/workspace",
  workspaceIdentity: "remote-workspace",
  remoteSessionId: "remote-host",
  rootSessionId: "live-root",
};
const scope = {
  workspaceKey: request.workspaceIdentity,
  remoteSessionId: request.remoteSessionId,
  ownerTaskId: request.rootSessionId,
};

test("interaction tabs deduplicate within exact workspace/remote/root scope", () => {
  const first = openOmpAgentInteractionsSidePane(null, request);
  const second = openOmpAgentInteractionsSidePane(first, {
    ...request,
    workspaceIdentity: " remote-workspace ",
  });
  assert.equal(second.tabs.length, 1);
  assert.equal(second.activeTabId, first.activeTabId);
  const anotherRemote = openOmpAgentInteractionsSidePane(second, {
    ...request,
    remoteSessionId: "another-host",
  });
  assert.equal(anotherRemote.tabs.length, 2);
  const anotherRoot = openOmpAgentInteractionsSidePane(anotherRemote, {
    ...request,
    rootSessionId: "other-root",
  });
  assert.equal(anotherRoot.tabs.length, 3);
  assert.equal(getVisibleSidePaneTabs(anotherRoot.tabs, scope).length, 1);
  assert.equal(
    getVisibleSidePaneTabs(anotherRoot.tabs, { ...scope, remoteSessionId: "unrelated" }).length,
    0,
  );
  assert.equal(
    getVisibleSidePaneTabs(anotherRoot.tabs, { ...scope, workspaceKey: "unrelated" }).length,
    0,
  );
  const closed = closeVisibleSidePaneTabs(anotherRemote, request.rootSessionId, scope)!;
  assert.equal(closed.tabs.length, 1);
  assert.equal(
    closed.tabs[0]!.type === "omp-agent-interactions" && closed.tabs[0]!.remoteSessionId,
    "another-host",
  );
  assert.equal(
    closeVisibleOtherSidePaneTabs(anotherRemote, first.activeTabId, request.rootSessionId, scope)!
      .tabs.length,
    2,
  );
  assert.equal(
    resolveSidePaneScopeState(first, { ...scope, ownerTaskId: "other-root" }).isSidePaneCollapsed,
    true,
  );
  assert.equal(
    syncSubagentSessionSidePaneTabs(first, {
      rootSessionId: "live-root",
      parentSessionId: "live-root",
      validChildSessionIds: [],
    }),
    first,
  );
});

test("first persisted root binds both live and stable owners without reopening a second tab", () => {
  const first = openOmpAgentInteractionsSidePane(null, request);
  const binding = { ...request, tabId: first.activeTabId, canonicalRootSessionId: "saved-root" };
  const bound = bindOmpAgentInteractionsRoot(first, binding)!;
  assert.equal(bound.activeTabId, first.activeTabId);
  assert.equal(getVisibleSidePaneTabs(bound.tabs, scope).length, 1);
  assert.equal(
    getVisibleSidePaneTabs(bound.tabs, { ...scope, ownerTaskId: "saved-root" }).length,
    1,
  );
  const reopened = openOmpAgentInteractionsSidePane(bound, {
    ...request,
    rootSessionId: "saved-root",
  });
  assert.equal(reopened.tabs.length, 1);
  assert.equal(reopened.activeTabId, first.activeTabId);
  const liveReopened = openOmpAgentInteractionsSidePane(reopened, request);
  assert.equal(
    liveReopened.tabs[0]!.type === "omp-agent-interactions" && liveReopened.tabs[0]!.rootSessionId,
    "saved-root",
  );
  assert.equal(
    bindOmpAgentInteractionsRoot(bound, { ...binding, canonicalRootSessionId: "stale-other-root" }),
    bound,
  );
  assert.equal(
    bindOmpAgentInteractionsRoot(first, { ...binding, remoteSessionId: "other-host" }),
    first,
  );
  assert.equal(
    bindOmpAgentInteractionsRoot(first, { ...binding, workspaceIdentity: "other-workspace" }),
    first,
  );
  assert.equal(
    openOmpAgentInteractionsSidePane(bound, {
      ...request,
      workspaceIdentity: "other-workspace",
      rootSessionId: "saved-root",
    }).tabs.length,
    2,
  );
});

test("only a visible selected tab within current scope mounts query and graphics", () => {
  for (const isSidePaneVisible of [true, false])
    for (const isActiveTab of [true, false])
      for (const isCurrentScope of [true, false]) {
        assert.equal(
          shouldMountOmpAgentInteractionsTab({ isSidePaneVisible, isActiveTab, isCurrentScope }),
          isSidePaneVisible && isActiveTab && isCurrentScope,
        );
      }
});

test("late live-root binding merges a concurrently opened canonical tab while retaining the active view", () => {
  const live = openOmpAgentInteractionsSidePane(null, request);
  const canonical = openOmpAgentInteractionsSidePane(live, {
    ...request,
    rootSessionId: "saved-root",
  });
  const differentRemote = openOmpAgentInteractionsSidePane(canonical, {
    ...request,
    remoteSessionId: "other-host",
    rootSessionId: "saved-root",
  });
  const activeCanonical = { ...differentRemote, activeTabId: canonical.activeTabId };
  const bound = bindOmpAgentInteractionsRoot(activeCanonical, {
    ...request,
    tabId: live.activeTabId,
    canonicalRootSessionId: "saved-root",
  })!;
  assert.equal(bound.tabs.length, 2);
  assert.equal(bound.activeTabId, canonical.activeTabId);
  assert.equal(getVisibleSidePaneTabs(bound.tabs, scope).length, 1);
  assert.equal(
    getVisibleSidePaneTabs(bound.tabs, { ...scope, ownerTaskId: "saved-root" }).length,
    1,
  );
  assert.equal(
    getVisibleSidePaneTabs(bound.tabs, {
      ...scope,
      remoteSessionId: "other-host",
      ownerTaskId: "saved-root",
    }).length,
    1,
  );
  assert.equal(openOmpAgentInteractionsSidePane(bound, request).tabs.length, 2);
  const activeLive = bindOmpAgentInteractionsRoot(
    { ...canonical, activeTabId: live.activeTabId },
    { ...request, tabId: live.activeTabId, canonicalRootSessionId: "saved-root" },
  )!;
  assert.equal(activeLive.activeTabId, live.activeTabId);
  assert.equal(activeLive.tabs.length, 1);
});

test("root can open empty interaction page after expanding agents; collapsed section has no entry", () => {
  const render = (agentSectionOpen: boolean, variant: "panel" | "mini" = "panel") =>
    renderToStaticMarkup(
      createElement(
        ZCodeIntlProvider,
        { initialLocale: "zh-CN" },
        createElement(
          TooltipProvider,
          {},
          createElement(ConversationStatusPanel, {
            workspacePath: "/workspace",
            parentSessionId: "root",
            rootSessionId: "root",
            agentSectionOpen,
            summaryPanelVariantOverride: variant,
            onOpenOmpAgentInteractions: () => {},
          }),
        ),
      ),
    );
  assert.match(render(true), /data-testid="omp-agent-interactions-open"/u);
  assert.match(render(true), /Agent 交互/u);
  assert.doesNotMatch(render(false), /data-testid="omp-agent-interactions-open"/u);
  assert.match(render(false, "mini"), /智能体/u);
  assert.doesNotMatch(render(false, "mini"), /data-testid="omp-agent-interactions-open"/u);
});

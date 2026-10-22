// @vitest-environment jsdom
import { act, cleanup, renderHook, waitFor } from "@testing-library/react";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import type { OmpProfileState } from "@zcode/shared";
import { useMemo, useState } from "react";
import { useOmpStorageScope, useZCodeAgentService } from "../src/hooks/useZCodeAgentService.js";

const agent = vi.hoisted(() => ({
  getOmpProfiles: vi.fn<() => Promise<OmpProfileState>>(),
  onAgentRuntimeRestarted: vi.fn(() => ({ dispose: vi.fn() })),
  onAgentRuntimeLifecycle: vi.fn(() => ({ dispose: vi.fn() })),
}));
const globalAgent = vi.hoisted(() => ({ kind: "global-context-agent" }));
vi.mock("@/hooks/useServices.js", () => {
  return {
    useServices: () => {
      useState(null);
      return { zcodeAgentService: globalAgent };
    },
  };
});
vi.mock("@/hooks/useWorkspaceServices.js", () => {
  return {
    useWorkspaceServices: () => {
      // 两个真实 router 的 hooks 树不同；mock 也保留差异，防止空→已解析时条件换 hook 被漏测。
      useState(null);
      return useMemo(() => ({ zcodeAgentService: agent }), []);
    },
  };
});

const state: OmpProfileState = {
  activeProfile: "work",
  selectedProfile: "work",
  configRoot: "/native-root",
  storageScope: "actual-native-scope",
  profiles: [{ name: "work", active: true }],
  runtimeIdentity: "runtime-one",
  blockers: [],
  pending: false,
  supported: true,
};
beforeEach(() => {
  vi.clearAllMocks();
  agent.getOmpProfiles.mockResolvedValue(state);
});
afterEach(cleanup);

it("preserves hook order across unresolved Root workspace → actual target without admitting empty-path RPC", async () => {
  const hook = renderHook(({ path }) => useOmpStorageScope(path), { initialProps: { path: "" } });
  expect(hook.result.current).toBeNull();
  expect(agent.getOmpProfiles).not.toHaveBeenCalled();
  expect(agent.onAgentRuntimeRestarted).not.toHaveBeenCalled();
  expect(agent.onAgentRuntimeLifecycle).not.toHaveBeenCalled();
  hook.rerender({ path: "   " });
  expect(hook.result.current).toBeNull();
  expect(agent.getOmpProfiles).not.toHaveBeenCalled();
  hook.rerender({ path: "/actual-workspace" });
  await waitFor(() => expect(hook.result.current).toBe("actual-native-scope"));
  expect(agent.getOmpProfiles).toHaveBeenCalledWith({
    workspacePath: "/actual-workspace",
    workspaceIdentity: undefined,
  });
  hook.rerender({ path: "" });
  expect(hook.result.current).toBeNull();
});

it("does not restore a late previous target scope after the workspace becomes unresolved", async () => {
  const completion = Promise.withResolvers<OmpProfileState>();
  agent.getOmpProfiles.mockReturnValueOnce(completion.promise);
  const hook = renderHook(({ path }) => useOmpStorageScope(path), {
    initialProps: { path: "/previous-workspace" },
  });
  hook.rerender({ path: "" });
  await act(async () => {
    completion.resolve(state);
  });
  expect(hook.result.current).toBeNull();
});

it("keeps global semantics and following state stable across empty → target → empty", () => {
  const hook = renderHook(
    ({ path }) => {
      const service = useZCodeAgentService(path);
      const [local, setLocal] = useState(0);
      return { service, local, setLocal };
    },
    { initialProps: { path: "" } },
  );
  expect(hook.result.current.service).toBe(globalAgent);
  act(() => hook.result.current.setLocal(7));
  hook.rerender({ path: "/actual-workspace" });
  expect(hook.result.current.service).toBe(agent);
  expect(hook.result.current.local).toBe(7);
  hook.rerender({ path: "" });
  expect(hook.result.current.service).toBe(globalAgent);
  expect(hook.result.current.local).toBe(7);
});

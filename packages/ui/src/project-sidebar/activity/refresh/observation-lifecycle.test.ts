// @vitest-environment jsdom
import { act, renderHook, waitFor, cleanup } from "@testing-library/react";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import {
  CONTROLLER_TASKS_INDEX_TOPIC,
  CONTROLLER_WORKSPACES_TOPIC,
  type WindowHostControllerTaskRow,
} from "@zcode/shared/zcode-protocol-v4";
import type { WindowHostControllerFrame, ProjectTree } from "@/project-sidebar/contract.js";
import { useProjectTree } from "@/project-sidebar/useProjectTree.js";
import { getTaskListRowActivity } from "@/v4/taskListRowActivity.js";
const mocks = vi.hoisted(() => ({
  services: {} as Record<string, unknown>,
  tabs: [],
  readTree: vi.fn(),
  removeTaskState: vi.fn(),
}));
vi.mock("@/hooks/useWorkspaceServices.js", () => ({
  useBaseWorkspaceServices: () => mocks.services,
}));
vi.mock("@/store/TabStoreProvider.js", () => ({
  useTabStore: () => mocks.tabs,
  useOptionalTabStore: () => mocks.tabs,
  useTabStoreApi: () => ({ subscribe: () => () => {} }),
}));
vi.mock("@/store/zcodeSessionStore.js", () => ({
  useZCodeSessionStore: Object.assign(
    (selector: (state: unknown) => unknown) =>
      selector({ workspaces: {}, removeTaskState: mocks.removeTaskState }),
    { subscribe: () => () => {} },
  ),
}));
vi.mock("@/v4/useWorkspaceSessionsIndexItems.js", () => ({
  useWorkspaceSessionsIndexItems: () => ({ items: [] }),
}));
vi.mock("@/project-sidebar/project-tree-reader.js", () => ({
  readProjectSidebarTree: (...args: unknown[]) => mocks.readTree(...args),
}));
beforeEach(() => vi.clearAllMocks());
afterEach(cleanup);

function activityFixture() {
  let receive!: (frame: WindowHostControllerFrame) => void;
  let seq = 0;
  const task: ProjectTree["tasks"][number] = {
    taskId: "task",
    hostId: "local",
    projectId: null,
    workspacePath: "/repo",
    title: "original",
    traceId: "task",
    createdAt: 1,
    updatedAt: 2,
    mode: "default",
    pinned: false,
    archived: false,
  };
  let tree: ProjectTree = { projects: [], tasks: [task] };
  const list = vi.fn(async () => ({ items: [], total: 1, hasMore: false }));
  const admit = vi.fn(async () => undefined);
  mocks.readTree.mockImplementation(async () => ({
    tree,
    availability: new Map(),
    directory: { hosts: [], entries: [] },
  }));
  mocks.services = {
    projectService: {},
    windowControllerService: {
      listTaskList: list,
      onDynamicTaskUnreadSignal: () => () => ({ dispose() {} }),
      onDynamicControllerFrame: () => (listener: typeof receive) => {
        receive = listener;
        return { dispose() {} };
      },
      subscribeControllerV4: async ({ topic }: { topic: string }) => ({
        ack: { subscriptionId: topic, mode: "snapshot", logEpoch: "e" },
      }),
      unsubscribeControllerV4: async () => undefined,
    },
    zcodeAgentService: {
      getOmpProfiles: async () => ({ storageScope: "actual-root/default" }),
      onAgentRuntimeRestarted: () => ({ dispose() {} }),
      onAgentRuntimeLifecycle: () => ({ dispose() {} }),
    },
    taskGroupService: {
      read: async (targets: Array<{ workspacePath: string }>) =>
        targets.length
          ? [
              {
                storageScope: "actual-root/default",
                target: targets[0],
                targets,
                groups: [],
                members: [],
                order: [],
              },
            ]
          : [],
      admit,
    },
    broadcastService: { onMessage: () => ({ dispose() {} }) },
  };
  const row = (time = 10): WindowHostControllerTaskRow => ({
    address: { taskId: task.taskId, workspacePath: task.workspacePath },
    meta: { ...task, updatedAt: time, status: "running" as const },
    membership: { pinned: false, archived: false, active: true },
    sourceAvailability: "online" as const,
    liveStatus: "running" as const,
    activity: { phase: "running" as const, lastActivityAt: time, hasBackgroundWork: false },
  });
  const send = async (next: WindowHostControllerTaskRow, snapshot = false, removed = false) =>
    act(async () => {
      const fromSeq = seq;
      if (!snapshot) seq++;
      receive({
        topic: CONTROLLER_TASKS_INDEX_TOPIC,
        subscriptionId: CONTROLLER_TASKS_INDEX_TOPIC,
        logEpoch: "e",
        fromSeq,
        toSeq: seq,
        sentAt: seq,
        payload: removed
          ? { kind: "deltas", deltas: [{ op: "task.removed", address: next.address }] }
          : snapshot
            ? { kind: "snapshot", snapshot: { protocolVersion: 1, logEpoch: "e", tasks: [next] } }
            : { kind: "deltas", deltas: [{ op: "task.upserted", task: next }] },
      });
    });
  const reconnect = async () =>
    act(async () => {
      receive({
        topic: CONTROLLER_WORKSPACES_TOPIC,
        subscriptionId: CONTROLLER_WORKSPACES_TOPIC,
        logEpoch: "new-source",
        fromSeq: 0,
        toSeq: 0,
        sentAt: seq,
        payload: {
          kind: "snapshot",
          snapshot: {
            protocolVersion: 1,
            logEpoch: "new-source",
            workspaces: [
              { workspacePath: "/repo", sourceAvailability: "online", connectionState: "online" },
            ],
          },
        },
      });
    });
  return {
    task,
    row,
    send,
    reconnect,
    list,
    admit,
    setTree(next: ProjectTree) {
      tree = next;
    },
  };
}

it("观察注册失败后，显式刷新会重试，owner 重挂载仍建立观察", async () => {
  const f = activityFixture();
  f.list.mockRejectedValueOnce(new Error("source unavailable"));
  const first = renderHook(() => useProjectTree());
  await waitFor(() => expect(f.list).toHaveBeenCalledTimes(1));
  await act(async () => first.result.current.refresh());
  expect(f.list).toHaveBeenCalledTimes(2);
  first.unmount();
  renderHook(() => useProjectTree());
  await waitFor(() => expect(f.list).toHaveBeenCalledTimes(3));
});

it("同 scope 来源重连恢复观察，离线撤销活动；恢复快照仍刷新事实", async () => {
  const f = activityFixture();
  const { result } = renderHook(() => useProjectTree());
  await waitFor(() => expect(f.list).toHaveBeenCalled());
  await f.send(f.row(), true);
  f.list.mockClear();
  mocks.readTree.mockClear();
  await f.reconnect();
  expect(f.list).toHaveBeenCalledOnce();
  expect(mocks.readTree).toHaveBeenCalled();
  f.list.mockClear();
  await f.send({ ...f.row(), sourceAvailability: "offline" });
  expect(getTaskListRowActivity(result.current.tree.tasks[0]!)).toBeNull();
  expect(f.list).toHaveBeenCalledOnce();
  f.setTree({ projects: [], tasks: [{ ...f.task, title: "recovered" }] });
  await f.send({ ...f.row(), meta: { ...f.row().meta, title: "recovered" } }, true);
  await waitFor(() => expect(result.current.tree.tasks[0]?.title).toBe("recovered"));
});

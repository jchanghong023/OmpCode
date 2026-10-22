// @vitest-environment jsdom
import { afterEach, describe, expect, it, vi } from "vitest";
import { act, cleanup, renderHook, waitFor } from "@testing-library/react";
import { useTaskGroups } from "@/project-sidebar/useTaskGroups.js";
import type { ProjectTask, TaskGroupStructure } from "@/project-sidebar/contract.js";
import { buildGroupedTaskView, groupedMoveCommand } from "@/project-sidebar/grouped/model.js";
import {
  moveTaskToGroupStart,
  moveTaskToRootAroundGroup,
  moveGroupAroundTopLevelNode,
  moveTaskToTopByMenu,
} from "@/project-sidebar/grouped/view.js";
import { taskKey } from "@/project-sidebar/grouped/ids.js";
import { groupTaskRef, taskGroupKey } from "@/project-sidebar/grouped-view.js";

const scopeMocks = vi.hoisted(() => ({ services: {} as Record<string, unknown>, tabs: [] }));
vi.mock("@/hooks/useWorkspaceServices.js", () => ({
  useBaseWorkspaceServices: () => scopeMocks.services,
}));
vi.mock("@/store/TabStoreProvider.js", () => ({
  useTabStore: () => scopeMocks.tabs,
  useOptionalTabStore: () => scopeMocks.tabs,
}));
const broadcastService = { onMessage: () => ({ dispose() {} }) };
afterEach(cleanup);

const task = (id: string, extra = {}): ProjectTask => ({
  taskId: id,
  workspacePath: "/workspace",
  hostId: "local",
  projectId: null,
  title: id,
  mode: "build",
  traceId: id,
  pinned: false,
  archived: false,
  createdAt: 1,
  updatedAt: 2,
  ...extra,
});
const a = task("a"),
  b = task("b"),
  hidden = task("hidden", { archived: true });
const structure: TaskGroupStructure = {
  groups: [
    { id: "g", title: "Group", color: "blue", createdAt: 1, updatedAt: 1 },
    { id: "empty", title: "Empty", color: "gray", createdAt: 1, updatedAt: 1 },
  ],
  members: [
    { groupId: "g", workspaceKey: a.workspacePath, taskId: a.taskId, sortOrder: 0 },
    { groupId: "g", workspaceKey: hidden.workspacePath, taskId: hidden.taskId, sortOrder: 1 },
  ],
  order: [
    { type: "group", key: "g", sortOrder: 0 },
    { type: "task", key: taskGroupKey(b), sortOrder: 1 },
    { type: "group", key: "empty", sortOrder: 2 },
  ],
};
const origin = () => buildGroupedTaskView([a, b, hidden], structure);

describe("GRP11：旧拖动语义只提交单节点，不回写可见列表", () => {
  it("拖进空组保持旧 preview，提交保留来源且不包含隐藏成员", () => {
    const view = origin();
    const preview = moveTaskToGroupStart(view, { activeTaskKey: taskKey(a), groupId: "empty" });
    expect(groupedMoveCommand(view, preview, { type: "task", task: groupTaskRef(a) })).toEqual({
      node: { type: "task", task: groupTaskRef(a) },
      sourceGroupId: "g",
      groupId: "empty",
    });
    expect(structure.members).toHaveLength(2);
    expect(view.nodes[0]).toMatchObject({ type: "group", tasks: [a] });
  });
  it("拖过折叠组保留旧顶层前后位置，不能误当成入组", () => {
    const view = origin();
    const preview = moveTaskToRootAroundGroup(view, {
      activeTaskKey: taskKey(a),
      groupId: "empty",
      position: "after",
    });
    expect(groupedMoveCommand(view, preview, { type: "task", task: groupTaskRef(a) })).toEqual({
      node: { type: "task", task: groupTaskRef(a) },
      sourceGroupId: "g",
      groupId: null,
      anchor: { node: { type: "group", groupId: "empty" }, side: "after" },
    });
  });
  it("组和顶层任务混排只移动当前组", () => {
    const view = origin();
    const preview = moveGroupAroundTopLevelNode(view, {
      activeGroupId: "empty",
      over: { type: "task", taskKey: taskKey(b) },
      position: "before",
    });
    expect(groupedMoveCommand(view, preview, { type: "group", groupId: "empty" })).toEqual({
      node: { type: "group", groupId: "empty" },
      sourceGroupId: null,
      groupId: null,
      anchor: { node: { type: "task", task: groupTaskRef(b) }, side: "before" },
    });
  });
  it("旧移到顶部只调整所在层级，不置顶、不改项目", () => {
    const view = origin();
    const preview = moveTaskToTopByMenu(view, b);
    expect(groupedMoveCommand(view, preview, { type: "task", task: groupTaskRef(b) })).toEqual({
      node: { type: "task", task: groupTaskRef(b) },
      sourceGroupId: null,
      groupId: null,
      anchor: { node: { type: "group", groupId: "g" }, side: "before" },
    });
    expect(b.pinned).toBe(false);
    expect(b.projectId).toBeNull();
  });
  it("取消、无移动和分屏接管不产生组织命令", () => {
    const view = origin();
    expect(groupedMoveCommand(view, view, { type: "task", task: groupTaskRef(a) })).toBeNull();
  });
  it("同路径同 taskId 的两个 Host 不串行", () => {
    const remote = task("a", {
      workspaceIdentity: "remote:server:other:/workspace",
      hostId: "remote:server:other",
    });
    const view = buildGroupedTaskView([a, remote], structure);
    const preview = moveTaskToGroupStart(view, { activeTaskKey: taskKey(remote), groupId: "g" });
    expect(
      groupedMoveCommand(view, preview, { type: "task", task: groupTaskRef(remote) }),
    ).toMatchObject({
      node: { task: { workspaceIdentity: remote.workspaceIdentity, hostId: remote.hostId } },
      sourceGroupId: null,
      groupId: "g",
    });
  });
});

it("分组读写携带真实 workspace target，同域 workspace 可移动、跨 profile 明确拒绝", async () => {
  const targets = [
    { workspacePath: "/repo" },
    { workspacePath: "/other" },
    { workspacePath: "/profile-b" },
  ];
  const tasks = targets.map((target, index) => task(`task-${index}`, target));
  const group = { id: "group-a", title: "A", color: "blue" as const, createdAt: 1, updatedAt: 1 };
  const groupB = { ...group, id: "group-b", title: "B" };
  const read = vi.fn(async () => [
    {
      target: targets[0],
      targets: targets.slice(0, 2),
      storageScope: "root/profile-a",
      groups: [group],
      members: [],
      order: [],
    },
    {
      target: targets[2],
      targets: targets.slice(2),
      storageScope: "root/profile-b",
      groups: [groupB],
      members: [],
      order: [],
    },
  ]);
  const save = vi.fn(async () => group);
  const move = vi.fn(async () => undefined);
  const ungroup = vi.fn(async () => undefined);
  scopeMocks.services = {
    broadcastService,
    zcodeAgentService: {
      getOmpProfiles: async (target: { workspacePath: string }) => ({
        storageScope: target.workspacePath === "/profile-b" ? "root/profile-b" : "root/profile-a",
      }),
      onAgentRuntimeRestarted: () => ({ dispose() {} }),
      onAgentRuntimeLifecycle: () => ({ dispose() {} }),
    },
    taskGroupService: { read, save, move, ungroup, admit: async () => undefined },
  };
  const { result } = renderHook(() => useTaskGroups({ projects: [], tasks }));
  await waitFor(() => expect(result.current.available).toBe(true));
  expect(read).toHaveBeenCalledWith(expect.arrayContaining(targets));
  expect(result.current.moveUnavailableReason(targets[1]!, group.id)).toBeNull();
  expect(result.current.moveUnavailableReason(targets[2]!, group.id)).toContain("不能跨");
  await act(async () => {
    await result.current.save({ target: targets[1], title: "new" });
    await result.current.save({ id: group.id, title: "renamed" });
    await result.current.move({
      node: { type: "task", task: { ...targets[1]!, hostId: "local", taskId: "task-1" } },
      sourceGroupId: null,
      groupId: group.id,
    });
    await result.current.ungroup(group.id);
  });
  expect(save).toHaveBeenCalledWith(expect.objectContaining({ target: targets[1], title: "new" }));
  expect(save).toHaveBeenCalledWith(expect.objectContaining({ target: targets[0], id: group.id }));
  expect(move).toHaveBeenCalledWith(
    expect.objectContaining({ target: targets[1], groupId: group.id }),
  );
  expect(ungroup).toHaveBeenCalledWith({ target: targets[0], id: group.id });
  await expect(
    result.current.move({
      node: { type: "task", task: { ...targets[2]!, hostId: "local", taskId: "task-2" } },
      sourceGroupId: null,
      groupId: group.id,
    }),
  ).rejects.toThrow("不能跨");
  expect(move).toHaveBeenCalledTimes(1);
});

it("分组仅随实际 runtime 域切换；未知域立即隐藏，切回恢复原组织", async () => {
  let actualScope: string | null = "root/profile-a";
  let lifecycle!: (event: { state: string }) => void;
  const group = {
    id: "saved-a",
    title: "A saved",
    color: "blue" as const,
    createdAt: 1,
    updatedAt: 1,
  };
  const read = vi.fn(async () => [
    {
      target: { workspacePath: "/repo" },
      targets: [{ workspacePath: "/repo" }],
      storageScope: actualScope,
      groups: actualScope === "root/profile-a" ? [group] : [],
      members: [],
      order: [],
    },
  ]);
  scopeMocks.services = {
    broadcastService,
    zcodeAgentService: {
      getOmpProfiles: async () => ({ storageScope: actualScope, selectedProfile: "pending-only" }),
      onAgentRuntimeRestarted: () => ({ dispose() {} }),
      onAgentRuntimeLifecycle: (listener: typeof lifecycle) => {
        lifecycle = listener;
        return { dispose() {} };
      },
    },
    taskGroupService: { read, admit: async () => undefined },
  };
  const tree = { projects: [], tasks: [task("task", { workspacePath: "/repo" })] };
  const { result, rerender } = renderHook(() => useTaskGroups(tree));
  await waitFor(() => expect(result.current.structure.groups).toEqual([group]));
  rerender();
  expect(result.current.structure.groups).toEqual([group]);
  act(() => {
    actualScope = null;
    lifecycle({ state: "starting" });
  });
  expect(result.current.available).toBe(false);
  expect(result.current.structure.groups).toEqual([]);
  expect(result.current.unavailableReason).toContain("尚未就绪");
  await act(async () => {
    actualScope = "root/profile-b";
    lifecycle({ state: "available" });
  });
  await waitFor(() => expect(result.current.available).toBe(true));
  expect(result.current.structure.groups).toEqual([]);
  await act(async () => {
    actualScope = "root/profile-a";
    lifecycle({ state: "available" });
  });
  await waitFor(() => expect(result.current.structure.groups).toEqual([group]));
});

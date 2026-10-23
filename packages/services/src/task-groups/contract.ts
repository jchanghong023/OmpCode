import { ServiceChannels, type ZCodeTaskMeta } from "@zcode/shared";
import { createServiceDescriptor } from "#src/descriptors.js";

export type TaskGroupColor = "gray" | "red" | "orange" | "yellow" | "green" | "blue" | "purple";
export interface TaskGroupWorkspaceTarget {
  workspacePath: string;
  workspaceIdentity?: string;
  remoteSessionId?: string;
}
export interface TaskGroup {
  id: string;
  title: string;
  color: TaskGroupColor;
  createdAt: number;
  updatedAt: number;
}
export interface GroupTaskRef {
  hostId: string;
  workspacePath: string;
  workspaceIdentity?: string;
  remoteSessionId?: string;
  taskId: string;
}
export type GroupNode = { type: "group"; groupId: string } | { type: "task"; task: GroupTaskRef };
export interface TaskGroupStructure {
  groups: TaskGroup[];
  members: Array<{ groupId: string; workspaceKey: string; taskId: string; sortOrder: number }>;
  order: Array<{ type: "group" | "task"; key: string; sortOrder: number }>;
}
export interface TaskGroupDomainStructure extends TaskGroupStructure {
  storageScope: string;
  target: TaskGroupWorkspaceTarget;
  /** 本次读取中，经真实 owner 解析确认属于该域的全部 workspace。 */
  targets: TaskGroupWorkspaceTarget[];
}
export interface MoveGroupNode {
  node: GroupNode;
  /** 来源不匹配表示另一客户端已整理，不能用旧 UI 覆盖。 */
  sourceGroupId: string | null;
  groupId: string | null;
  anchor?: { node: GroupNode; side: "before" | "after" };
}
export type GroupTaskFact = GroupTaskRef &
  Pick<ZCodeTaskMeta, "cronAutomationId" | "offPeakTaskId"> & {
    createdAt?: number;
    archived?: boolean;
    deleted?: boolean;
  };
export interface ITaskGroupService {
  read(targets: TaskGroupWorkspaceTarget[]): Promise<TaskGroupDomainStructure[]>;
  save(input: {
    target: TaskGroupWorkspaceTarget;
    id?: string;
    title?: string;
    color?: TaskGroupColor;
  }): Promise<TaskGroup>;
  ungroup(input: { target: TaskGroupWorkspaceTarget; id: string }): Promise<void>;
  move(input: MoveGroupNode & { target: TaskGroupWorkspaceTarget }): Promise<void>;
  /** Host 验证存在性和类型后首次登记；读取结构本身不写数据。 */
  admit(input: {
    tasks: GroupTaskRef[];
    placement?: { task: GroupTaskRef; groupId: string | null; creationId: string };
  }): Promise<void>;
}
export const ITaskGroupService = createServiceDescriptor<ITaskGroupService>(
  ServiceChannels.TaskGroups,
);

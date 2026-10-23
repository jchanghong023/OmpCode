import type { ITaskGroupService, TaskGroupWorkspaceTarget } from "#src/task-groups/contract.js";
export async function createGroupExample(
  service: ITaskGroupService,
  target: TaskGroupWorkspaceTarget,
) {
  return service.save({ target, title: "Research", color: "blue" });
}

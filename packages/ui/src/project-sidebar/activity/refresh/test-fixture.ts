import type { ProjectTree } from "../../contract.js";

export function activityTask(): ProjectTree["tasks"][number] {
  return {
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
}

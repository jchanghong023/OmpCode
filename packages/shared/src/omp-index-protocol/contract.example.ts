import type { IndexProgress, RepoRequest, WikiRequest } from "./contract.js";

// 同一路径可属于不同远端 workspace，identity 必须贯穿请求和进度关联。
export const exampleWikiSearch: WikiRequest = {
  action: "search",
  workspacePath: "/workspace/project",
  workspaceIdentity: "remote-example-workspace",
  remoteSessionId: "remote-session-example",
  operationId: "wiki-search-1",
  query: "clock gating",
  limit: 20,
  characterBudget: 12000,
};

export const exampleRepoRebuild: RepoRequest = {
  action: "rebuild",
  workspacePath: "/workspace/project",
  workspaceIdentity: "remote-example-workspace",
  operationId: "repo-rebuild-1",
  remoteSessionId: "remote-session-example",
  confirmedRoot: "/workspace/project",
};

export const exampleRepoProgress: IndexProgress = {
  workspacePath: exampleRepoRebuild.workspacePath,
  workspaceIdentity: exampleRepoRebuild.workspaceIdentity,
  operationId: exampleRepoRebuild.operationId,
  kind: "repo",
  remoteSessionId: exampleRepoRebuild.remoteSessionId,
  progress: { phase: "parsing", processed: 4, total: 10, path: "src/clock.ts" },
};

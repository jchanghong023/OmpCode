import type { WorkspacePurpose, ZCodeTaskMeta } from "@zcode/shared";

export type ZCodeTaskListKind = "pinned" | "archived" | "timeline" | "active";
export type ZCodeTaskListSortBy = "created" | "updated";

export interface ZCodeTaskListWorkspaceScope {
  workspacePath: string;
  workspaceIdentity?: string;
  workspacePurpose?: WorkspacePurpose;
}

export interface ZCodeTaskListQuery {
  kind: ZCodeTaskListKind;
  workspaceScopes: ZCodeTaskListWorkspaceScope[];
  sortBy: ZCodeTaskListSortBy;
  search?: string;
  limit?: number;
  /** Host 内部列表策略；缺席保持全历史，搜索不裁剪。 */
  updatedSince?: number;
  includeTaskIds?: Array<{ workspacePath: string; workspaceIdentity?: string; taskId: string }>;
  cursor?: { updatedAt: number; createdAt: number; taskId: string; workspaceKey: string };
}

export type ZCodeTaskListItem = ZCodeTaskMeta & {
  searchSnippet?: string;
  searchSnippets?: string[];
};

export interface ZCodeTaskListResult {
  items: ZCodeTaskListItem[];
  total: number;
  hasMore: boolean;
  nextCursor?: ZCodeTaskListQuery["cursor"];
}

export interface ZCodeWorkspaceEventSubscriptionParams {
  workspacePath: string;
  workspaceIdentity?: string;
}

import { z } from "zod";

/** Optional OMP extensions: execution-side workspace routes every request. */
const target = z.object({
  workspacePath: z.string().min(1),
  workspaceIdentity: z.string().optional(),
  remoteSessionId: z.string().optional(),
  operationId: z.string().min(1),
});
const page = {
  query: z.string().min(1),
  cursor: z.string().optional(),
  limit: z.number().int().min(1).max(200).optional(),
};
export const wikiRequestSchema = z.discriminatedUnion("action", [
  target.extend({ action: z.literal("list") }).strict(),
  target
    .extend({
      action: z.literal("init"),
      directory: z.string().min(1),
      name: z.string().min(1),
      confirmedDirectory: z.string().min(1),
    })
    .strict(),
  target.extend({ action: z.literal("remove"), name: z.string().min(1) }).strict(),
  target
    .extend({
      action: z.literal("search"),
      ...page,
      index: z.string().optional(),
      characterBudget: z.number().int().min(1).max(1000000).optional(),
    })
    .strict(),
  target
    .extend({
      action: z.literal("grep"),
      ...page,
      index: z.string().optional(),
      characterBudget: z.number().int().min(1).max(1000000).optional(),
      case: z.boolean().optional(),
    })
    .strict(),
  target.extend({ action: z.literal("cancel") }).strict(),
]);
export const repoRequestSchema = z.discriminatedUnion("action", [
  target.extend({ action: z.literal("status") }).strict(),
  ...(["init", "update", "rebuild", "remove"] as const).map((action) =>
    target.extend({ action: z.literal(action), confirmedRoot: z.string().min(1) }).strict(),
  ),
  ...(["text", "symbol"] as const).map((action) =>
    target
      .extend({
        action: z.literal(action),
        ...page,
        limit: z.number().int().min(1).max(50).optional(),
        path: z.string().optional(),
        category: z.enum(["source", "test", "config", "other"]).optional(),
      })
      .strict(),
  ),
  target.extend({ action: z.literal("cancel") }).strict(),
]);
export type WikiRequest = z.infer<typeof wikiRequestSchema>;
export type RepoRequest = z.infer<typeof repoRequestSchema>;
export type IndexTarget = Pick<
  WikiRequest,
  "workspacePath" | "workspaceIdentity" | "remoteSessionId" | "operationId"
>;
export type WikiAction = WikiRequest["action"];
export type RepoAction = RepoRequest["action"];
export type OmpIndexMethod = `omp/wiki/${WikiAction}` | `omp/repo/${RepoAction}`;
const summary = z
  .object({
    id: z.number(),
    name: z.string(),
    rootPath: z.string(),
    documentCount: z.number(),
    sectionCount: z.number(),
  })
  .strict();
const section = z
  .object({
    sectionId: z.number(),
    index: z.string(),
    documentHash: z.string(),
    path: z.string(),
    headingPath: z.string(),
    lineStart: z.number(),
    lineEnd: z.number(),
    text: z.string(),
    shape: z.enum(["stub", "heading-only", "content"]),
    matchKind: z.enum(["exact-name", "related", "regex"]),
    rank: z.number(),
  })
  .strict();
export const wikiListSchema = z.object({ indexes: z.array(summary) }).strict();
export const wikiBuildSchema = z
  .object({ index: summary, processed: z.number(), failed: z.number() })
  .strict();
export const wikiQuerySchema = z
  .object({
    sections: z.array(section),
    total: z.number(),
    hasMore: z.boolean(),
    cursor: z.string().optional(),
    technicalName: z.string().optional(),
    exactNameMatches: z.number(),
  })
  .strict();
const category = z.enum(["source", "test", "config", "other"]);
export const repoStatusSchema = z
  .object({
    root: z.string(),
    exists: z.boolean(),
    generation: z.string().nullable(),
    fileCount: z.number(),
    symbolCount: z.number(),
    failures: z.array(
      z.object({ path: z.string(), kind: z.string(), message: z.string() }).strict(),
    ),
    failureCount: z.number(),
    failuresTruncated: z.boolean(),
    pendingPaths: z.array(z.string()),
    pendingCount: z.number(),
    pendingTruncated: z.boolean(),
    needsReconcile: z.boolean(),
    uncertainReasons: z.array(z.string()),
    uncertainCount: z.number(),
    uncertaintyTruncated: z.boolean(),
    unchecked: z.boolean(),
    lastFullCheck: z.number().nullable(),
    incomplete: z.boolean(),
    exclusions: z.array(z.string()),
  })
  .strict();
const textHit = z
  .object({
    path: z.string(),
    category,
    startLine: z.number(),
    endLine: z.number(),
    snippet: z.string(),
  })
  .strict();
const symbolHit = z
  .object({
    path: z.string(),
    category,
    name: z.string(),
    qualname: z.string(),
    kind: z.string(),
    startLine: z.number(),
    endLine: z.number(),
    signature: z.string().optional(),
  })
  .strict();
export const repoQuerySchema = z
  .object({
    root: z.string(),
    generation: z.string().nullable(),
    status: z.enum(["ok", "missing"]),
    hits: z.array(z.union([textHit, symbolHit])),
    cursor: z.string().optional(),
    truncated: z.boolean(),
    warnings: z.array(z.string()),
    coverage: repoStatusSchema,
  })
  .strict();
export const removedIndexSchema = z
  .object({ removed: z.literal(true), root: z.string().optional() })
  .strict();
export const cancelledIndexSchema = z.object({ cancelled: z.boolean() }).strict();
export type WikiList = z.infer<typeof wikiListSchema>;
export type WikiQuery = z.infer<typeof wikiQuerySchema>;
export type WikiResult =
  | WikiList
  | WikiQuery
  | z.infer<typeof wikiBuildSchema>
  | z.infer<typeof removedIndexSchema>
  | z.infer<typeof cancelledIndexSchema>;
export type RepoStatus = z.infer<typeof repoStatusSchema>;
export type RepoQuery = z.infer<typeof repoQuerySchema>;
export type RepoResult =
  | RepoStatus
  | RepoQuery
  | z.infer<typeof removedIndexSchema>
  | z.infer<typeof cancelledIndexSchema>;
const wikiProgress = z
  .object({
    phase: z.enum(["scan", "fts"]),
    total: z.number(),
    completed: z.number(),
    failed: z.number(),
    currentPath: z.string().optional(),
    message: z.string().optional(),
  })
  .strict();
const repoProgress = z
  .object({
    phase: z.enum(["enumerating", "reading", "parsing", "publishing"]),
    processed: z.number(),
    total: z.number(),
    path: z.string().optional(),
  })
  .strict();
export const indexProgressSchema = target
  .extend({ kind: z.enum(["wiki", "repo"]), progress: z.union([wikiProgress, repoProgress]) })
  .strict();
export type IndexProgress = z.infer<typeof indexProgressSchema>;

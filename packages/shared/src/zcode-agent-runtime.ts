import { z } from "zod";

export const ompProfileIdSchema = z.string().min(1).nullable();
export type OmpProfileId = z.infer<typeof ompProfileIdSchema>;

/** Optional native startup fact; deliberately independent of vendor storage frames. */
export const ompStartupProfileParamsSchema = z
  .object({
    configRoot: z.string().min(1),
    activeProfile: ompProfileIdSchema,
    storageScope: z.string().min(1),
  })
  .strict();
export type OmpStartupProfileParams = z.infer<typeof ompStartupProfileParamsSchema>;
export const ompStartupProfileNotificationSchema = z
  .object({
    method: z.literal("omp/startup/profile"),
    params: ompStartupProfileParamsSchema,
  })
  .strict();
export type OmpStartupProfileNotification = z.infer<typeof ompStartupProfileNotificationSchema>;
const ompProfileWorkspaceSchema = z
  .object({
    workspacePath: z.string().min(1),
    workspaceIdentity: z.string().optional(),
    remoteSessionId: z.string().optional(),
    workspaceKey: z.string().min(1),
  })
  .strict();
export const ompProfilesListParamsSchema = z
  .object({
    workspace: ompProfileWorkspaceSchema,
    candidate: ompProfileIdSchema.optional(),
  })
  .strict();
export const ompProfilesPrepareSwitchParamsSchema = z
  .object({
    workspace: ompProfileWorkspaceSchema,
    expectedProfile: ompProfileIdSchema,
  })
  .strict();
export const ompProfilesCancelSwitchParamsSchema = z
  .object({
    workspace: ompProfileWorkspaceSchema,
    token: z.string().min(1),
  })
  .strict();
export const ompProfileBlockerSchema = z
  .object({
    code: z.string(),
    sessionId: z.string().optional(),
    message: z.string(),
  })
  .strict();
export const ompProfilesListResultSchema = z
  .object({
    activeProfile: ompProfileIdSchema,
    configRoot: z.string().min(1),
    storageScope: z.string().min(1),
    profiles: z.array(z.object({ name: ompProfileIdSchema, active: z.boolean() }).strict()),
    candidate: ompProfileIdSchema.optional(),
  })
  .strict();
export const ompProfilesPrepareSwitchResultSchema = z
  .object({
    ready: z.boolean(),
    token: z.string().optional(),
    blockers: z.array(ompProfileBlockerSchema),
  })
  .strict();
export const ompProfilesCancelSwitchResultSchema = z.object({ cancelled: z.boolean() }).strict();
export const ompProfileStateSchema = z
  .object({
    selectedProfile: ompProfileIdSchema,
    activeProfile: ompProfileIdSchema,
    configRoot: z.string().min(1).nullable(),
    storageScope: z.string().min(1).nullable(),
    profiles: ompProfilesListResultSchema.shape.profiles,
    runtimeIdentity: z.string().nullable(),
    blockers: z.array(ompProfileBlockerSchema),
    pending: z.boolean(),
    supported: z.boolean(),
    reason: z.string().optional(),
  })
  .strict();
export type OmpProfileState = z.infer<typeof ompProfileStateSchema>;

/** Optional native background delegation; native jobs remain the execution owner. */
export const ompTanJobSchema = z
  .object({
    jobId: z.string(),
    agentId: z.string().optional(),
    childSessionId: z.string().optional(),
    sessionId: z.string(),
    work: z.string(),
    label: z.string(),
    status: z.enum(["pending", "running", "completed", "failed", "cancelled", "unavailable"]),
    output: z.string().optional(),
    error: z.string().optional(),
    unavailable: z.array(z.string()),
  })
  .strict();
export const ompTanListParamsSchema = z
  .object({
    workspace: ompProfileWorkspaceSchema,
    sessionId: z.string().min(1),
  })
  .strict();
export const ompTanStartParamsSchema = ompTanListParamsSchema
  .extend({ work: z.string().trim().min(1) })
  .strict();
export const ompTanStopParamsSchema = ompTanListParamsSchema
  .extend({ jobId: z.string().min(1) })
  .strict();
export const ompTanStartResultSchema = z.object({ job: ompTanJobSchema }).strict();
export const ompTanListResultSchema = z.object({ jobs: z.array(ompTanJobSchema) }).strict();
export const ompTanStopResultSchema = z
  .object({ accepted: z.boolean(), job: ompTanJobSchema })
  .strict();
export type OmpTanJob = z.infer<typeof ompTanJobSchema>;

/** Optional native Team observation extension, separate from the ZCode protocol. */
export const ompTeamRequestSchema = z.discriminatedUnion("action", [
  z.object({ action: z.literal("list"), sessionId: z.string().min(1) }).strict(),
  z
    .object({ action: z.literal("read"), sessionId: z.string().min(1), jobId: z.string().min(1) })
    .strict(),
  z
    .object({ action: z.literal("stop"), sessionId: z.string().min(1), jobId: z.string().min(1) })
    .strict(),
]);
export const ompTeamNodeSchema = z
  .object({
    id: z.string(),
    label: z.string(),
    role: z.string(),
    stage: z.string().optional(),
    proposalLabel: z.string().optional(),
    round: z.number().optional(),
    model: z.string().optional(),
    status: z.string(),
    sessionFile: z.string().optional(),
    outputPath: z.string().optional(),
    output: z.unknown().optional(),
    error: z.string().optional(),
    tools: z.array(z.unknown()),
    messages: z.array(z.unknown()),
  })
  .strict();
export const ompTeamRunSchema = z
  .object({
    jobId: z.string(),
    sessionId: z.string(),
    dispatchEntityId: z.string().optional(),
    label: z.string(),
    status: z.enum(["running", "completed", "failed", "cancelled", "unavailable"]),
    stage: z.string().optional(),
    participants: z.array(z.unknown()),
    nodes: z.array(ompTeamNodeSchema),
    edges: z.array(
      z
        .object({
          source: z.string(),
          target: z.string(),
          kind: z.enum(["reviews", "revises", "rechecks"]),
          evidence: z.string(),
        })
        .strict(),
    ),
    timeline: z.array(
      z
        .object({
          sequence: z.number(),
          timestamp: z.number(),
          kind: z.string(),
          nodeId: z.string().optional(),
          data: z.unknown(),
        })
        .strict(),
    ),
    result: z.unknown().optional(),
    report: z.unknown().optional(),
    error: z.string().optional(),
    source: z.enum(["native-live", "native-journal"]),
    unavailable: z.array(z.string()),
  })
  .strict();
export const ompTeamListResultSchema = z.object({ runs: z.array(ompTeamRunSchema) }).strict();
export const ompTeamReadResultSchema = z.object({ run: ompTeamRunSchema }).strict();
export const ompTeamStopResultSchema = z
  .object({ accepted: z.boolean(), run: ompTeamRunSchema })
  .strict();
export type OmpTeamRequest = z.infer<typeof ompTeamRequestSchema>;
export type OmpTeamRun = z.infer<typeof ompTeamRunSchema>;
export type OmpTeamNode = z.infer<typeof ompTeamNodeSchema>;

export type ZCodeAgentBinaryKind = "native-binary";

export interface ZCodeAgentRuntimeDescriptor {
  binaryKind: ZCodeAgentBinaryKind;
  binaryEnvVar: string;
  bundledResourceDir: string;
  version: string;
  spawnArgs: string[];
  nativeConfigDir: string;
  nativeConfigFileName: string;
  missingBinaryMessage: string;
  resolveEntrySegments(platform: string): string[];
  /**
   * 桌面端把 agent 的 JS bundle（zcode.cjs）打进 resources/glm，由 app 内置的 Electron Node runtime
   * （ELECTRON_RUN_AS_NODE）直接执行，避免再随包内置一份独立 Node 二进制。
   * 这里只放纯 JS 入口文件名，平台无关（与 resolveEntrySegments 的原生二进制路径平行）。
   */
  nodeBundleEntryFile: string;
  resolveNodeBundleSegments(): string[];
}

export function resolvePlatformBinaryName(binaryName: string, platform: string): string {
  return platform === "win32" ? `${binaryName}.exe` : binaryName;
}

export const ZCODE_AGENT_RUNTIME: ZCodeAgentRuntimeDescriptor = {
  binaryKind: "native-binary",
  binaryEnvVar: "GLM_BINARY_PATH",
  bundledResourceDir: "glm",
  version: "0.13.3",
  spawnArgs: ["app-server", "--stdio"],
  nativeConfigDir: ".zcode/cli",
  nativeConfigFileName: "config.json",
  missingBinaryMessage:
    "[ZCode Agent] glm binary 未找到，请设置 ZCODE_AGENT_WORKDIR、GLM_BINARY_PATH 或先准备 GLM 运行时资源",
  resolveEntrySegments: (platform) => [resolvePlatformBinaryName("zcode-agent", platform)],
  nodeBundleEntryFile: "zcode.cjs",
  resolveNodeBundleSegments() {
    return [this.nodeBundleEntryFile];
  },
};

export function getZCodeAgentRuntime(): ZCodeAgentRuntimeDescriptor {
  return ZCODE_AGENT_RUNTIME;
}

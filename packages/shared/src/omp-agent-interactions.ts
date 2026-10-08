import { z } from "zod";
import { zcodeWorkspaceRefSchema } from "./zcode-protocol-legacy-types.js";

const identity = z.string().min(1);

export const zcodeAgentInteractionAgentSchema = z
  .object({
    id: identity,
    label: identity,
    parentAgentId: identity.optional(),
    status: z.string().optional(),
    detailSessionId: identity.optional(),
    known: z.boolean().optional(),
  })
  .strict();
export type ZCodeAgentInteractionAgent = z.infer<typeof zcodeAgentInteractionAgentSchema>;

export const zcodeAgentInteractionEventSchema = z
  .object({
    eventId: identity,
    kind: z.enum(["task_dispatch", "task_result", "message"]),
    fromAgentId: identity,
    toAgentId: identity,
    body: z.string(),
    timestamp: z.number().int().nonnegative().optional(),
    timeBasis: z.enum(["sent", "recorded", "unknown"]).default("unknown"),
    messageId: identity.optional(),
    replyTo: identity.optional(),
    delivery: z.enum(["injected", "woken", "revived", "failed", "observed", "unknown"]).optional(),
    source: z.enum(["live", "history", "live_and_history"]),
    broadcastGroupId: identity.optional(),
    error: z.string().optional(),
  })
  .strict();
export type ZCodeAgentInteractionEvent = z.infer<typeof zcodeAgentInteractionEventSchema>;

export const zcodeAgentInteractionCoverageSchema = z
  .object({
    status: z.enum(["complete", "partial"]),
    issues: z.array(
      z.enum([
        "legacy_history_gaps",
        "record_unavailable",
        "missing_timestamp",
        "ambiguous_identity",
        "read_budget_exceeded",
      ]),
    ),
  })
  .strict();
export type ZCodeAgentInteractionCoverage = z.infer<typeof zcodeAgentInteractionCoverageSchema>;

export const zcodeSessionAgentInteractionsParamsSchema = z
  .object({
    workspace: zcodeWorkspaceRefSchema,
    sessionId: identity,
    cursor: identity.optional(),
    limit: z.number().int().positive().max(500).default(200),
  })
  .strict();
export type ZCodeSessionAgentInteractionsParams = z.infer<
  typeof zcodeSessionAgentInteractionsParamsSchema
>;

export const zcodeSessionAgentInteractionsResultSchema = z
  .object({
    rootSessionId: identity,
    revision: z.number().int().nonnegative(),
    agents: z.array(zcodeAgentInteractionAgentSchema),
    events: z.array(zcodeAgentInteractionEventSchema),
    coverage: zcodeAgentInteractionCoverageSchema,
    totalEvents: z.number().int().nonnegative(),
    nextCursor: identity.optional(),
  })
  .strict();
export type ZCodeSessionAgentInteractionsResult = z.infer<
  typeof zcodeSessionAgentInteractionsResultSchema
>;

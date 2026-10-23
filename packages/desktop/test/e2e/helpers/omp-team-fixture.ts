import type { ModelRequest } from "./omp-integration-fixture.js";

/** Scripted provider output only: the actual native Team owns stages and child calls. */
export function respondOmpTeamRequest(request: ModelRequest) {
  const input = JSON.stringify(request.messages);
  if (!input.includes("OMP_E2E_TEAM")) return undefined;
  const tool = request.tools?.find((value) => {
    if (!value || typeof value !== "object" || !("function" in value)) return false;
    const fn = value.function;
    return !!fn && typeof fn === "object" && "name" in fn && fn.name === "yield";
  });
  if (!tool) return { text: "OMP_E2E_TEAM_PARENT_READY" };
  if (input.includes("OMP_E2E_TEAM_CANCEL")) return { hold: true };
  const schema = JSON.stringify(tool);
  let data: Record<string, unknown>;
  if (schema.includes('"noViableProposal"'))
    data = {
      proposal: "OMP_E2E_TEAM_PROPOSAL: inspect only; preserve source files.",
      noViableProposal: false,
      investigationBlockedReason: "",
      keyAssumptions: [],
      risks: [],
      unknowns: [],
      acceptanceCriteria: ["No file changes"],
      ambiguityInterpretations: [],
      evidence: [],
    };
  else if (schema.includes('"unifiedUnderstanding"'))
    data = {
      unifiedUnderstanding: "OMP_E2E_TEAM_ALIGNMENT: read-only evidence",
      acceptanceCriteria: ["No file changes"],
      factDifferences: [],
      interpretationDifferences: [],
    };
  else if (schema.includes('"noSubstantiveIssues"'))
    data = {
      noSubstantiveIssues: false,
      reviewSummary: "OMP_E2E_TEAM_REVIEW: add an explicit read-only verification step",
      findings: [
        {
          severity: "important",
          issue: "The proposal does not explain how to confirm that source files remain unchanged.",
          impact: "The read-only acceptance criterion cannot be checked from the proposed steps.",
          evidence: "The proposal says preserve source files but gives no before/after comparison.",
          targetAspect: "Read-only acceptance verification",
        },
      ],
      blockingResolutions: [],
    };
  else if (schema.includes('"revisedProposal"')) {
    // 原生 runner 分配 finding ID；回应必须从真实修订任务提取，不能猜测或另造 ID。
    const task = request.messages
      .filter((message) => message.role === "user")
      .map((message) =>
        typeof message.content === "string" ? message.content : JSON.stringify(message.content),
      )
      .join("\n");
    const findingIds = [...new Set(task.match(/\b[A-Z]+-F\d+\b/gu) ?? [])];
    if (!findingIds.length) throw new Error("Native Team revision task has no tracked finding IDs");
    data = {
      revisedProposal:
        "OMP_E2E_TEAM_REVISION: inspect read-only options; compare source status before and after inspection.",
      revisionSummary:
        "Added a before/after source-status comparison to verify the read-only criterion.",
      responses: findingIds.map((findingId) => ({
        findingId,
        disposition: "accepted-and-revised",
        explanation:
          "Added the requested source-status comparison without changing source files or core design.",
      })),
      reviewFlags: {
        changedCoreDesign: false,
        claimsResolvedBlocking: false,
        newEvidenceChangesAssumptions: false,
        disputesBlockingFinding: false,
      },
    };
  } else if (schema.includes('"reportMarkdown"'))
    data = {
      reportMarkdown: "OMP_E2E_TEAM_REPORT: native orchestration completed read-only.",
      recommendedProposal: "A",
      recommendationReason: "Read-only scope",
      recommendationPreconditions: "No modifications",
      hardConstraintViolations: [],
    };
  else throw new Error("Native Team yield schema is not recognized by the isolated fixture");
  return { tool: { name: "yield", args: { data } } };
}

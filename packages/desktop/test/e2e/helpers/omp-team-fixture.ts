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
      noSubstantiveIssues: true,
      reviewSummary: "OMP_E2E_TEAM_REVIEW: no blocking issues",
      findings: [],
      blockingResolutions: [],
    };
  else if (schema.includes('"revisedProposal"'))
    data = {
      revisedProposal: "OMP_E2E_TEAM_REVISION: read-only evidence",
      revisionSummary: "No changes required",
      responses: [],
      reviewFlags: {
        changedCoreDesign: false,
        claimsResolvedBlocking: false,
        newEvidenceChangesAssumptions: false,
        disputesBlockingFinding: false,
      },
    };
  else if (schema.includes('"reportMarkdown"'))
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

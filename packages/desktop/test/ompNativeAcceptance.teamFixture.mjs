import assert from "node:assert/strict";
import { yieldArgs } from "./ompAgentsAcceptance.protocol.mjs";

const teamStageOf = (prompt) =>
  /^\[team-stage:(proposal|alignment|synthesis)\]/u.exec(prompt)?.[1] ??
  (/^\[team-stage:review target=[A-C] round=1\]/u.test(prompt) ? "review" : undefined);

export function createTeamFixture({ readPath, readEvidence, task, issued, issue, answer }) {
  const teamOutput = (stage, evidence) => {
    const acceptanceCriteria = ["Report the exact file evidence without editing files"];
    const basis = `${readPath}: ${evidence}`;
    if (stage === "proposal")
      return {
        proposal: `Read-only timing investigation: ${basis}`,
        noViableProposal: false,
        investigationBlockedReason: "",
        keyAssumptions: [],
        risks: [],
        unknowns: [],
        acceptanceCriteria,
        ambiguityInterpretations: [],
        evidence: [{ claim: evidence, source: readPath }],
      };
    if (stage === "alignment")
      return {
        unifiedUnderstanding: `Preserve the source and report its exact evidence: ${basis}`,
        acceptanceCriteria,
        factDifferences: [],
        interpretationDifferences: [],
      };
    if (stage === "review")
      return {
        noSubstantiveIssues: true,
        reviewSummary: `The read-only proposal agrees with the actual file: ${basis}`,
        findings: [],
        blockingResolutions: [],
      };
    assert.equal(stage, "synthesis", "Only actual public Team stages are scripted");
    return {
      reportMarkdown: [
        "# NATIVE_TEAM_REPORT_731",
        "## Requirement and acceptance",
        task,
        ...acceptanceCriteria,
        "## Investigated and reviewed directions",
        `The independent read-only proposals preserve the file and report ${basis}.`,
        "They have the same scope and evidence; no distinct trade-off favors one.",
        "## Risks, assumptions and pre-execution checks",
        "No file modification is authorized. Re-read the source before any later implementation.",
        "No unresolved requirement interpretation or rejected alternative was identified.",
      ].join("\n\n"),
      recommendedProposal: "",
      recommendationReason: "",
      recommendationPreconditions: "",
      hardConstraintViolations: [],
    };
  };

  function title(context, prompt) {
    const title = /^<user>\n([\s\S]*)\n<\/user>$/u.exec(prompt);
    const titleStage = title && teamStageOf(title[1]);
    if (!titleStage) return undefined;
    assert.ok(prompt.includes(task), "Title must label this exact Team assignment");
    assert.ok(!context.tools?.length, "A title request cannot execute participant tools");
    return answer(`<title>Inspect native timing ${titleStage}</title>`);
  }

  function read(context, prompt) {
    const teamStage = teamStageOf(prompt);
    if (!teamStage || !prompt.includes(task)) return undefined;
    assert.ok(context.tools?.some((tool) => tool.name === "yield"));
    assert.equal(
      context.tools.some((tool) => ["write", "edit"].includes(tool.name)),
      false,
      "Native Team must keep its read-only tool boundary",
    );
    const index = issued.filter((item) => item.key.startsWith("team-read-")).length + 1;
    const stageReads = issued.filter(
      (item) => item.key.startsWith("team-read-") && item.teamStage === teamStage,
    );
    const limit = ["proposal", "review"].includes(teamStage) ? 3 : 1;
    assert.ok(stageReads.length < limit, `Unexpected repeated Team ${teamStage} assignment`);
    if (teamStage !== "proposal") {
      const proposals = issued.filter(
        (item) => item.name === "yield" && item.teamStage === "proposal",
      );
      assert.equal(proposals.length, 3, "Later stages require three actual proposals");
      for (const proposal of proposals) assert.ok(prompt.includes(proposal.args.data.proposal));
    }
    if (teamStage === "synthesis") {
      const reviews = issued.filter((item) => item.name === "yield" && item.teamStage === "review");
      assert.equal(reviews.length, 3, "The report requires three actual review submissions");
      for (const review of reviews)
        assert.ok(prompt.includes(JSON.stringify(review.args.data.reviewSummary)));
    }
    return issue(
      context,
      `team-read-${index}`,
      "read",
      { i: "Reading team timing evidence", path: readPath },
      readEvidence.trim(),
      null,
      false,
      { teamStage, teamTask: task },
    );
  }

  function complete(context, invocation, output, readToolId) {
    const data = teamOutput(invocation.teamStage, output);
    return issue(
      context,
      invocation.key.replace("team-read-", "team-yield-"),
      "yield",
      yieldArgs(context, data),
      "Result submitted.",
      null,
      false,
      {
        teamStage: invocation.teamStage,
        teamTask: task,
        readToolId,
      },
    );
  }

  return { title, read, complete };
}

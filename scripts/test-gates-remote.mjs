import { commandOutput, gitText, pause, snapshot, sameSnapshot } from "./test-gates-process.mjs";

async function gh(args) {
  const result = await commandOutput("gh", args, { quiet: true });
  if (result.code) throw new Error(`GitHub CLI request failed (exit ${result.code})`);
  return result.output;
}

export function remoteAllowed({ records, inCi, authorizedRelease }) {
  return (
    !inCi &&
    authorizedRelease &&
    records.every(
      (record) => record.status === "PASS" || record.status === "SKIPPED_NOT_APPLICABLE",
    )
  );
}

export async function releaseStage(stage, context) {
  if (!remoteAllowed(context))
    return {
      status: "UNVERIFIED_PERMISSION",
      reason:
        "Release needs this run's explicit --publish-releases authorization and all preceding local stages PASS; CI cannot trigger slowtest",
    };
  const current = await snapshot();
  if (!current.clean || !sameSnapshot(current, context.snapshot))
    return {
      status: "UNVERIFIED_REMOTE_STATUS",
      reason:
        "Release requires a clean unchanged source snapshot; this gate never commits or pushes",
    };
  if ((await gitText(["branch", "--show-current"])).trim() !== "main")
    return {
      status: "UNVERIFIED_PERMISSION",
      reason: "Existing release workflows permit only main",
    };
  const origin = (await gitText(["remote", "get-url", "origin"])).trim();
  const match = origin.match(/github\.com[:/]([^/]+\/[^/]+?)(?:\.git)?$/u);
  if (!match)
    return {
      status: "UNVERIFIED_REMOTE_STATUS",
      reason: "origin is not an identified GitHub repository",
    };
  const repository = match[1];
  const remote = JSON.parse(await gh(["api", `repos/${repository}/git/ref/heads/main`]));
  if (remote.object.sha !== current.head)
    return {
      status: "UNVERIFIED_REMOTE_STATUS",
      reason: "origin/main SHA differs from the local snapshot",
    };
  const startedAt = new Date().toISOString();
  const prior = JSON.parse(
    await gh([
      "run",
      "list",
      "--repo",
      repository,
      "--workflow",
      stage.workflow,
      "--branch",
      "main",
      "--event",
      "workflow_dispatch",
      "--limit",
      "50",
      "--json",
      "databaseId",
    ]),
  );
  await gh(["workflow", "run", stage.workflow, "--repo", repository, "--ref", "main"]);
  const previousIds = new Set(prior.map((run) => run.databaseId));
  let run;
  for (let attempt = 0; attempt < 12; attempt++) {
    const runs = JSON.parse(
      await gh([
        "run",
        "list",
        "--repo",
        repository,
        "--workflow",
        stage.workflow,
        "--branch",
        "main",
        "--event",
        "workflow_dispatch",
        "--limit",
        "50",
        "--json",
        "databaseId,headSha,createdAt,url",
      ]),
    );
    const matching = runs.filter(
      (candidate) =>
        !previousIds.has(candidate.databaseId) &&
        candidate.headSha === current.head &&
        new Date(candidate.createdAt) >= new Date(startedAt.slice(0, 19) + "Z"),
    );
    if (matching.length > 1)
      return {
        status: "UNVERIFIED_REMOTE_STATUS",
        reason: "Concurrent matching workflow runs are ambiguous; no run is assumed to be ours",
      };
    if (matching.length === 1) {
      run = matching[0];
      break;
    }
    await pause(5000);
  }
  if (!run)
    return {
      status: "UNVERIFIED_REMOTE_STATUS",
      reason: "TRIGGERED; could not identify the exact new run",
      workflow: stage.workflow,
      head: current.head,
    };
  console.log(`TRIGGERED ${stage.workflow} run ${run.databaseId} @ ${run.headSha}`);
  const deadline = Date.now() + 2 * 60 * 60 * 1000;
  while (Date.now() < deadline) {
    const result = JSON.parse(
      await gh([
        "run",
        "view",
        String(run.databaseId),
        "--repo",
        repository,
        "--json",
        "status,conclusion,headSha,url",
      ]),
    );
    if (result.headSha !== current.head)
      return {
        status: "UNVERIFIED_REMOTE_STATUS",
        reason: "Remote source SHA changed",
        runId: run.databaseId,
      };
    if (result.status === "completed")
      return {
        status: result.conclusion === "success" ? "PASS" : "FAIL",
        runId: run.databaseId,
        head: result.headSha,
        conclusion: result.conclusion,
        url: result.url,
      };
    console.log(`RUNNING ${stage.workflow} #${run.databaseId}; final conclusion pending`);
    await pause(30000);
  }
  return {
    status: "UNVERIFIED_REMOTE_STATUS",
    reason: "RUNNING; wait limit expired; poll with gh run view",
    runId: run.databaseId,
    head: current.head,
  };
}

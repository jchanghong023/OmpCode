import assert from "node:assert/strict";

// Repo 查询序列独立持有场景游标；设备执行与真实结果仍由主 fixture 的同一工具 owner 处理。
export function createRepoScenarioReader(values) {
  const cases = [
    {
      query: values.query,
      key: "repo-search",
      symbol: values.query,
      content: values.code.trim(),
      done: "NATIVE_REPO_SEARCH_DONE_731",
    },
    {
      query: "updatedTiming732",
      key: "repo-updated",
      symbol: "updatedTiming732",
      content: values.updatedCode.trim(),
      done: "NATIVE_REPO_UPDATED_DONE_732",
    },
    {
      query: "rebuiltTiming733",
      key: "repo-rebuilt",
      symbol: "rebuiltTiming733",
      content: values.rebuiltCode.trim(),
      done: "NATIVE_REPO_REBUILT_DONE_733",
    },
    {
      query: "nativeTiming731",
      key: "repo-removed-original",
      missing: true,
      done: "NATIVE_REPO_OLD_REMOVED_731",
    },
    {
      query: "updatedTiming732",
      key: "repo-removed-updated",
      missing: true,
      done: "NATIVE_REPO_UPDATED_REMOVED_732",
    },
    {
      query: "nativeMissingSymbol731",
      key: "repo-search-failed",
      unavailable: true,
      done: "NATIVE_REPO_UNAVAILABLE_731",
    },
  ];
  let step = 0;
  return (prompt) => {
    const jsonLines = prompt.split("\n").filter((line) => line.startsWith("{"));
    if (!jsonLines.length) return null;
    assert.equal(jsonLines.length, 1);
    const request = JSON.parse(jsonLines[0]);
    const scenario = cases[step++];
    assert.ok(scenario, "No additional Repo searches are allowed");
    assert.deepEqual(
      request,
      { action: "search", query: scenario.query },
      "Every panel query must preserve the exact ordered acceptance input",
    );
    return scenario;
  };
}

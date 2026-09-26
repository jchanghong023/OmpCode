import assert from "node:assert/strict";
import { test } from "node:test";
import { noteHighlighterFailure } from "../src/lib/shikiHighlighter.js";

// F38：shiki 创建失败后，已 reject 的 promise 不能驻留 highlighterCache，
// 否则该语言+主题组合整会话命中同一失败 promise，永远无高亮。
// 完整失败路径依赖 shiki worker 加载与内部模块状态，且失败条目仅在
// 同 cacheKey 复现 reject、外部行为不可观测，故这里对决策函数做最小单测；
// getHighlighter 内的旁路 .catch(() => noteHighlighterFailure(...)) 连线由代码评审覆盖。
function buildFakeCache(): Map<string, Promise<never>> {
  // 夹具自行消化 unhandledRejection，避免污染 node:test 进程级事件。
  const rejected = Promise.reject(new Error("boom"));
  rejected.catch(() => {});
  return new Map([
    ["github-dark:typescript", rejected],
    ["github-light:python", Promise.resolve({}) as Promise<never>],
  ]);
}

test("高亮器创建失败后删除对应缓存条目", () => {
  const cache = buildFakeCache();
  noteHighlighterFailure(cache as never, "github-dark:typescript");
  assert.equal(cache.has("github-dark:typescript"), false);
  assert.equal(cache.has("github-light:python"), true);
});

test("失败清理对不存在的缓存键安全", () => {
  const cache = buildFakeCache();
  noteHighlighterFailure(cache as never, "github-dark:rust");
  assert.equal(cache.size, 2);
});

import assert from "node:assert/strict";
import { test } from "node:test";
import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { OmpDesktopComposerStatus } from "../src/v4/composer/OmpDesktopComposerStatus.js";

test("桌面输入框状态栏保留 Git，不展示计划或压缩入口", () => {
  const html = renderToStaticMarkup(
    createElement(OmpDesktopComposerStatus, {
      gitSummary: {
        workspacePath: "/workspace",
        repoRoot: "/workspace",
        workspaceInRepoPath: "",
        autoRefreshWatchPaths: [],
        branchName: "main",
        trackingBranchName: "origin/main",
        headRefType: "branch",
        ahead: 0,
        behind: 0,
        isDirty: true,
        isGitAvailable: true,
        isRepository: true,
      },
      gitDirtyFileCount: 3,
      onOpenGitReview: () => {},
    }),
  );

  assert.match(html, /data-testid="omp-desktop-composer-status"/u);
  assert.match(html, /aria-label="main \*3"/u);
  assert.equal((html.match(/<button\b/gu) ?? []).length, 1);
  assert.doesNotMatch(html, /计划模型|计划模式|Plan model|Plan mode|压缩上下文|自动压缩/u);
  assert.equal(renderToStaticMarkup(createElement(OmpDesktopComposerStatus)), "");
});

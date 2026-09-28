import assert from "node:assert/strict";
import { test } from "node:test";
import { readFile } from "node:fs/promises";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";

/**
 * 反馈中心挂载契约（回归：单分支统一重构曾误删 App.tsx 的 <FeedbackHost/> 挂载
 * 与 OpenFeedbackDialog/OpenTicketsPanel 监听，导致 Windows 与 CentOS 7 全功能态下
 * 帮助菜单/会话头部/应用菜单的反馈入口全部静默无响应）。
 * 依据 docs/requirements/centos7-release.md：反馈仅在离线锁定（--offline）下禁用且
 * 入口保留禁用态，全功能态必须可用；feedbackStore 是唯一状态所有者，
 * App.tsx 是弹窗唯一挂载点与 main 侧 IPC 唯一监听注册处。
 */

const UI_SRC_DIR = join(dirname(fileURLToPath(import.meta.url)), "..", "src");

/** 仍保留的反馈入口（调用 openSubmit/openFeatureRequest 打开弹窗）。 */
const FEEDBACK_ENTRY_FILES = [
  "WorkspaceHelpMenuButton.tsx",
  "WorkspaceHeaderSections.tsx",
] as const;

test("App.tsx 必须挂载 FeedbackHost 并注册 main 侧反馈 IPC 监听", async () => {
  const appSource = await readFile(join(UI_SRC_DIR, "App.tsx"), "utf8");
  assert.match(
    appSource,
    /<FeedbackHost\s/u,
    "App.tsx 缺少 <FeedbackHost/> 挂载：反馈弹窗无渲染者，所有入口静默无响应",
  );
  assert.match(
    appSource,
    /platform\.onOpenFeedbackDialog/u,
    "App.tsx 未注册 onOpenFeedbackDialog：应用菜单 Help → Feedback 的 IPC 无人接收",
  );
  assert.match(
    appSource,
    /platform\.onOpenTicketsPanel/u,
    "App.tsx 未注册 onOpenTicketsPanel：老的工单面板 IPC 兼容路径断开",
  );
});

test("反馈入口存在时弹窗实现与 re-export 必须可达", async () => {
  const hostSource = await readFile(join(UI_SRC_DIR, "feedback", "FeedbackHost.tsx"), "utf8");
  assert.match(hostSource, /FeedbackCenter/u, "FeedbackHost.tsx 应 re-export FeedbackCenter 实现");
  const appSource = await readFile(join(UI_SRC_DIR, "App.tsx"), "utf8");
  assert.match(
    appSource,
    /from "@\/feedback\/FeedbackHost\.js"/u,
    "App.tsx 应从 feedback 模块公开入口导入 FeedbackHost",
  );
  for (const entry of FEEDBACK_ENTRY_FILES) {
    const entrySource = await readFile(join(UI_SRC_DIR, entry), "utf8");
    assert.match(
      entrySource,
      /useFeedbackStore|openSubmit|openFeatureRequest/u,
      `${entry} 反馈入口应仍指向 feedbackStore；若反馈中心被有意移除，需同步更新本契约测试与需求文档`,
    );
  }
});

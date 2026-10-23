import { posix } from "node:path";

export const SSH_FORMAL_SPEC_GLOB =
  "./test/e2e/conversation-session/conversation-session-ssh-remote*.test.ts";
// Bug 根因：逐领域枚举漏掉新增候选目录，导致单进程全量与分片正式集合不一致。
export const MANUAL_REVIEW_SPEC_GLOB = "./test/e2e/**/manual-review/**/*.test.ts";

// 同一 OMP 默认集合同时供 WDIO 和分片入口消费，避免 .e2e.ts 漏过 .test.ts 扫描。
export const OMP_DEFAULT_E2E_SPECS = [
  "./test/e2e/omp-app-server.e2e.ts",
  "./test/e2e/omp-subagents.e2e.ts",
  "./test/e2e/omp-workflows.e2e.ts",
  "./test/e2e/omp-permissions.e2e.ts",
  "./test/e2e/omp-management.e2e.ts",
  "./test/e2e/omp-team.e2e.ts",
  "./test/e2e/omp-indexes.e2e.ts",
  "./test/e2e/omp-profiles.e2e.ts",
  "./test/e2e/omp-tan.e2e.ts",
  "./test/e2e/omp-commands.e2e.ts",
  "./test/e2e/omp-spec-driven.e2e.ts",
];

// 临时缩小 fork E2E 执行范围；保留用例实现，不将排除项记为通过。
// 精确枚举正式用例，避免影响 manual-review 副本或同名协议/会话场景。
// 子代理与工作流是 OMP 核心验收：显式 OMP 入口另纳入 omp-subagents.e2e.ts
// 和 omp-workflows.e2e.ts。下列旧夹具排除不代表取消对应原生产品能力。
export const FORK_TEMPORARY_E2E_EXCLUDES = [
  "./test/e2e/browser-empty-state-deferred-guest.test.ts",
  "./test/e2e/browser-human-viewport-preference.test.ts",
  "./test/e2e/browser-open-external-file-url.test.ts",
  "./test/e2e/browser-permission-prompt.test.ts",
  "./test/e2e/browser-tab-close-cross-workspace.test.ts",
  "./test/e2e/browser-tab-close-idempotent.test.ts",
  "./test/e2e/browser-tab-residency.test.ts",
  "./test/e2e/coding-plan-team-usage.test.ts",
  "./test/e2e/coding-plan-upgrade-personal-sold-out.test.ts",
  "./test/e2e/coding-plan-upgrade-personal-system-busy.test.ts",
  "./test/e2e/coding-plan-upgrade-webview-refresh-provider.test.ts",
  "./test/e2e/settings/coding-plan-entitlement-presentation.test.ts",
  "./test/e2e/ui-shell/marketing-touch-anonymous.test.ts",
  "./test/e2e/ui-shell/marketing-touch-delivery.test.ts",
  "./test/e2e/ui-shell/marketing-touch-entitlement.test.ts",
  "./test/e2e/ui-shell/marketing-touch-rewards.test.ts",
  "./test/e2e/oauth-credential-recovery.test.ts",
  "./test/e2e/oauth-login-failure-cancel.test.ts",
  "./test/e2e/help-client-config.test.ts",
  "./test/e2e/help-menu-about.test.ts",
  "./test/e2e/settings/shortcut-settings-key-search.test.ts",
  "./test/e2e/settings/shortcut-settings-realkeys.test.ts",
  "./test/e2e/settings/shortcut-settings-rebind.test.ts",
  "./test/e2e/settings/settings-ui-polish.test.ts",
  "./test/e2e/settings/settings-window-size-persistence.test.ts",
  "./test/e2e/settings/settings-language-system-default.test.ts",
  "./test/e2e/settings/settings-client-language-header.test.ts",
  "./test/e2e/ui-shell/side-pane-full-view.test.ts",
  "./test/e2e/ui-shell/side-pane-tabs-responsive-interactions.test.ts",
  "./test/e2e/workspace-file-tree-refresh.test.ts",
  "./test/e2e/workspace-file-tree/workspace-file-tree-compact-hierarchy.test.ts",
  "./test/e2e/workspace-file-tree/workspace-file-tree-shared-search.test.ts",
  "./test/e2e/task-list-archive-confirmation.test.ts",
  "./test/e2e/usage-stats/usage-stats-app-usage.test.ts",
  "./test/e2e/git/git-commit-dialog-ui-flow.test.ts",
  "./test/e2e/e2ecase-regression.test.ts",
  "./test/e2e/container-boot.test.ts",
  "./test/e2e/ui-shell/workspace-close-persists-across-restart.test.ts",
  "./test/e2e/settings/provider-plan-navigation-labels.test.ts",
  "./test/e2e/off-peak-automations-home-layout.test.ts",
  "./test/e2e/off-peak-limit-pre-gate.test.ts",
  "./test/e2e/bots/feishu-bound-groups-ui.test.ts",
  "./test/e2e/bots/feishu-runtime-error-ui.test.ts",
  "./test/e2e/workspace-agent-warmup-lifecycle.test.ts",
  "./test/e2e/workspace-agent-warmup-small-set.test.ts",
  "./test/e2e/workspace-passive-agent-startup.test.ts",
  "./test/e2e/workspace-provider-save-dormant-agent.test.ts",
  "./test/e2e/resource-manager.test.ts",
  "./test/e2e/resource-manager-network.test.ts",
  "./test/e2e/resource-manager-storage.test.ts",
  "./test/e2e/process-resource-telemetry-roles.test.ts",
  "./test/e2e/windows-agent-metric-probe-absence.test.ts",
  "./test/e2e/infrastructure/session-lifecycle.test.ts",
  "./test/e2e/bots/bot-automation-result-delivery.test.ts",
  "./test/e2e/bots/bot-remote-disconnected.test.ts",
  "./test/e2e/ui-shell/general-coding-mode.test.ts",
  "./test/e2e/chat-input-mention-navigation.test.ts",
  "./test/e2e/settings/settings-subagent-create-edit-persistence.test.ts",
  "./test/e2e/subagent-coding-plan-login-catalog-stale.test.ts",
  "./test/e2e/provider-family-responsive.test.ts",
  "./test/e2e/conversation-session/conversation-session-assistant-preview-cards.test.ts",
  "./test/e2e/conversation-session/conversation-session-hooks-lifecycle.test.ts",
  "./test/e2e/conversation-session/conversation-session-v4-composer-toolbar.test.ts",
  "./test/e2e/conversation-session/conversation-session-ask-user-question-keyboard-default-focus.test.ts",
  "./test/e2e/conversation-session/conversation-session-side-chat-reminder.test.ts",
  "./test/e2e/conversation-session/conversation-session-plugin-reference.test.ts",
  "./test/e2e/conversation-session/conversation-session-v4-plan-shortcut.test.ts",
  "./test/e2e/conversation-session/conversation-session-v4-attachment.test.ts",
  "./test/e2e/conversation-session/conversation-session-v4-attachment-layout.test.ts",
  "./test/e2e/conversation-session/conversation-session-v4-load-older.test.ts",
  "./test/e2e/conversation-session/conversation-session-v4-input-control.test.ts",
  "./test/e2e/conversation-session/conversation-session-v4-scroll.test.ts",
  "./test/e2e/conversation-session/conversation-session-v4-turn-navigator.test.ts",
  "./test/e2e/conversation-session/conversation-session-native-search-setting.test.ts",
  "./test/e2e/conversation-session/conversation-session-plan-approval-primary-submit.test.ts",
  "./test/e2e/conversation-session/conversation-session-markdown-table-layout.test.ts",
  "./test/e2e/conversation-session/conversation-session-markdown-preview-selection.test.ts",
  "./test/e2e/conversation-session/conversation-session-v4-video-preview.test.ts",
  "./test/e2e/conversation-session/conversation-session-markdown-table-enhanced-scroll.test.ts",
  "./test/e2e/conversation-session/conversation-session-task-title-marquee.test.ts",
  "./test/e2e/conversation-session/conversation-session-highspeed-card.test.ts",
  "./test/e2e/conversation-session/conversation-session-highspeed-card-draw-miss.test.ts",
  "./test/e2e/conversation-session/conversation-session-tool-detail-toggle-stability.test.ts",
  "./test/e2e/conversation-session/conversation-session-terminal-expanded-details-and-status.test.ts",
  "./test/e2e/conversation-session/conversation-session-composer-compression.test.ts",
  "./test/e2e/conversation-session/conversation-session-mention-selection.test.ts",
  "./test/e2e/conversation-session/conversation-session-pasted-image-path-edge-cases.test.ts",
  "./test/e2e/conversation-session/conversation-session-model-trajectory-viewer.test.ts",
  "./test/e2e/conversation-session/conversation-session-model-switch-image-strip.test.ts",
  "./test/e2e/conversation-session/conversation-session-composer-provider-identity.test.ts",
  "./test/e2e/conversation-session/conversation-session-toolsearch-local.test.ts",
  "./test/e2e/conversation-session/conversation-session-toolsearch-cli.test.ts",
  "./test/e2e/conversation-session/conversation-session-toolsearch-lifecycle.test.ts",
  "./test/e2e/conversation-session/conversation-session-toolsearch-compact.test.ts",
  "./test/e2e/conversation-session/conversation-session-toolsearch-recording.test.ts",
  "./test/e2e/conversation-session/conversation-session-toolsearch-settings.test.ts",
  // 物理 driver 固定原 CLI/bootstrap 或旧 storage-migrate seed，不能用 OMP 环境覆盖。
  // 真实 ToolSearch/feedback/只读 provider consumer 需求保留，旧执行对象不作 OMP 验收。
  "./test/e2e/conversation-session/conversation-session-toolsearch-recovery.test.ts",
  "./test/e2e/conversation-session/conversation-session-toolsearch-scope.test.ts",
  "./test/e2e/conversation-session/conversation-session-toolsearch-tui.test.ts",
  "./test/e2e/conversation-session/conversation-session-toolsearch-catalog.test.ts",
  "./test/e2e/conversation-session/conversation-session-toolsearch-feedback.test.ts",
  "./test/e2e/provider-readiness-agent-startup.test.ts",
  // 当前合同不支持专用 permission 界面、plugin_reference 投影或平行 Host trust store。
  // 合同排除不表示这些 spec 均已实测失败；rewrite 的旧库 setup 错误单独归因。
  "./test/e2e/conversation-session/conversation-session-permission-hook-rewrite.test.ts",
  "./test/e2e/conversation-session/conversation-session-permission-hook-race.test.ts",
  "./test/e2e/conversation-session/conversation-session-v4-bash-command-prefix-permission.test.ts",
  "./test/e2e/conversation-session/conversation-session-v4-permission.test.ts",
  "./test/e2e/conversation-session/conversation-session-v4-refresh-permission.test.ts",
  "./test/e2e/conversation-session/conversation-session-plugin-reference-subagent.test.ts",
  "./test/e2e/conversation-session/conversation-session-hook-trust.test.ts",
];

// 首轮暂缓的协议/Provider 场景仍允许精确单文件定向执行，宽泛 glob 不解除排除。
// 旧工具/私有存储夹具仅保留历史待迁移身份；子代理与工作流不能据此免验。
// 本次适配只运行新增的 OMP-native E2E，不重跑这些旧夹具。
export const FORK_DEFERRED_E2E_SPECS = [
  "./test/e2e/conversation-session/conversation-session-background.test.ts",
  "./test/e2e/conversation-session/conversation-session-goal-run-cases.test.ts",
  "./test/e2e/conversation-session/conversation-session-guarded.test.ts",
  "./test/e2e/conversation-session/conversation-session-tool-cross-product.test.ts",
  "./test/e2e/conversation-session/conversation-session-bash-direct-output.test.ts",
  "./test/e2e/conversation-session/conversation-session-compact-auto.test.ts",
  "./test/e2e/conversation-session/conversation-session-anthropic-reasoning-history-replay.test.ts",
  "./test/e2e/conversation-session/conversation-session-model-provider-restart-recovery.test.ts",
  "./test/e2e/conversation-session/conversation-session-model-provider-turbo-switch.test.ts",
  "./test/e2e/conversation-session/conversation-session-model-provider-turbo-recovery.test.ts",
  "./test/e2e/conversation-session/conversation-session-model-provider-settings-transition.test.ts",
  "./test/e2e/conversation-session/conversation-session-bot-continuous-worker.test.ts",
  "./test/e2e/conversation-session/conversation-session-bot-channel-worker.test.ts",
  "./test/e2e/conversation-session/conversation-session-bot-topic-worker.test.ts",
  "./test/e2e/bots/feishu-channel-mention.test.ts",
  "./test/e2e/bots/feishu-streaming-card-lifecycle.test.ts",
  "./test/e2e/bots/feishu-provider-interactions.test.ts",
  "./test/e2e/conversation-session/conversation-session-configurable-data-directory.test.ts",
  "./test/e2e/automations-create-manage.test.ts",
  "./test/e2e/automations-custom-monthly-interval.test.ts",
  "./test/e2e/automations-custom-yearly-schedule.test.ts",
  "./test/e2e/off-peak-create-manage.test.ts",
  // 旧 Agent 回放固定 Write(file_path)，与实际 OMP _write(path,i) 不兼容；
  // 保留用例与断言，联调归因证据见 docs/testing/omp-integration-blockers.md。
  "./test/e2e/conversation-session/conversation-session-fork-merged-assistant.test.ts",
  // 本地未配置构建期 telemetry endpoint，Host-only session_create 同样不发送。
  "./test/e2e/conversation-session/conversation-session-automation-run-title-stable.test.ts",
  // 标题 sidecar 误耗主 fixture 次数，真正 DETACHED 请求因 Missing Fixture 中断。
  "./test/e2e/conversation-session/conversation-session-chat-loading-live-tail.test.ts",
  // 依赖已排除的 native permission 反馈，不代表 CronCreate 普遍不支持。
  "./test/e2e/conversation-session/conversation-session-automation-cron-relative.test.ts",
  // 旧 AskUserQuestion/Agent 回放工具不存在，不能归因为原生问答或后台能力失败。
  "./test/e2e/conversation-session/conversation-session-ask-user-question-keyboard-navigation.test.ts",
  "./test/e2e/conversation-session/conversation-session-background-notification-batch.test.ts",
  "./test/e2e/conversation-session/conversation-session-built-in-subagent-model-overrides.test.ts",
  // 原生 session too small guard 尚未进入 compact transport，非 fallback 失败证据。
  "./test/e2e/conversation-session/conversation-session-compact-stream-fallback.test.ts",
  // usage 缺陷已修复；后续断言仍读取旧 Agent 私有 model-io 日志，不复制该内部格式。
  "./test/e2e/conversation-session/conversation-session-context-window-cold-resume.test.ts",
  // 旧 CronCreate wire 名断言且必须 approveV4Permission；本轮不扩 native approval 合同。
  "./test/e2e/conversation-session/conversation-session-automation-cron-create.test.ts",
  // SOURCE run 20261022084903410：实际广告 _todo，旧 fixture TodoWrite 返回 not found；
  // 未走到原生待办，不代表 native Todo 失败或 cold resume 已验收，保留精确 --spec。
  "./test/e2e/conversation-session/conversation-session-toolsearch.test.ts",
  // SOURCE run 20261022093234491：前置正文及 provider cap 校验已过，
  // 后续硬读旧 CLI compact.auto.skipped 私有日志失败；不伪造旧日志或取消原生预算需求。
  "./test/e2e/conversation-session/conversation-session-model-output-token-preflight-smoke.test.ts",
  // 以下仅据静态旧 Agent fixture/私有存储边界暂缓，未取得本轮单 spec 实测失败结果。
  // 保留精确 --spec 定向执行，不取消原生输出限制、Memory、子代理或文件回滚需求。
  // 旧 model-io 与精确 preflight-v1 策略；smoke 的独立实跑证据单列于上。
  "./test/e2e/conversation-session/conversation-session-model-output-token-preflight.test.ts",
  "./test/e2e/conversation-session/conversation-session-model-output-token-budget.test.ts",
  // 旧 Agent/SendMessage、子代理目录与 prompt 合同。
  "./test/e2e/conversation-session/conversation-session-send-message-resume-stop.test.ts",
  "./test/e2e/conversation-session/conversation-session-subagent-runtime-catalog-reasoning.test.ts",
  "./test/e2e/conversation-session/conversation-session-subagent-prompt-assembly.test.ts",
  "./test/e2e/conversation-session/conversation-session-subagent-respond-to-coordinator.test.ts",
  // 旧 Extraction/Memory 存储与工具、后台 Bash/Agent 及输出文件布局。
  "./test/e2e/conversation-session/conversation-session-memory.test.ts",
  "./test/e2e/conversation-session/conversation-session-background-bash-output.test.ts",
  "./test/e2e/conversation-session/conversation-session-background-subagent-rate-limit.test.ts",
  // 旧 image-cache、工具组合，以及不能创建所需真实文件的 Read/Write 回放。
  "./test/e2e/conversation-session/conversation-session-pasted-image-path-projection.test.ts",
  "./test/e2e/conversation-session/conversation-session-tool-group-settings-persistence.test.ts",
  "./test/e2e/conversation-session/conversation-session-v4-rewind-files.test.ts",
  // 根因：以下文件的全部成功路径必经旧工具，不能以未启动的工作验收原生能力。
  // 仅静态同源暂缓，未取得本轮独立失败；background-work 的 permission 等待是可选的。
  "./test/e2e/conversation-session/conversation-session-v4-background-work.test.ts",
  // T01 必经 Agent/AskUserQuestion；T02 另强制不支持的 permission，并必经 Agent/Bash。
  // 不连带排除 modified-submit、running-send-now 或 rewind 混合文件。
  "./test/e2e/conversation-session/conversation-session-subagent-interaction-delegate.test.ts",
  // 原生短会话无可压缩内容；真实 run 未发摘要请求，不伪造成功 marker。
  "./test/e2e/conversation-session/conversation-session-v4-compact.test.ts",
  // 旧 CLI MCP config、mcp/list 管理面与 dual-era 日志不属于当前 native 合同。
  "./test/e2e/settings/mcp-dual-era-version-negotiation.test.ts",
  // PV4-18/19/20 各自独立实跑都被 small-session guard 拒绝；后者 PV4-23 另有旧 Bash 前置。
  "./test/e2e/conversation-session/conversation-session-v4-rewind-compact-extended.test.ts",
  "./test/e2e/conversation-session/conversation-session-v4-rewind-queue-background.test.ts",
  // 独立原生 run 在首个 compact 返回 small-session，尚未到 edit。
  "./test/e2e/conversation-session/conversation-session-v4-edit.test.ts",
  // fork 已保留真实 lineage/父上下文；旧用例绑定私有英文 notice 及 string content。
  "./test/e2e/conversation-session/conversation-session-v4-fork.test.ts",
  // 旧 AskUserQuestion 及 Grep/error 文案 matcher 不匹配原生目录，主 continuation 被夹具拒绝。
  "./test/e2e/conversation-session/conversation-session-tool-input-validation-provider-content.test.ts",
  "./test/e2e/conversation-session/conversation-session-unregistered-tool-cold-snapshot.test.ts",
];

function normalizeFormalSpec(spec) {
  const normalized = `/${spec.trim().replaceAll("\\", "/")}`;
  const e2eRoot = normalized.lastIndexOf("/test/e2e/");
  return e2eRoot < 0 ? undefined : `.${normalized.slice(e2eRoot)}`;
}

export function isTemporarilyExcludedFormalSpec(spec) {
  const relativeSpec = normalizeFormalSpec(spec);
  return (
    relativeSpec !== undefined &&
    FORK_TEMPORARY_E2E_EXCLUDES.some((pattern) => posix.matchesGlob(relativeSpec, pattern))
  );
}

export function resolveDeferredFormalSpecExcludes({ requestedSpecs }) {
  const exactRequestedSpecs = new Set(requestedSpecs.map(normalizeFormalSpec));
  return FORK_DEFERRED_E2E_SPECS.filter((spec) => !exactRequestedSpecs.has(spec));
}

const REQUIRED_SSH_E2E_ENV = [
  "ZCODE_E2E_SSH_HOST",
  "ZCODE_E2E_SSH_USERNAME",
  "ZCODE_E2E_SSH_PASSWORD",
];

export function hasRequiredSshE2EEnvironment(env) {
  return REQUIRED_SSH_E2E_ENV.every((name) => env[name]?.trim());
}

export function isSshFormalSpec(spec) {
  return spec
    .replaceAll("\\", "/")
    .includes("/conversation-session/conversation-session-ssh-remote");
}

export function resolveEnvironmentGatedFormalSpecExcludes({ env, targeted }) {
  // 修复原因：SSH P0 依赖真实服务器，默认全量在无凭据时纳入只会把环境缺失
  // 误记为三个产品失败；显式定向运行仍保留 helper 的缺变量 fail-closed 提示。
  return !targeted && !hasRequiredSshE2EEnvironment(env) ? [SSH_FORMAL_SPEC_GLOB] : [];
}

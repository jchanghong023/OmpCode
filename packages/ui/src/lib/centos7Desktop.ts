declare const __OMPCODE_CENTOS7_DESKTOP__: boolean;

/**
 * CentOS 7 发布构建标记（`__OMPCODE_CENTOS7_DESKTOP__`）的封装模块与引用白名单。
 *
 * 需求边界（docs/requirements/FORK.md「上游同步策略与平台范围」、centos7-performance.md、
 * refactor-plan.md W4）：该标记只允许承载 CentOS 7 无 GPU 构建的渲染性能策略，
 * 允许出现的封装模块仅限——
 * - 本模块（唯一的 `__OMPCODE_CENTOS7_DESKTOP__` 字面量持有者）；
 * - `Root.tsx`（UI 根视觉策略：动画时长与过渡）；
 * - `components/ai-elements/message.tsx`（`MessageResponse` 100ms 流式正文缓冲）。
 *
 * 标记不得用于隐藏入口、分叉界面或表达功能可用性——功能关闭属于 `--offline` 离线锁定的
 * 运行时门控（见 `lib/offlineLockGate.ts`），两平台 UI 必须一致。兼容标记仅允许上述现行性能
 * 封装使用；CentOS 专用扫描测试已取消，不再作为自动测试要求。
 */
export const isCentos7DesktopBuild =
  typeof __OMPCODE_CENTOS7_DESKTOP__ !== "undefined" && __OMPCODE_CENTOS7_DESKTOP__;

/**
 * Hooks barrel export
 *
 * 所有服务和平台操作的 hooks 统一从此导出。
 * 组件应通过 hooks 访问服务，不再直接使用 services.* 或 window.zcode.*。
 */

// 服务上下文
export { ServiceProvider, useServices } from "./useServices.js";
export { useWorkspaceServices } from "./useWorkspaceServices.js";

// 平台操作上下文
export {
  PlatformProvider,
  usePlatform,
  useSelectDirectory,
  useConnectRemote,
} from "./usePlatform.js";

// 文件服务
export { useReaddir } from "./useFileService.js";

// 系统服务
export { useSystemInfo, useIntranetProbe } from "./useSystemService.js";

// 终端服务
export { useTerminal } from "./useTerminalService.js";

// 设置服务
export { useSettings, useRecentProjects } from "./useSettingService.js";

// 通用确认弹窗
export { useConfirmDialog } from "./useConfirmDialog.js";

// 凭据服务
export { useCredentials, useAuthToken } from "./useCredentials.js";

// Git pane
export { useGitRepository } from "./useGitRepository.js";
export { useGitActions } from "./useGitActions.js";

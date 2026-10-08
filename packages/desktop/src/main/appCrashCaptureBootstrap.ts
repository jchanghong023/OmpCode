import { logger } from "./logger.js";
import { initializeCrashCapture, type CrashCapturePaths } from "./desktopCrashCapture.js";

// 须在 appARMSBootstrap 之前完成：共享路径解析已按 OMP_CONFIG_ROOT 决定应用根，再配置 crashDumps。
// remoteCrashReporterEnabled=true 表示 ARMS 已接管远端 crash 上报，不再启动仅本地的 crashReporter。
export const crashCapturePaths: CrashCapturePaths = initializeCrashCapture(logger, true);

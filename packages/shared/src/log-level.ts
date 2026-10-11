/** 唯一应用日志级别配置；保留既有 wire/API 的 warn 拼写。浏览器安全，无 IO。 */
export type ApplicationLogLevel = "debug" | "info" | "warn" | "error";

const priorities: Record<ApplicationLogLevel, number> = { debug: 0, info: 1, warn: 2, error: 3 };

export function resolveApplicationLogLevel(value: string | undefined): ApplicationLogLevel {
  switch (value?.trim().toLowerCase()) {
    case "debug":
      return "debug";
    case "warning":
      return "warn";
    case "error":
      return "error";
    default:
      return "info";
  }
}

export function getApplicationLogLevel(): ApplicationLogLevel {
  // 环境由父进程继承；不读写用户配置，不以 NODE_ENV 或离线状态覆盖用户选择。
  if (typeof process !== "undefined" && process.env)
    return resolveApplicationLogLevel(process.env.JCH_LOG_LEVEL);
  const runtime = globalThis as typeof globalThis & { __JCH_LOG_LEVEL__?: string };
  const build = (import.meta as ImportMeta & { env?: { JCH_LOG_LEVEL?: string } }).env;
  return resolveApplicationLogLevel(runtime.__JCH_LOG_LEVEL__ ?? build?.JCH_LOG_LEVEL);
}

export function isApplicationLogLevelEnabled(
  level: ApplicationLogLevel,
  configured: ApplicationLogLevel = getApplicationLogLevel(),
): boolean {
  return priorities[level] >= priorities[configured];
}

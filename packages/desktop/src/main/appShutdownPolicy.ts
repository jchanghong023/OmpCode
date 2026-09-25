export type AppShutdownKind = "normal" | "update-install";

interface AppShutdownPolicy {
  forceKillDelayMs: number;
  waitTimeoutMs: number;
}

interface AppShutdownPolicySelection {
  kind: AppShutdownKind;
  policy: AppShutdownPolicy;
  upgraded: boolean;
}

const STRICT_SHUTDOWN_POLICY: AppShutdownPolicy = {
  forceKillDelayMs: 12_000,
  waitTimeoutMs: 12_500,
};

const WINDOWS_NORMAL_SHUTDOWN_POLICY: AppShutdownPolicy = {
  // Host 串行清理远端 registry 和服务最多需 6s + 3.5s；
  // Main 强杀必须晚于这两阶段，才能由 Host 回收 Agent 子进程。
  forceKillDelayMs: 12_000,
  waitTimeoutMs: 12_500,
};

export function resolveAppShutdownPolicy(
  kind: AppShutdownKind,
  platform: NodeJS.Platform,
): AppShutdownPolicy {
  if (platform === "win32" && kind === "normal") {
    return WINDOWS_NORMAL_SHUTDOWN_POLICY;
  }
  return STRICT_SHUTDOWN_POLICY;
}

export function selectAppShutdownPolicy(
  activeKind: AppShutdownKind | null,
  requestedKind: AppShutdownKind,
  platform: NodeJS.Platform,
): AppShutdownPolicySelection {
  // 更新安装的优先级只增不减：已创建的普通退出短 timer 不做破坏性重建，更新仍在
  // 现有屏障后 fail-open 进入资源扫描和安装器，保证“可能残留”不会升级成“无法更新”。
  const kind =
    activeKind === "update-install" || requestedKind === "update-install"
      ? "update-install"
      : "normal";
  return {
    kind,
    policy: resolveAppShutdownPolicy(kind, platform),
    upgraded: activeKind === "normal" && kind === "update-install",
  };
}

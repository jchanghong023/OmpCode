import { z } from "zod";
import type { MobileRelayEntryStatus } from "./channels.js";

/**
 * 离线锁定（CentOS 7 启动器 `--offline`）的唯一门控状态接口。
 *
 * 激活链：CentOS 7 启动器解析到 `--offline` 时设置 `OMPCODE_CENTOS7_LOCAL_ONLY=1`
 * （该变量的唯一设置者，Windows 不提供），桌面 Main/Host/Renderer 读取同一运行时
 * 变量关闭各自后端（需求见 docs/requirements/centos7-release.md「离线锁定的激活链」
 * 与 mobile-relay.md「平台与离线边界」）。本模块把同一事实派生成严格类型 +
 * 运行时校验的门控状态，经 `PlatformChannels.OfflineGateState` 暴露给 renderer；
 * 被关功能的 UI 禁用态由 UI 层（W4）消费本接口呈现，入口一律保留。
 *
 * 本接口只表达「后端是否被关闭」，不承载 UI 文案与呈现策略。
 */

/** CentOS 7 启动器 `--offline` 写入的离线锁定环境变量；唯一设置者是启动器。 */
export const OMPCODE_LOCAL_ONLY_ENV = "OMPCODE_CENTOS7_LOCAL_ONLY";

/**
 * 离线锁定下被逐一关闭的功能面。键与 centos7-release.md 的门控面清单一一对应，
 * 全部为 `true` 表示该功能后端已关闭；未锁定时全部为 `false`（与 Windows 全功能基准一致）。
 */
export const offlineDisabledFeaturesSchema = z.strictObject({
  /** 手机远控 relay：不监听、不建立桥接；手机主动连入在 TCP 层被拒绝。 */
  mobileRelay: z.boolean(),
  /** 公网更新检查（含调度与手动检查）。 */
  publicUpdateCheck: z.boolean(),
  /** 公网配置下发（客户端 configs/灰度请求）。 */
  publicConfig: z.boolean(),
  /** 公网帮助/更新说明外链。 */
  publicHelp: z.boolean(),
  /** 社区入口。 */
  community: z.boolean(),
  /** 反馈入口。 */
  feedback: z.boolean(),
  /** 账号与分享。 */
  accountShare: z.boolean(),
  /** 系统默认浏览器拉起外部 URL。 */
  externalBrowser: z.boolean(),
  /** 遥测与应用启动/日活调度。 */
  telemetry: z.boolean(),
  /** Host 在线 bot 任务（不启动、不放行）。 */
  hostOnlineBots: z.boolean(),
  /** 推荐提示词远程源（锁定下仅引用本地任务与内嵌图标）。 */
  remoteRecommendedPrompts: z.boolean(),
});

export const offlineGateStateSchema = z.strictObject({
  /** 当前进程是否处于离线锁定（启动器传入 `--offline`）。 */
  localOnly: z.boolean(),
  disabledFeatures: offlineDisabledFeaturesSchema,
});

export type OfflineDisabledFeatures = z.infer<typeof offlineDisabledFeaturesSchema>;
export type OfflineGateState = z.infer<typeof offlineGateStateSchema>;

const ALL_DISABLED_FEATURE_KEYS = Object.keys(
  offlineDisabledFeaturesSchema.shape,
) as Array<keyof OfflineDisabledFeatures>;

/**
 * 从进程环境派生唯一门控状态。Main 是该状态的唯一所有者：只在此依据
 * `OMPCODE_CENTOS7_LOCAL_ONLY` 裁决一次，renderer 不得各自读环境变量再解释。
 */
export function resolveOfflineGateState(
  env: Readonly<Record<string, string | undefined>>,
): OfflineGateState {
  const localOnly = env[OMPCODE_LOCAL_ONLY_ENV] === "1";
  return {
    localOnly,
    disabledFeatures: Object.fromEntries(
      ALL_DISABLED_FEATURE_KEYS.map((feature) => [feature, localOnly]),
    ) as OfflineDisabledFeatures,
  };
}

/** 运行时校验外部输入（IPC payload、持久化快照等）；非法输入抛错，不静默放行。 */
export function parseOfflineGateState(input: unknown): OfflineGateState {
  return offlineGateStateSchema.parse(input);
}

/** 手机远控入口在离线锁定下的稳定禁用原因码（UI 可据此分支，文案归 locales）。 */
export const MOBILE_RELAY_OFFLINE_LOCKED_ERROR = "offline-locked";

/**
 * 离线锁定下的手机远控入口状态：后端整体关闭（不监听、不建立桥接），
 * 入口 IPC 仍注册并回报禁用状态；手机主动连入没有监听者，在 TCP 层被明确拒绝。
 */
export function buildOfflineLockedMobileRelayEntryStatus(params: {
  url: string;
  listenPort: number;
}): MobileRelayEntryStatus {
  return {
    url: params.url,
    connections: 0,
    listenPort: params.listenPort,
    running: false,
    error: MOBILE_RELAY_OFFLINE_LOCKED_ERROR,
  };
}

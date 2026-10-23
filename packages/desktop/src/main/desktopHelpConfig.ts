import {
  buildHelpAppConfigUrl,
  buildZCodeSourceHeadersFromContext,
  createHelpAppConfigReader,
  ZCODE_ENV,
} from "@zcode/shared";

export function createDesktopHelpConfigReader(options: {
  resolveEndpointOrigin: () => Promise<string>;
  appVersion: string;
  deviceMid: string;
  /** 当前界面语言；以前不传，X-Client-Language 固定为 unknown。 */
  getClientLanguage: () => string;
}) {
  const read = createHelpAppConfigReader({
    // 离线网络隔离（docs/requirements/offline-network-isolation.md）：帮助配置读取
    // 不再经 Electron net.fetch 出网；读取失败由 openFeedback/openCommunity 回退本地配置。
    fetchImpl: () => Promise.reject(new Error("[offline] help config remote fetch disabled")),
  });
  return async () => {
    const endpointOrigin = await options.resolveEndpointOrigin();
    return read(
      buildHelpAppConfigUrl(
        endpointOrigin,
        options.appVersion,
        `${process.platform}-${process.arch}`,
      ),
      buildZCodeSourceHeadersFromContext({
        endpointOrigin,
        appVersion: options.appVersion,
        clientLanguage: options.getClientLanguage(),
        deviceMid: options.deviceMid,
        platform: process.platform,
        arch: process.arch,
        releaseChannel: ZCODE_ENV,
        sourceTitle: "electron",
      }),
    );
  };
}

import { isLoopbackUrl } from "@zcode/shared";

/** Host 的原生 fetch 不经过 Electron Session，离线限制必须在自身出口执行。 */
export function createHostLocalOnlyFetch(fetchImpl: typeof fetch): typeof fetch {
  return async (input, init) => {
    const url = input instanceof Request ? input.url : String(input);
    if (!isLoopbackUrl(url)) {
      throw new Error("CentOS 7 desktop public network access is disabled");
    }
    // 修复原因：仅检查初始回环 URL 后自动跟随重定向，会绕过离线门控请求公网。
    // 在锁定模式明确拒绝重定向，不能让底层 fetch 在门控之外产生下一次请求。
    return fetchImpl(input, { ...init, redirect: "error" });
  };
}

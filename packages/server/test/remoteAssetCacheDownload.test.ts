import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { ensureRemoteReleaseDirFromCdn } from "../src/remote/remoteAssetCache.js";

const PLATFORM_ARCH = "linux-x64";
const APP_VERSION = "0.0.0-test";
const SHA256 = "a".repeat(64);

const MANIFEST = {
  schemaVersion: 1,
  appVersion: APP_VERSION,
  platformArch: PLATFORM_ARCH,
  components: [
    {
      id: "ripgrep",
      version: "v1.0.0",
      sha256: SHA256,
      artifactPath: "components/ripgrep/linux-x64/v1.0.0/component.tar.gz",
      mount: `tools/${PLATFORM_ARCH}/ripgrep`,
    },
  ],
};

/**
 * F18：manifest 候选正常返回；制品候选永不结束（仅遵守 abort signal，与真实 fetch 语义一致），
 * 用于验证制品下载超时后锁释放、同 key 请求可重新发起。
 */
function createFakeFetch() {
  let hangingRequests = 0;
  const fetchImpl: typeof globalThis.fetch = async (input, init) => {
    const url = String(input);
    if (url.includes(`manifest-${PLATFORM_ARCH}.json`)) {
      return new Response(JSON.stringify(MANIFEST), { status: 200 });
    }
    hangingRequests += 1;
    const signal = init?.signal;
    return new Promise<Response>((_resolve, reject) => {
      signal?.addEventListener("abort", () => {
        reject(signal.reason);
      });
    });
  };
  return { fetch: fetchImpl, hangingRequests: () => hangingRequests };
}

test("artifact download timeout fails the locked task and releases the single-flight lock", async () => {
  const cacheDir = await mkdtemp(join(tmpdir(), "remote-asset-cache-f18-"));
  try {
    const { fetch: fetchImpl, hangingRequests } = createFakeFetch();
    const loggers = { log: () => undefined, logWarn: () => undefined };
    const options = {
      remoteCdnBaseUrls: ["http://cdn.test"],
      remoteCacheDir: cacheDir,
      version: APP_VERSION,
      platformArch: PLATFORM_ARCH,
      componentIds: ["ripgrep"],
      manifestRequestTimeoutMs: 5_000,
      artifactRequestTimeoutMs: 50,
      remoteAssetNetwork: { fetch: fetchImpl },
    };

    // F18 核心断言 1：挂死的制品下载在注入超时后必须失败，而不是永久 pending。
    await assert.rejects(ensureRemoteReleaseDirFromCdn(options, loggers), (error: unknown) => {
      const message = error instanceof Error ? error.message : String(error);
      assert.match(message, /\[remote-assets\] failed to fetch/u);
      assert.match(message, /TimeoutError/u);
      return true;
    });
    const firstAttemptCount = hangingRequests();
    assert.ok(firstAttemptCount >= 1);

    // F18 核心断言 2：失败任务已把 component/release 锁出队，同 key 请求可重新发起新下载。
    await assert.rejects(ensureRemoteReleaseDirFromCdn(options, loggers), /failed to fetch/u);
    assert.ok(hangingRequests() > firstAttemptCount);
  } finally {
    await rm(cacheDir, { recursive: true, force: true });
  }
});

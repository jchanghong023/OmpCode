import assert from "node:assert/strict";
import { test } from "node:test";
import { resolveRemoteArtifactContentLength } from "../src/remote/remoteAssetInstaller.js";

/** F19：首个 HEAD 候选永不结束（遵守 abort signal），第二个候选正常返回 content-length。 */
function createFakeFetch() {
  const abortedUrls: string[] = [];
  const fetchImpl: typeof globalThis.fetch = async (input, init) => {
    const url = String(input);
    if (url.endsWith("hanging.tar.gz")) {
      const signal = init?.signal;
      return new Promise<Response>((_resolve, reject) => {
        signal?.addEventListener("abort", () => {
          abortedUrls.push(url);
          reject(signal.reason);
        });
      });
    }
    return new Response("", { status: 200, headers: { "content-length": "1234" } });
  };
  return { fetch: fetchImpl, abortedUrls };
}

test("hanging HEAD candidate times out and download falls through to the next candidate", async () => {
  const { fetch: fetchImpl, abortedUrls } = createFakeFetch();

  const totalBytes = await resolveRemoteArtifactContentLength(
    ["http://cdn.test/hanging.tar.gz", "http://cdn.test/next.tar.gz"],
    { fetch: fetchImpl },
    50,
  );

  // HEAD 只服务进度统计：挂死候选被短超时取消后必须静默继续下一候选（既有语义）。
  assert.equal(totalBytes, 1234);
  assert.deepEqual(abortedUrls, ["http://cdn.test/hanging.tar.gz"]);
});

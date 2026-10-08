import assert from "node:assert/strict";
import { createServer, type Server } from "node:http";
import { once } from "node:events";
import { test } from "node:test";
import { Agent } from "undici";
import { createHostApiNetworkTransport } from "../src/providers/api/nodeApiNetwork.js";
import { createHostLocalOnlyFetch } from "../../desktop/src/host/offlineFetch.js";

async function listen(server: Server): Promise<string> {
  server.listen(0, "127.0.0.1");
  await once(server, "listening");
  const address = server.address();
  if (!address || typeof address === "string") throw new Error("expected TCP address");
  return `http://127.0.0.1:${address.port}`;
}

async function close(server: Server): Promise<void> {
  server.closeAllConnections();
  await new Promise<void>((resolve, reject) => {
    server.close((error) => (error ? reject(error) : resolve()));
  });
}

test("offline Host and both API fetch routes reject redirects without a second request", async () => {
  const previous = process.env.OMPCODE_CENTOS7_LOCAL_ONLY;
  process.env.OMPCODE_CENTOS7_LOCAL_ONLY = "1";
  let targetRequests = 0;
  const target = createServer((_request, response) => {
    targetRequests += 1;
    response.end("target");
  });
  const targetUrl = await listen(target);
  const redirect = createServer((request, response) => {
    if (request.url === "/ok") return response.end("loopback");
    response.writeHead(302, {
      Location: request.url === "/public" ? "https://example.invalid/blocked" : targetUrl,
    });
    response.end();
  });
  const redirectUrl = await listen(redirect);
  const direct = createHostApiNetworkTransport(async () => ({}));
  // 用真实 undici Agent 走 dispatcher 分支，不读证书/代理或用户配置。
  const dispatched = createHostApiNetworkTransport(
    async () => ({ caCertPath: "isolated-test-dispatcher" }),
    { createDispatcher: async () => new Agent() },
  );
  const transports = [createHostLocalOnlyFetch(globalThis.fetch), direct.fetch, dispatched.fetch];
  try {
    for (const fetchImpl of transports) {
      assert.equal(await (await fetchImpl(`${redirectUrl}/ok`)).text(), "loopback");
      await assert.rejects(fetchImpl(`${redirectUrl}/public`, { redirect: "follow" }));
      await assert.rejects(fetchImpl(new Request(`${redirectUrl}/local`, { redirect: "follow" })));
      await assert.rejects(fetchImpl("https://example.invalid/blocked"), /disabled/);
    }
    assert.equal(targetRequests, 0, "redirect destinations must not receive any request");
  } finally {
    await Promise.all([direct.disposeAndWait(), dispatched.disposeAndWait()]);
    await Promise.all([close(redirect), close(target)]);
    if (previous === undefined) delete process.env.OMPCODE_CENTOS7_LOCAL_ONLY;
    else process.env.OMPCODE_CENTOS7_LOCAL_ONLY = previous;
  }
});

test("normal API mode retains native redirect behavior on direct and dispatcher routes", async () => {
  const previous = process.env.OMPCODE_CENTOS7_LOCAL_ONLY;
  delete process.env.OMPCODE_CENTOS7_LOCAL_ONLY;
  let targetRequests = 0;
  const target = createServer((_request, response) => {
    targetRequests += 1;
    response.end("redirected");
  });
  const targetUrl = await listen(target);
  const redirect = createServer((_request, response) => {
    response.writeHead(302, { Location: targetUrl });
    response.end();
  });
  const redirectUrl = await listen(redirect);
  const direct = createHostApiNetworkTransport(async () => ({}));
  const dispatched = createHostApiNetworkTransport(
    async () => ({ caCertPath: "isolated-test-dispatcher" }),
    { createDispatcher: async () => new Agent() },
  );
  try {
    for (const transport of [direct, dispatched]) {
      assert.equal(await (await transport.fetch(redirectUrl)).text(), "redirected");
    }
    assert.equal(targetRequests, 2);
  } finally {
    await Promise.all([direct.disposeAndWait(), dispatched.disposeAndWait()]);
    await Promise.all([close(redirect), close(target)]);
    if (previous === undefined) delete process.env.OMPCODE_CENTOS7_LOCAL_ONLY;
    else process.env.OMPCODE_CENTOS7_LOCAL_ONLY = previous;
  }
});

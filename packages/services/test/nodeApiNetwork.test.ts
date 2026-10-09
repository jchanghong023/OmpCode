import assert from "node:assert/strict";
import { createServer, type Server } from "node:http";
import { once } from "node:events";
import { test } from "node:test";
import { Agent } from "undici";
import { createHostApiNetworkTransport } from "../src/providers/api/nodeApiNetwork.js";

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

import { strict as assert } from "node:assert";
import { test } from "node:test";
import { isLoopbackUrl, isPrivateNetworkEndpoint } from "../src/privateNetwork.ts";

test("only the embedded browser can access the enterprise network", async () => {
  const lookup = async (host) => {
    if (host === "api.corp.example.com") return ["10.23.5.7", "fd00::42"];
    if (host === "mixed.corp.example.com") return ["10.23.5.7", "8.8.8.8"];
    return ["8.8.8.8"];
  };
  assert.equal(await isPrivateNetworkEndpoint("https://cdn-zcode.z.ai/file", lookup), false);
  assert.equal(await isPrivateNetworkEndpoint("https://api.corp.example.com/v1", lookup), true);
  assert.equal(await isPrivateNetworkEndpoint("https://mixed.corp.example.com/v1", lookup), false);
  assert.equal(await isPrivateNetworkEndpoint("http://127.0.0.1:1234", lookup), true);
  assert.equal(await isPrivateNetworkEndpoint("http://192.168.1.2", lookup), true);
  assert.equal(await isPrivateNetworkEndpoint("file:///tmp/app.html", lookup), true);
  assert.equal(await isPrivateNetworkEndpoint("ftp://example.com", lookup), false);
  assert.equal(isLoopbackUrl("https://api.corp.example.com/v1"), false);
  assert.equal(isLoopbackUrl("http://192.168.1.2"), false);
  assert.equal(isLoopbackUrl("http://127.0.0.1:1234"), true);
});

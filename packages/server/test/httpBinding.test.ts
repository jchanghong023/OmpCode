import assert from "node:assert/strict";
import { test } from "node:test";
import { resolveHttpBindHost } from "../src/http.js";

test("unauthenticated HTTP server is loopback only", () => {
  assert.equal(resolveHttpBindHost(undefined, undefined), "127.0.0.1");
  assert.equal(resolveHttpBindHost("localhost", undefined), "localhost");
  assert.throws(() => resolveHttpBindHost("0.0.0.0", undefined), /authentication token/);
  assert.throws(() => resolveHttpBindHost("::", ""), /authentication token/);
  assert.equal(resolveHttpBindHost("0.0.0.0", "secret"), "0.0.0.0");
});

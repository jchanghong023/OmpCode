import assert from "node:assert/strict";
import { test } from "node:test";
import { buildRemoteAgentBundleWrapper } from "../src/remote/zcodeAgentBundleWrapper.js";

test("remote Agent wrapper only uses the OmpCode deployment root", () => {
  const script = buildRemoteAgentBundleWrapper("linux-x64");
  assert.match(script, /\.ompcode\/server/);
  assert.match(script, /\$runtime_root\/agents\/linux-x64\/omp-agent\.cjs/);
  assert.doesNotMatch(script, /\.zcode\/server/);
});

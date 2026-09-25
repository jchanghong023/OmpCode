import assert from "node:assert/strict";
import { test } from "node:test";
import { resolveAppShutdownPolicy } from "../src/main/appShutdownPolicy.js";

test("Main allows Host's sequential cleanup phases to finish", () => {
  for (const platform of ["win32", "linux", "darwin"] as const) {
    for (const kind of ["normal", "update-install"] as const) {
      const policy = resolveAppShutdownPolicy(kind, platform);
      assert.ok(policy.forceKillDelayMs > 6_000 + 3_500);
      assert.ok(policy.waitTimeoutMs > policy.forceKillDelayMs);
    }
  }
});

import assert from "node:assert/strict";
import test from "node:test";
import { createBotsService } from "../src/bots/botsService.js";

test("CentOS 7 bot service rejects manual entry before constructing providers", async () => {
  const previous = process.env.OMPCODE_CENTOS7_LOCAL_ONLY;
  try {
    process.env.OMPCODE_CENTOS7_LOCAL_ONLY = "1";
    const service = createBotsService(undefined as never);
    await assert.rejects(service.listBots(), /unavailable/);
    await assert.rejects(service.beginWeixinRegistration(), /unavailable/);
    await service.disposeAllAndWait();
  } finally {
    if (previous === undefined) delete process.env.OMPCODE_CENTOS7_LOCAL_ONLY;
    else process.env.OMPCODE_CENTOS7_LOCAL_ONLY = previous;
  }
});

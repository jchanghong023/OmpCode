import assert from "node:assert/strict";
import test from "node:test";
import { zcodeOmpModelRolesResultSchema } from "../src/zcode-protocol/index.js";

test("OMP 无会话目录的模型角色载荷通过校验，不伪造会话身份", () => {
  const result = zcodeOmpModelRolesResultSchema.parse({
    roles: [{ roleId: "default", configurable: true }],
    sessionModel: { model: { provider: "zhipu-coding-plan", modelId: "glm-5.3-flash" } },
  });
  assert.equal(result.roles[0]?.roleId, "default");
  assert.equal(result.sessionModel?.model?.modelId, "glm-5.3-flash");
  assert.equal(result.sessionModel?.sessionId, undefined);
});

test("角色目录仍拒绝无效会话身份及无效模型字段", () => {
  for (const sessionModel of [{ sessionId: 1 }, { model: { provider: 1 } }]) {
    assert.equal(
      zcodeOmpModelRolesResultSchema.safeParse({ roles: [], sessionModel }).success,
      false,
    );
  }
  assert.equal(
    zcodeOmpModelRolesResultSchema.parse({ roles: [], sessionModel: { sessionId: "s" } })
      .sessionModel?.sessionId,
    "s",
  );
});

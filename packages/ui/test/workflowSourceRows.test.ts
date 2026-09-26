import assert from "node:assert/strict";
import test from "node:test";
import { stableWorkflowSourceRows } from "../src/v4/workflowRunCardJoin.js";

test("assistant 文本更新不使 workflow 行输入失效，工具更新仍失效", () => {
  const header = { kind: "turnHeader", rowId: 1 } as never;
  const tool = { kind: "toolCall", rowId: 2 } as never;
  const first = stableWorkflowSourceRows([header, tool], undefined);
  const same = stableWorkflowSourceRows(
    [header, { kind: "assistantText", rowId: 3 } as never, tool],
    first,
  );
  assert.equal(same, first);
  const changed = stableWorkflowSourceRows([header, { ...tool }], first);
  assert.notEqual(changed, first);
});

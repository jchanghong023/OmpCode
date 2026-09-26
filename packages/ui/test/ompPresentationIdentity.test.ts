import assert from "node:assert/strict";
import test from "node:test";
import { getZCodeToolFamilyForName, isTodoPlanToolName } from "@zcode/shared";
import { resolveToolCallIdentity } from "../src/lib/toolIdentity.js";
import { pendingUserInputToViewModel } from "../src/v4/pendingInteractionAdapter.js";
import {
  getAgentKindLabel,
  getAgentPrimaryText,
  getAgentPrompt,
} from "../src/ToolCallBlocks/renderers/agentHelpers.js";

test("omp confirm 映射成可应答的双选交互", () => {
  const model = pendingUserInputToViewModel({
    interactionId: "confirm-1",
    kind: "userInput",
    anchorRowId: null,
    createdAt: 1,
    payload: { kind: "userInput", prompt: "继续？", freeText: false },
  });
  assert.equal(model.confirmation, true);
});

test("omp todo 使用待办身份与计划提取入口", () => {
  assert.equal(getZCodeToolFamilyForName("todo"), "todo");
  assert.equal(resolveToolCallIdentity({ toolName: "todo" }).family, "todo");
  assert.equal(isTodoPlanToolName("todo"), true);
});

test("omp task 卡片保留 agent 类型和任务文本", () => {
  const toolCall = {
    kind: "task",
    input: { agent: "reviewer", task: "检查登录状态" },
    raw: { inputPreviewComplete: true },
  } as unknown as Parameters<typeof getAgentKindLabel>[0];
  assert.equal(getAgentKindLabel(toolCall, "general-purpose"), "reviewer");
  assert.equal(getAgentPrimaryText(toolCall, "子智能体"), "检查登录状态");
  assert.equal(getAgentPrompt(toolCall), "检查登录状态");
});

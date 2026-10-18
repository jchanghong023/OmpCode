import assert from "node:assert/strict";
import { z } from "zod";
import { attachmentInput } from "./ompAttachmentInput.mjs";

const messageSchema = z.object({ role: z.string(), content: z.unknown() });
const contextSchema = z.object({ messages: z.array(messageSchema) });
const blocksSchema = z.array(z.looseObject({ type: z.string() }));

type TextAttachment = { name: string; mime: string; text: string };
type ImageSource = { type: "base64"; media_type: string; data: string };
export type AttachmentRequest = {
  prompt: string;
  files?: readonly TextAttachment[];
  images?: readonly ImageSource[];
  reply: string;
};

export function strictAttachmentRequests(steps: readonly AttachmentRequest[]) {
  assert.ok(steps.length > 0, "严格脚本必须明确列出请求，不能空数组成功");
  let received = 0;
  return {
    handler(rawContext: unknown) {
      const { messages } = contextSchema.parse(rawContext);
      const step = steps[received];
      assert.ok(step, `出现脚本以外的第 ${received + 1} 次模型请求`);
      // 逐轮核对完整对话，而不是从任意历史消息找到一个关键词就放行；重试和串会话也必须失败。
      assert.equal(messages.length, received * 2 + 1, "附件对话的输入/回复顺序必须严格交替");
      for (let index = 0; index <= received; index++) {
        const expected = steps[index]!;
        const input = messages[index * 2]!;
        assert.equal(input.role, "user");
        assert.deepEqual(
          attachmentInput(input.content),
          {
            prompt: expected.prompt,
            files: expected.files ?? [],
            images: expected.images ?? [],
          },
          `第 ${index + 1} 轮附件正文、字节、顺序及业务输入必须精确匹配`,
        );
        if (index < received) {
          const assistant = messages[index * 2 + 1]!;
          assert.equal(assistant.role, "assistant");
          const content =
            typeof assistant.content === "string"
              ? assistant.content
              : blocksSchema.parse(assistant.content);
          if (typeof content === "string") assert.equal(content, expected.reply);
          else
            assert.deepEqual(
              content.map((block) => ({ type: block.type, text: block.text })),
              [{ type: "text", text: expected.reply }],
            );
        }
      }
      received++;
      return { content: [step.reply] };
    },
    assertFinished(calls: readonly unknown[]) {
      assert.equal(received, steps.length, "所有约定请求都必须实际抵达模型");
      assert.equal(calls.length, steps.length, "实际 HTTP 请求不可遗漏、重试或额外调用");
    },
    replies: steps.map((step) => step.reply),
  };
}

export function strictRequestContent(
  calls: readonly unknown[],
  prompt: string,
  fromCall = 0,
): unknown {
  const matches = calls
    .slice(fromCall)
    .map((call) => {
      const { context } = z.object({ context: contextSchema }).parse(call);
      const last = context.messages.at(-1);
      assert.ok(last && last.role === "user", "真实请求必须以当前用户输入结尾");
      return { content: last.content, input: attachmentInput(last.content) };
    })
    .filter(({ input }) => input.prompt === prompt);
  assert.equal(
    matches.length,
    1,
    `业务输入 ${prompt} 必须对应恰一次当前 HTTP 请求，不能命中历史或前缀`,
  );
  return matches[0]!.content;
}

export function assertAttachmentReplies(
  rows: Iterable<Record<string, unknown>>,
  replies: readonly string[],
) {
  const assistants = [...rows].filter((row) => row.kind === "assistantText");
  assert.deepEqual(
    assistants.map((row) => ({ text: row.text, state: row.state })),
    replies.map((text) => ({ text, state: "complete" })),
    "每轮必须有唯一、完整、精确的回复；空文本或通用成功回复不能通过",
  );
}

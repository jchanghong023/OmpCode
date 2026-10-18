import { zcodeProtocolMethods } from "@zcode/shared";
import { z } from "zod";
import type { RealOmpHarness } from "./realOmpHarness.js";

const listedSessionsSchema = z.object({
  sessions: z.array(z.object({ sessionId: z.string().min(1) })),
});
const historySchema = z.object({
  messages: z.array(
    z.object({
      info: z.object({ messageId: z.string(), role: z.string() }),
      parts: z.array(
        z.object({
          partId: z.string(),
          messageId: z.string(),
          type: z.string(),
          text: z.string().optional(),
        }),
      ),
    }),
  ),
});

// 通过公开历史 owner 同时检查首发拒绝未留下另一个会话或持久用户输入；
// 不仅比较已有订阅的 userInput 行，也不依赖下一次模型请求才发现部分提交。
export async function storedAttachmentUserInputs(h: RealOmpHarness) {
  const listed = listedSessionsSchema.parse(await h.request(zcodeProtocolMethods.sessionList, {}));
  return Promise.all(
    listed.sessions
      .map(({ sessionId }) => sessionId)
      .sort()
      .map(async (sessionId) => {
        const history = historySchema.parse(
          await h.request(zcodeProtocolMethods.sessionRead, { sessionId }),
        );
        return {
          sessionId,
          users: history.messages.filter((message) => message.info.role === "user"),
        };
      }),
  );
}

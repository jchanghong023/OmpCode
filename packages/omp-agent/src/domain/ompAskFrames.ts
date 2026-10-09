// 富 ask 帧形状（extension_ui_request method:"ask" 的问题集；oh-my-pi rpc-mode.ts
// requestRpcAskDialog → {method:"ask", questions, timeout}，set_ask_dialog 启用后下发）。
// 自 ompFrames.ts 拆出（架构 max-file-lines=400）。

import { z } from "zod";

const ompAskOptionSchema = z.object({
  label: z.string(),
  description: z.string().optional(),
  preview: z.string().optional(),
});
export const ompAskQuestionSchema = z.object({
  id: z.string(),
  question: z.string(),
  header: z.string().optional(),
  options: z.array(ompAskOptionSchema),
  multi: z.boolean().optional(),
  /** 服务端推荐项（选项数组下标）；超时自动按推荐收尾。 */
  recommended: z.number().optional(),
});
export type OmpAskQuestion = z.infer<typeof ompAskQuestionSchema>;

/** 富 ask 应答行（extension_ui_response answers 变体；id 必须等于题目 id）。 */
export type OmpAskAnswerFrame = { id: string; selectedOptions: string[]; customInput?: string };

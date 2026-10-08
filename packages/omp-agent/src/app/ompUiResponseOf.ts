// omp UI 应答 → extension_ui_response 帧的投影（自 ompInteractionProxy.ts 拆出）。

import type { HostUserInputAnswer, OmpUiRequest } from "./ports.js";

export function toOmpUiResponse(request: OmpUiRequest, answer: HostUserInputAnswer) {
  if (answer.action === "cancel") {
    return {
      type: "extension_ui_response" as const,
      id: request.frame.id,
      cancelled: true as const,
    };
  }
  if (request.frame.method === "confirm") {
    return {
      type: "extension_ui_response" as const,
      id: request.frame.id,
      confirmed: answer.action === "accept",
    };
  }
  // S5-1 依据：omp 侧取消语义 = {cancelled:true}——parseValueDialogResponse
  // （rpc-session-host.ts）仅在响应携带 "value" 时直通，"cancelled" → undefined
  // （TUI ESC 亦走该路径）。extension_ui select 是通用扩展选择框（含工具审批的
  // Approve/Deny），不存在「dismiss≈deny」语义；宿主 ElicitationDialog 的
  // dismiss/ESC 均发 decline，此前合成「deny 选项/末位选项」会把用户关闭对话框
  // 上报为选中肯定选项，替用户执行动作（fail-open）。
  if (answer.action === "decline") {
    return {
      type: "extension_ui_response" as const,
      id: request.frame.id,
      cancelled: true as const,
    };
  }
  if (request.frame.method === "select") {
    // 审批首项是 Approve：缺少选择时默认首项会静默放行。只采纳明确且一致的合法选项。
    const prompt = request.frame.message ?? request.frame.prompt ?? request.frame.title ?? "";
    const answers = answer.content?.answers;
    const named =
      typeof answers === "object" && answers !== null
        ? (answers as Record<string, unknown>)[prompt]
        : undefined;
    const candidates = [
      answer.optionId,
      answer.content?.optionId,
      answer.content?.answer,
      answer.content?.answer_0,
      named,
    ].filter((value) => value !== undefined);
    if (candidates.some((value) => Array.isArray(value) && value.length !== 1)) {
      return {
        type: "extension_ui_response" as const,
        id: request.frame.id,
        cancelled: true as const,
      };
    }
    const values = candidates.flatMap((value) => (Array.isArray(value) ? value : [value]));
    const selected = values[0];
    if (
      typeof selected !== "string" ||
      !request.frame.options?.includes(selected) ||
      values.some((value) => value !== selected)
    ) {
      return {
        type: "extension_ui_response" as const,
        id: request.frame.id,
        cancelled: true as const,
      };
    }
    return { type: "extension_ui_response" as const, id: request.frame.id, value: selected };
  }
  // S5-4 依据：此处为 input/editor 无选项形态。omp requestRpcEditor 对响应的
  // pendingRequests resolve 把 "value" 直通采纳为编辑结果；accept 而无文本时回
  // value:"" 会用空串覆盖原值（原文事实性丢失），必须按取消终止本次编辑。
  // GUI 富单题文本通过 content.answer/answer_0 返回，不一定携带 freeText。
  const contentText = answer.content?.answer ?? answer.content?.answer_0;
  const freeText = answer.freeText ?? (typeof contentText === "string" ? contentText : "");
  if (freeText.length === 0) {
    return {
      type: "extension_ui_response" as const,
      id: request.frame.id,
      cancelled: true as const,
    };
  }
  return { type: "extension_ui_response" as const, id: request.frame.id, value: freeText };
}

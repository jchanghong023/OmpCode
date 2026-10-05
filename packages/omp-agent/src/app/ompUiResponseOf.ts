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
  // （TUI ESC 亦走该路径）。extension_ui select 是通用扩展选择框（v3 权限审批走
  // permission_request），不存在「dismiss≈deny」语义；宿主 ElicitationDialog 的
  // dismiss/ESC 均发 decline，此前合成「deny 选项/末位选项」会把用户关闭对话框
  // 上报为选中肯定选项，替用户执行动作（fail-open）。
  if (answer.action === "decline") {
    return {
      type: "extension_ui_response" as const,
      id: request.frame.id,
      cancelled: true as const,
    };
  }
  if (request.frame.options && request.frame.options.length > 0) {
    const selected = answer.optionId ?? request.frame.options[0]!;
    return { type: "extension_ui_response" as const, id: request.frame.id, value: selected };
  }
  // S5-4 依据：此处为 input/editor 无选项形态。omp requestRpcEditor 对响应的
  // pendingRequests resolve 把 "value" 直通采纳为编辑结果；accept 而无文本时回
  // value:"" 会用空串覆盖原值（原文事实性丢失），必须按取消终止本次编辑。
  const freeText = answer.freeText ?? "";
  if (freeText.length === 0) {
    return {
      type: "extension_ui_response" as const,
      id: request.frame.id,
      cancelled: true as const,
    };
  }
  return { type: "extension_ui_response" as const, id: request.frame.id, value: freeText };
}

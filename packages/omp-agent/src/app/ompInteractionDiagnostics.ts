// 交互日志只观察真实结算；Host 错误/服务端 deadline/本地预算/核心取消/销毁不能混成 UI 取消。
import { diagnostics } from "./diagnostics.js";
import type { HostUserInputAnswer, HostUserInputQuestion, OmpUiRequest } from "./ports.js";
import type { OmpBypassFrame } from "../domain/ompForkFrames.js";

function started(
  sessionId: string,
  interactionId: string,
  ompRequestId: string,
  method: string,
): Record<string, unknown> {
  const fields = {
    sessionId,
    interactionId,
    ompRequestId,
    kind: method === "ask" ? "ask" : "ui",
    method,
  };
  diagnostics.info("omp.interaction.started", fields);
  return fields;
}

function presentedUi(
  fields: Record<string, unknown>,
  startedAt: number,
  optionCount: number,
  elicitation: boolean,
): void {
  diagnostics.info("omp.interaction.presented", {
    ...fields,
    elapsedMs: Date.now() - startedAt,
    questionCount: elicitation ? 1 : 0,
    optionCount,
  });
}

function presentedAsk(
  fields: Record<string, unknown>,
  startedAt: number,
  questions: HostUserInputQuestion[],
): void {
  diagnostics.info("omp.interaction.presented", {
    ...fields,
    elapsedMs: Date.now() - startedAt,
    questionCount: questions.length,
    optionCount: questions.reduce((count, question) => count + question.options.length, 0),
  });
}

function final(
  fields: Record<string, unknown>,
  startedAt: number,
  stage: string,
  answer: HostUserInputAnswer,
  result: Record<string, unknown>,
): void {
  const event =
    stage === "server_deadline" || stage === "local_budget"
      ? "omp.interaction.timeout"
      : stage === "session_close" || stage === "process_exit"
        ? "omp.interaction.disposed"
        : result.resultStatus === "cancelled" || answer.action !== "accept"
          ? "omp.interaction.cancelled"
          : "omp.interaction.resolved";
  const details = {
    ...fields,
    stage,
    action: answer.action,
    ...result,
    elapsedMs: Date.now() - startedAt,
  };
  // Host 错误仍沿既有 fail-closed 回执；错误类型/正文无需复制到日志。
  if (stage === "host_error" || stage === "process_exit") diagnostics.error(event, details);
  else if (stage === "local_budget") diagnostics.warn(event, details);
  else diagnostics.info(event, details);
}

function uiResult(
  fields: Record<string, unknown>,
  startedAt: number,
  stage: string,
  answer: HostUserInputAnswer,
  request: OmpUiRequest,
  response: OmpBypassFrame,
): void {
  // 审批只能从实际合法回帧证明，不能把 accept 或缺失选项当成 Approve。
  const options = request.frame.options;
  const approval =
    request.frame.method === "select" &&
    options?.length === 2 &&
    options.includes("Approve") &&
    options.includes("Deny");
  final(fields, startedAt, stage, answer, {
    resultStatus: "cancelled" in response ? "cancelled" : "answered",
    ...(approval && "value" in response
      ? { approved: response.value === "Approve", denied: response.value === "Deny" }
      : {}),
  });
}

function askResult(
  fields: Record<string, unknown>,
  startedAt: number,
  stage: string,
  answer: HostUserInputAnswer,
  response?: OmpBypassFrame,
): void {
  final(fields, startedAt, stage, answer, {
    resultStatus:
      response === undefined
        ? "server_settled"
        : "cancelled" in response
          ? "cancelled"
          : "answered",
    answerCount: response && "answers" in response ? (response.answers?.length ?? 0) : 0,
  });
}

export const interactionDiagnostics = { started, presentedUi, presentedAsk, uiResult, askResult };

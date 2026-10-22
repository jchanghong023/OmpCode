import type { ModelRequest } from "./omp-integration-fixture.js";

type WorkflowResponse = {
  text?: string;
  tool?: { name: string; args: Record<string, unknown> };
  hold?: boolean;
  error?: { status: number; message: string };
};

/** Stateless responses: only the real transcript advances an actor's execution. */
export function respondOmpWorkflowRequest(request: ModelRequest): WorkflowResponse | undefined {
  const transcript = JSON.stringify(request.messages);
  const userInput = request.messages.filter((message) => message.role === "user")
    .map((message) => JSON.stringify(message.content)).join("\n");
  const finished = (name: string) => request.messages.some((message) =>
    message.role === "assistant" && JSON.stringify(message).includes(`"name":"${name}"`));
  const messageText = request.messages.map((message) => typeof message.content === "string"
    ? message.content
    : Array.isArray(message.content)
      ? message.content.map((block: { text?: string }) => block.text ?? "").join("\n")
      : "").join("\n");
  const questionId = messageText.match(/"question_id"\s*:\s*"(dwfq-[^"]+)"/u)?.[1];
  if (questionId && JSON.stringify(request.tools).includes("ResolveWorkflowQuestion")) {
    if (!finished("ResolveWorkflowQuestion")) return { tool: {
      name: "ResolveWorkflowQuestion",
      args: { question_id: questionId, answer: "OMP_E2E_WF_PARENT_ANSWER:cedar-731" },
    } };
    return { text: "OMP_E2E_WF_PARENT_RESOLVED" };
  }
  if (!userInput.includes("OMP_E2E_WF_")) return undefined;
  if (userInput.includes("OMP_E2E_WF_CREATE")) {
    if (!finished("write")) return { tool: { name: "write", args: {
      i: "Creating workflow from GUI instruction",
      path: ".zcode/workflows/omp-native-created.dwf.ts",
      content: "/* zcode-workflow\ndescription: OMP_E2E_WF_CREATED_GUI\n*/\nreturn { created: true };\n",
    } } };
    return { text: "OMP_E2E_WF_CREATED_GUI_DONE" };
  }
  if (userInput.includes("OMP_E2E_WF_FAIL")) return {
    error: { status: 400, message: "OMP_E2E_WF_PROVIDER_FAILURE" },
  };
  if (userInput.includes("OMP_E2E_WF_HOLD")) return {
    text: "OMP_E2E_WF_HOLD_RUNNING", hold: true,
  };
  if (userInput.includes("OMP_E2E_WF_RESUME:")) {
    const attempts = request.messages.filter((message) => message.role === "user" &&
      JSON.stringify(message.content).includes("OMP_E2E_WF_RESUME:")).length;
    return attempts > 1
      ? { text: "OMP_E2E_WF_RESUMED_OUTPUT:cedar-731" }
      : { text: "OMP_E2E_WF_RESUME_WAITING", hold: true };
  }
  if (userInput.includes("OMP_E2E_WF_WRITER:")) {
    if (!finished("write")) return { tool: { name: "write", args: {
      i: "Writing actual workflow actor proof",
      path: "omp-wf-actor-proof.txt", content: "OMP_E2E_WF_ACTOR_SIDE_EFFECT\n",
    } } };
    if (userInput.includes("Required JSON schema:") && !finished("submit_result")) return {
      tool: { name: "submit_result", args: { result: { value: "OMP_E2E_WF_WRITER_OUTPUT:cedar-731" } } },
    };
    return { text: "OMP_E2E_WF_WRITER_OUTPUT:cedar-731" };
  }
  if (userInput.includes("OMP_E2E_WF_REVIEWER")) {
    if (!finished("read")) return { tool: { name: "read", args: {
      i: "Reading actual workflow actor proof",
      path: "omp-wf-actor-proof.txt",
    } } };
    if (!finished("escalate")) return { tool: { name: "escalate", args: {
      question: "OMP_E2E_WF_PARENT_REVIEW?", context: "cedar-731",
    } } };
    if (!transcript.includes("OMP_E2E_WF_PARENT_ANSWER:cedar-731")) throw new Error("Actor did not receive its native parent's answer");
    if (!finished("ask")) return { tool: { name: "ask", args: {
      i: "Asking workflow parent for approval",
      questions: [{ id: "omp-wf-review", question: "OMP_E2E_WF_REVIEW_APPROVE?",
        options: [{ label: "OMP_E2E_WF_APPROVED", description: "Approve the actual actor file" }] }],
    } } };
    if (!transcript.includes("OMP_E2E_WF_APPROVED")) throw new Error("Workflow actor did not receive its parent's answer");
    if (userInput.includes("Required JSON schema:") && !finished("submit_result")) return {
      tool: { name: "submit_result", args: { result: { value: "OMP_E2E_WF_REVIEWER_OUTPUT:approved-cedar-731" } } },
    };
    return { text: "OMP_E2E_WF_REVIEWER_OUTPUT:approved-cedar-731" };
  }
  return { text: "OMP_E2E_WF_PARENT_NOTIFICATION_DONE" };
}

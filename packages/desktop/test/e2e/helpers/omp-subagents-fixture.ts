import type { ModelRequest } from "./omp-integration-fixture.js";

type Reply = {
  text?: string;
  tool?: { name: string; args: Record<string, unknown> };
  hold?: boolean;
  error?: { status: number; message: string };
};

export const SA_AGENT = "omp-e2e-child";
export const SA_SIBLING = "omp-e2e-sibling";
export const SA_PROOF = "omp-e2e-sa-proof.txt";
export const SA_RELEASE = "omp-e2e-sa-message-release.txt";
const SA_SIBLING_RELEASE = "omp-e2e-sa-sibling-release.txt";

function tool(name: string, args: Record<string, unknown>): Reply {
  return { tool: { name, args } };
}
function gate(path: string, marker: string): Reply {
  const program = `const fs=require("node:fs"); console.log("${marker}_RUNNING"); const timer=setInterval(()=>{if(fs.existsSync("${path}")){clearInterval(timer); console.log("${marker}_RELEASED")}},50)`;
  const quote = (value: string) => `'${value.replaceAll("'", "'\\''")}'`;
  return tool("bash", { i: "Waiting at native execution boundary", command: `${quote(process.execPath.replaceAll("\\", "/"))} -e ${quote(program)}`, timeout: 0 });
}
function results(request: ModelRequest): string {
  return request.messages
    .filter((message) => message.role === "tool" || JSON.stringify(message.content).includes('"tool_result"'))
    .map((message) => JSON.stringify(message.content))
    .join("\n");
}
function called(request: ModelRequest, name: string, argument: string): boolean {
  return request.messages.some((message) => message.role === "assistant" &&
    JSON.stringify(message).includes(`\"${name}\"`) && JSON.stringify(message).includes(argument));
}
function assistantCalls(message: ModelRequest["messages"][number]): Array<{ name: unknown; raw: unknown }> {
  if (message.role !== "assistant") return [];
  const calls: Array<{ name: unknown; raw: unknown }> = [];
  const wireCalls = "tool_calls" in message && Array.isArray(message.tool_calls) ? message.tool_calls : [];
  for (const entry of wireCalls) {
    if (typeof entry !== "object" || entry === null || !("function" in entry)) continue;
    const fn = entry.function;
    if (typeof fn !== "object" || fn === null) continue;
    calls.push({ name: "name" in fn ? fn.name : undefined, raw: "arguments" in fn ? fn.arguments : undefined });
  }
  if (Array.isArray(message.content)) {
    for (const part of message.content) {
      if (typeof part !== "object" || part === null || !("type" in part) || part.type !== "toolCall") continue;
      calls.push({ name: "name" in part ? part.name : undefined, raw: "arguments" in part ? part.arguments : undefined });
    }
  }
  return calls;
}
/**
 * A real write call already issued for this exact target, and payload when
 * given. Arguments are parsed from the wire shape: comparing serialized JSON
 * never matches because the request escapes the nested argument quotes.
 */
function wrote(request: ModelRequest, path: string, content?: string): boolean {
  return request.messages.some((message) =>
    assistantCalls(message).some((call) => {
      if (call.name !== "write") return false;
      try {
        const args: unknown = typeof call.raw === "string" ? JSON.parse(call.raw) : call.raw;
        if (typeof args !== "object" || args === null) return false;
        const target = "path" in args ? args.path : undefined;
        const body = "content" in args ? args.content : undefined;
        return target === path && (content === undefined || body === content);
      } catch {
        return false;
      }
    }));
}
function spawn(request: ModelRequest, marker: string, name: string, agent = "task"): Reply {
  const item = { name, agent, task: marker, solutionSpace: "Fixed isolated native GUI acceptance task" };
  // Both shapes are production schemas. Select the advertised native shape,
  // rather than issuing a legacy Agent call or repairing a rejected tool call.
  const declaration = request.tools?.find((entry) => JSON.stringify(entry).includes('"task"'));
  const batch = JSON.stringify(declaration).includes('"tasks"');
  return tool("task", batch ? { context: "OMP native GUI acceptance", tasks: [item] } : item);
}

/** Stateless localhost model replies; every transition follows real request history. */
export function respondOmpSubagentRequest(request: ModelRequest): Reply | undefined {
  const users = request.messages.filter((message) => message.role === "user");
  const initial = users.map((message) => JSON.stringify(message.content))
    .find((value) => /OMP_E2E_SA_(?:PARENT|CHILD|OTHER)/u.test(value));
  if (!initial) return undefined;
  const control = [...users].reverse().map((message) => JSON.stringify(message.content))
    .find((value) => /OMP_E2E_SA_(?:MESSAGE|CANCEL|RESUME|MISSING|RELEASE_SIBLING)(?![A-Z_])/u.test(value));
  const input = initial.includes("OMP_E2E_SA_CHILD_") ? initial : (control ?? initial);
  const result = results(request);
  const recent = JSON.stringify(request.messages.at(-1));
  // Background completion/async-result turns quote an old marker in their
  // history. They must settle with terminal text, never re-issue the control
  // write, or every completion spawns another turn.
  const latestText = JSON.stringify(request.messages.at(-1)?.content ?? "");
  const completionContinuation = request.messages.at(-1)?.role === "user" &&
    (latestText.includes("<system-notice>") || latestText.includes("<task-result")) &&
    !/OMP_E2E_SA_(?:MESSAGE|CANCEL|RESUME|MISSING|RELEASE_SIBLING)(?![A-Z_])/u.test(latestText);
  if (input.includes("OMP_E2E_SA_OTHER_MESSAGE_RELEASE") && !called(request, "write", SA_RELEASE)) {
    return tool("write", { i: "Releasing isolated native message gate", path: SA_RELEASE, content: "OMP_E2E_SA_RELEASED" });
  }
  if (input.includes("OMP_E2E_SA_OTHER")) return { text: "OMP_E2E_SA_OTHER_DONE" };
  if (!initial.includes("OMP_E2E_SA_CHILD_") && recent.includes("OMP_E2E_SA_CHILD_RECEIPT") && request.messages.at(-1)?.role !== "assistant") {
    return { text: `OMP_E2E_SA_MESSAGE_RECEIPT OMP_E2E_SA_PARENT_CONSUMED_RECEIPT ${recent}` };
  }
  if (input.includes("OMP_E2E_SA_CHILD_ERROR")) {
    return { error: { status: 400, message: "OMP_E2E_SA_RATE_LIMIT: deterministic isolated child failure" } };
  }
  if (input.includes("OMP_E2E_SA_CHILD_HOLD")) {
    const followups = JSON.stringify(users);
    if (followups.includes("OMP_E2E_SA_RESUME_PAYLOAD")) return { text: "OMP_E2E_SA_RESUMED_WITH_CONTEXT" };
    if (followups.includes("OMP_E2E_SA_MESSAGE_PAYLOAD")) {
      // Parent steering can background the real Bash process. Wait on that
      // owned native job rather than replying before its release-file boundary.
      if (input.includes("OMP_E2E_SA_CHILD_HOLD_MESSAGE") && !result.includes("OMP_E2E_SA_GATE_RELEASED") && !followups.includes("OMP_E2E_SA_GATE_RELEASED")) {
        return tool("wait", {});
      }
      if (!called(request, "write", "OMP_E2E_SA_CHILD_RECEIPT")) {
        return tool("write", { i: "Replying to parent", path: "agent://Main", content: "OMP_E2E_SA_CHILD_RECEIPT" });
      }
      return { text: "OMP_E2E_SA_CHILD_MESSAGE_DONE" };
    }
    if (!called(request, "write", "omp-e2e-sa-hold.txt")) {
      return tool("write", { i: "Recording child checkpoint", path: "omp-e2e-sa-hold.txt", content: "OMP_E2E_SA_CHECKPOINT" });
    }
    if (input.includes("OMP_E2E_SA_CHILD_HOLD_MESSAGE")) {
      if (!called(request, "bash", SA_RELEASE)) return gate(SA_RELEASE, "OMP_E2E_SA_GATE");
      throw new Error("Native message gate finished without the targeted message");
    }
    return { text: "OMP_E2E_SA_CHILD_HOLD_RUNNING", hold: true };
  }
  if (input.includes("OMP_E2E_SA_CHILD_TOOL_ERROR")) {
    const missing = "omp-e2e-sa-intentionally-missing.txt";
    if (!called(request, "read", missing)) return tool("read", { i: "Exercising native tool failure", path: missing });
    return { text: `OMP_E2E_SA_TOOL_FAILURE_RECORDED ${result}` };
  }
  if (input.includes("OMP_E2E_SA_CHILD_SIBLING_HOLD")) {
    if (!called(request, "bash", SA_SIBLING_RELEASE)) return gate(SA_SIBLING_RELEASE, "OMP_E2E_SA_SIBLING");
    return { text: "OMP_E2E_SA_SIBLING_DONE" };
  }
  if (input.includes("OMP_E2E_SA_CHILD_SIBLING")) return { text: "OMP_E2E_SA_SIBLING_DONE" };
  if (input.includes("OMP_E2E_SA_CHILD_BASIC") || input.includes("OMP_E2E_SA_CHILD_CONFIG")) {
    if (!called(request, "write", SA_PROOF)) return tool("write", {
      i: "Writing native child proof", path: SA_PROOF, content: "OMP_E2E_SA_NATIVE_CHILD_FILE",
    });
    if (!called(request, "read", SA_PROOF)) return tool("read", { i: "Reading native child proof", path: SA_PROOF });
    if (input.includes("OMP_E2E_SA_CHILD_CONFIG")) return { text: "OMP_E2E_SA_CHILD_DONE" };
    if (!called(request, "ask", "OMP_E2E_SA_QUESTION")) return tool("ask", {
      i: "Asking child question", questions: [{ id: "sa-native", question: "OMP_E2E_SA_QUESTION", options: [{ label: "OMP_E2E_SA_ANSWER" }] }],
    });
    if (!result.includes("OMP_E2E_SA_ANSWER")) throw new Error("Child resumed without its real answer");
    return { text: "OMP_E2E_SA_CHILD_DONE" };
  }
  for (const [marker, path, content] of [
    ["OMP_E2E_SA_MESSAGE", "agent://SaHold", "OMP_E2E_SA_MESSAGE_PAYLOAD"],
    ["OMP_E2E_SA_CANCEL", "proc://SaHold/kill", undefined],
    ["OMP_E2E_SA_RESUME", "agent://SaHold", "OMP_E2E_SA_RESUME_PAYLOAD"],
    ["OMP_E2E_SA_MISSING", "agent://OmpMissingChild", "OMP_E2E_SA_MISSING_PAYLOAD"],
    ["OMP_E2E_SA_RELEASE_SIBLING", SA_SIBLING_RELEASE, "OMP_E2E_SA_SIBLING_RELEASE_PAYLOAD"],
  ] as const) {
    if (input.includes(marker)) {
      if (completionContinuation) return { text: `${marker}_RECEIPT ${latestText}` };
      if (!wrote(request, path, content)) {
        return tool("write", { i: "Controlling native child", path, ...(content ? { content } : {}) });
      }
      return { text: `${marker}_RECEIPT ${recent}` };
    }
  }
  if (input.includes("OMP_E2E_SA_PARENT")) {
    if (input.includes("CONFIG") && !called(request, "task", "SaConfigured")) return spawn(request, "OMP_E2E_SA_CHILD_CONFIG", "SaConfigured", SA_AGENT);
    if (input.includes("HOLD") && !called(request, "task", "SaHold")) return spawn(request, input.includes("HOLD_MESSAGE") ? "OMP_E2E_SA_CHILD_HOLD_MESSAGE" : "OMP_E2E_SA_CHILD_HOLD", "SaHold");
    if (input.includes("WITH_SIBLING") && !called(request, "task", "SaSiblingHold")) return spawn(request, "OMP_E2E_SA_CHILD_SIBLING_HOLD", "SaSiblingHold");
    if (input.includes("CONFIG_SIBLING") && !called(request, "task", "SaSibling")) return spawn(request, "OMP_E2E_SA_CHILD_SIBLING", "SaSibling", SA_SIBLING);
    if (input.includes("TOOL_ERROR") && !called(request, "task", "SaToolError")) return spawn(request, "OMP_E2E_SA_CHILD_TOOL_ERROR", "SaToolError");
    if (input.includes("ERROR") && !input.includes("TOOL_ERROR") && !called(request, "task", "SaError")) return spawn(request, "OMP_E2E_SA_CHILD_ERROR", "SaError");
    if (input.includes("BASIC") && !called(request, "task", "SaBasic")) return spawn(request, "OMP_E2E_SA_CHILD_BASIC", "SaBasic");
    const consumed = JSON.stringify(request.messages.filter((message) => message.role !== "assistant"));
    if (consumed.includes("OMP_E2E_SA_CHILD_DONE")) return { text: "OMP_E2E_SA_PARENT_DONE" };
    if (consumed.includes("OMP_E2E_SA_CHILD_RECEIPT")) return { text: "OMP_E2E_SA_PARENT_CONSUMED_RECEIPT" };
    if (consumed.includes("OMP_E2E_SA_SIBLING_DONE")) return { text: "OMP_E2E_SA_PARENT_SIBLING_DONE" };
    if (consumed.includes("OMP_E2E_SA_RATE_LIMIT")) return { text: `OMP_E2E_SA_PARENT_FAILED ${recent}` };
    return { text: "OMP_E2E_SA_PARENT_LAUNCHED" };
  }
  return undefined;
}

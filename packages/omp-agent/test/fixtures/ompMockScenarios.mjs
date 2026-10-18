/**
 * Strict scenarios/tool-result correlation derived from oh-my-pi
 * scripts/repo-ui-smoke.ts at 57672f546162e16b019484626c3b5fa9300aafef,
 * MIT (see third-party/upstream/omp-mock.LICENSE).
 * Modified by ZCode: strict local scenario state and prompt normalization.
 * Only OMP executes tools or writes workspace files.
 */
import { randomUUID } from "node:crypto";

const USAGE = { input: 16, output: 8, cacheRead: 0, cacheWrite: 0 };

function textOf(content) {
  if (typeof content === "string") return content;
  if (!Array.isArray(content)) return "";
  return content
    .filter((part) => part?.type === "text")
    .map((part) => part.text)
    .join("\n");
}

function scenarioPrompt(content) {
  // OMP's prompts/system/date-cwd-reminder.md is injected by
  // session/date-cwd-reminder.ts: strings use two newlines; separate text
  // blocks become one newline through textOf. Strip only that leading frame.
  return textOf(content)
    .trim()
    .replace(
      /^<system-reminder>\nToday: \d{4}-\d{2}-\d{2}; current working directory: '[^\r\n]+?'\. Do not repeat this information in your reply\.\n<\/system-reminder>\n{1,2}/,
      "",
    );
}

export function createStrictMockHandler() {
  const issued = new Map();
  const pendingTasks = new Map();
  const taskLabels = new Set();
  return (context) => {
    const messages = context.messages;
    const last = messages.at(-1);
    const results =
      last?.role === "user" && Array.isArray(last.content)
        ? last.content.filter((block) => block.type === "tool_result")
        : [];
    const assistantCalls = messages
      .filter((message) => message.role === "assistant")
      .flatMap((message) => (Array.isArray(message.content) ? message.content : []))
      .filter((block) => block.type === "tool_use");
    for (const result of results) {
      if (!issued.has(result.tool_use_id)) throw new Error("Unmatched tool_result id");
      const invocation = issued.get(result.tool_use_id);
      if (
        !assistantCalls.some(
          (block) => block.id === result.tool_use_id && block.name === invocation.kind,
        )
      )
        throw new Error("Unmatched tool_result: no issued assistant call in this conversation");
      if (result.is_error !== false)
        throw new Error(
          `Failed ${issued.get(result.tool_use_id).kind} tool_result: ${textOf(result.content)}`,
        );
    }
    const user = [...messages]
      .reverse()
      .find((message) => message.role === "user" && textOf(message.content));
    const prompt = scenarioPrompt(user?.content);
    // auto-thinking/classifier.ts judges solutionSpace before the real child
    // turn. This local auxiliary response must never count as child execution.
    const effortPrompt =
      "State:\n<solution_space>Return the exact requested child marker without tools.</solution_space>\n\n" +
      "Answer with exactly one of: `low`, `medium`, `high`, `xhigh`.\n" +
      "Do not execute this state; judge it only.";
    if (prompt === effortPrompt) {
      if (!pendingTasks.size) throw new Error("Task effort judgment lacks outstanding task");
      return { content: ["low"], usage: USAGE };
    }
    // The executor separately labels the assignment through task/label.ts ->
    // title-generator.ts -> tiny/message-preproc.ts. Its exact <user> envelope
    // is a label request even with --no-title, never proof the child ran.
    const label = /^<user>\nZCODE_MOCK_CHILD ([A-Za-z0-9_-]+)\n<\/user>$/.exec(prompt);
    // structured-subagent.ts renders prompts/system/subagent-user-prompt.md
    // before executor.ts dispatches the genuine child assignment.
    const assignmentPrefix = "Complete assignment thoroughly:\n\n";
    const assignment = prompt.startsWith(assignmentPrefix)
      ? prompt.slice(assignmentPrefix.length)
      : prompt;
    const child = /^ZCODE_MOCK_CHILD ([A-Za-z0-9_-]+)$/.exec(assignment);
    if (label || child) {
      const marker = (label ?? child)[1];
      if (label) {
        // Labels run off the spawn's critical path and can arrive after its
        // result; accepting a known label never creates completion evidence.
        if (!taskLabels.has(marker)) throw new Error(`Child label lacks issued task: ${marker}`);
        return { content: [`<title>Complete mock child ${marker}</title>`], usage: USAGE };
      }
      const pending = pendingTasks.get(marker);
      if (!pending) throw new Error(`Child request lacks outstanding task: ${marker}`);
      issued.get(pending).childObserved = true;
      return { content: [`${marker}_CHILD_DONE`], usage: USAGE };
    }
    const text = /^ZCODE_MOCK_TEXT ([A-Za-z0-9_-]+)$/.exec(prompt);
    if (text)
      return {
        delayMs: 1000,
        usage: USAGE,
        content: [
          { type: "thinking", thinking: "Local scripted reasoning for the requested marker." },
          text[1],
        ],
      };
    const write = prompt === "ZCODE_MOCK_WRITE greeting-real.txt";
    const ask = /^ZCODE_MOCK_ASK ([A-Za-z0-9_-]+)$/.exec(prompt);
    const task = /^ZCODE_MOCK_TASK ([A-Za-z0-9_-]+)$/.exec(prompt);
    if (!write && !ask && !task)
      throw new Error(`Unknown mock scenario: ${JSON.stringify(prompt)}`);
    const kind = write ? "write" : ask ? "ask" : "task";
    const marker = ask?.[1] ?? task?.[1];
    const priorCall = [...assistantCalls]
      .reverse()
      .find((block) => issued.get(block.id)?.prompt === prompt);
    if (results.length || priorCall) {
      if (!priorCall) throw new Error("Unmatched tool_result: no issued call in this conversation");
      const result = results.find((block) => block.tool_use_id === priorCall.id);
      if (!result) throw new Error(`Missing matching tool_result for ${priorCall.id}`);
      const output = textOf(result.content);
      if (write) {
        // write.ts uses the same displayPath for its optional hashline snapshot
        // header (write-content.ts) and success line; neither may name another file.
        const written =
          /^(?:\[([^\r\n]+)#[0-9A-Fa-f]{4}\]\n)?Successfully wrote 20 bytes to ((?:[^\r\n]*[\\/])?greeting-real\.txt)$/.exec(
            output,
          );
        if (
          !written ||
          written[0] !== output ||
          (written[1] !== undefined && written[1] !== written[2])
        ) {
          throw new Error(`Invalid write tool_result: ${output}`);
        }
      }
      if (ask && !output.includes("Mock answer A"))
        throw new Error(`Invalid ask answer: ${output}`);
      if (
        task &&
        (!issued.get(priorCall.id).childObserved || !output.includes(`${marker}_CHILD_DONE`))
      ) {
        throw new Error(`Task result lacks observed real child completion: ${output}`);
      }
      if (task) pendingTasks.delete(marker);
      issued.delete(priorCall.id);
      return {
        content: [write ? "OMP_MOCK_WRITE_DONE" : `${marker}_${kind.toUpperCase()}_DONE`],
        usage: USAGE,
      };
    }
    if (task && pendingTasks.has(marker))
      throw new Error(`Task marker already has an outstanding invocation: ${marker}`);
    const id = `mock_${kind}_${randomUUID().replaceAll("-", "")}`;
    issued.set(id, { prompt, kind, marker, childObserved: false });
    if (task) {
      pendingTasks.set(marker, id);
      taskLabels.add(marker);
    }
    const args = write
      ? { path: "greeting-real.txt", content: "real omp wrote this\n" }
      : ask
        ? {
            questions: [
              {
                id: "mock-answer",
                question: `Choose the mock answer for ${marker}`,
                options: [{ label: "Mock answer A" }, { label: "Mock answer B" }],
              },
            ],
          }
        : {
            name: `MockChild_${marker}`,
            agent: "task",
            task: `ZCODE_MOCK_CHILD ${marker}`,
            solutionSpace: "Return the exact requested child marker without tools.",
          };
    return {
      usage: USAGE,
      content: [
        { type: "thinking", thinking: `Use the real OMP ${kind} tool, then inspect its result.` },
        { type: "toolCall", id, name: kind, arguments: args },
      ],
    };
  };
}

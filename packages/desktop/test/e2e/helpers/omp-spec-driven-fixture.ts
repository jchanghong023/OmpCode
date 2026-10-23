import type { ModelRequest } from "./omp-integration-fixture.js";

export const SPEC_FIXTURE_MARKER = "OMP_E2E_SPEC_GREETING";
export const SPEC_CHANGE_ID = "omp-greeting";
export const SPEC_IMPLEMENTATION_PATH = "src/greeting.ts";
export const SPEC_TEST_PATH = "test/greeting.test.ts";
export const SPEC_VALIDATION_ID = "greeting-behavior";
export const SPEC_VALIDATION_COMMAND = "bun test test/greeting.test.ts";
export const SPEC_IMPLEMENTATION =
  'export function greet(name: string): string {\n  return `Hello, ${name.trim() || "world"}!`;\n}\n';
export const SPEC_TEST = [
  'import { expect, test } from "bun:test";',
  'import { existsSync } from "node:fs";',
  "// Module-loading boundary test: static import cannot exercise RED before production exists.",
  'const implementation = new URL("../src/greeting.ts", import.meta.url);',
  "const greet = existsSync(implementation) ? (await import(implementation.href)).greet : undefined;",
  'test("greeting normalizes outer whitespace", () => { expect(greet?.("  Ada  ")).toBe("Hello, Ada!"); });',
  'test("empty and whitespace names use world", () => { expect(greet?.("")).toBe("Hello, world!"); expect(greet?.("  ")).toBe("Hello, world!"); });',
  'test("internal whitespace is preserved", () => { expect(greet?.(" Ada  Lovelace ")).toBe("Hello, Ada  Lovelace!"); });',
  "",
].join("\n");

interface Reply {
  text?: string;
  tool?: { name: string; args: Record<string, unknown> };
  error?: { status: number; message: string };
}
interface NativeFunction {
  name: string;
  parameters?: unknown;
}
function functions(request: ModelRequest): NativeFunction[] {
  return (request.tools ?? []).flatMap((tool) => {
    if (!tool || typeof tool !== "object" || !("function" in tool)) return [];
    const fn = tool.function;
    return fn && typeof fn === "object" && "name" in fn && typeof fn.name === "string"
      ? [fn as NativeFunction]
      : [];
  });
}
function text(content: unknown): string {
  if (typeof content === "string") return content;
  if (Array.isArray(content))
    return content
      .map((part: unknown) =>
        part && typeof part === "object" && "text" in part && typeof part.text === "string"
          ? part.text
          : "",
      )
      .join("\n");
  return "";
}
/** Read the adapter's JSON payload, not phrases from its model instructions. */
function rolePayload(
  request: ModelRequest,
): { specDrivenRole: string; input: Record<string, unknown> } | undefined {
  for (const message of request.messages.filter((item) => item.role === "user")) {
    const source = text(message.content);
    for (let start = source.indexOf("{"); start >= 0; start = source.indexOf("{", start + 1)) {
      let depth = 0;
      let quoted = false;
      let escaped = false;
      for (let end = start; end < source.length; end++) {
        const char = source[end];
        if (quoted) {
          if (escaped) escaped = false;
          else if (char === "\\") escaped = true;
          else if (char === '"') quoted = false;
          continue;
        }
        if (char === '"') quoted = true;
        else if (char === "{") depth++;
        else if (char === "}" && --depth === 0) {
          try {
            const value = JSON.parse(source.slice(start, end + 1)) as {
              specDrivenRole?: unknown;
              input?: unknown;
            };
            if (
              typeof value.specDrivenRole === "string" &&
              value.input &&
              typeof value.input === "object"
            )
              return value as { specDrivenRole: string; input: Record<string, unknown> };
          } catch {
            /* Not an adapter payload. */
          }
          break;
        }
      }
    }
  }
  return undefined;
}
function toolReply(request: ModelRequest, name: string, args: Record<string, unknown>): Reply {
  const advertised = functions(request).find((fn) => fn.name === name || fn.name === `_${name}`);
  if (!advertised) throw new Error(`Spec fixture requires advertised native ${name}`);
  return { tool: { name: advertised.name, args } };
}
const yieldReply = (request: ModelRequest, data: Record<string, unknown>) =>
  toolReply(request, "yield", { data });
const requirement =
  "The greeting function SHALL trim outer whitespace from name, default empty names to world, preserve internal whitespace and return Hello, <name>!.";

/** Only provider responses. OMP owns scheduling, files, reviews, execution evidence and Git. */
export function respondOmpSpecDrivenRequest(request: ModelRequest): Reply | undefined {
  const transcript = JSON.stringify(request.messages);
  if (!transcript.includes(SPEC_FIXTURE_MARKER)) return undefined;
  // Auxiliary title/summary calls have no native tool boundary to execute.
  if (!functions(request).length) return { text: `${SPEC_FIXTURE_MARKER}_CHAT_READY` };
  const payload = rolePayload(request);
  const schema = JSON.stringify(
    functions(request).find((fn) => fn.name === "yield")?.parameters ?? {},
  );
  // Original native Team schemas, not a fixture-specific alternative orchestration.
  if (schema.includes('"noViableProposal"'))
    return yieldReply(request, {
      proposal: `${SPEC_FIXTURE_MARKER}: implement one pure greet(name) export; Bun behavior tests cover trim, blank fallback and preserved internal spaces. Run RED before creating src/greeting.ts, GREEN afterwards.`,
      noViableProposal: false,
      investigationBlockedReason: "",
      keyAssumptions: [],
      risks: [],
      unknowns: [],
      acceptanceCriteria: [requirement],
      ambiguityInterpretations: [],
      evidence: [],
    });
  if (schema.includes('"unifiedUnderstanding"'))
    return yieldReply(request, {
      unifiedUnderstanding: requirement,
      acceptanceCriteria: [requirement],
      factDifferences: [],
      interpretationDifferences: [],
    });
  if (schema.includes('"noSubstantiveIssues"'))
    return yieldReply(request, {
      noSubstantiveIssues: true,
      reviewSummary:
        "The pure function, declared owned paths and real Bun validation satisfy the approved behavior without shared state.",
      findings: [],
      blockingResolutions: [],
    });
  if (schema.includes('"reportMarkdown"'))
    return yieldReply(request, {
      reportMarkdown:
        "## A\nPure greeting function with RED/GREEN Bun tests.\n## B\nEquivalent pure normalization with the same behavior tests.\nBoth candidates preserve internal whitespace; no execution preconditions remain.",
      recommendedProposal: "A",
      recommendationReason: "Small pure implementation and independently verifiable behavior.",
      recommendationPreconditions: "",
      hardConstraintViolations: [],
    });
  if (!payload) return { text: `${SPEC_FIXTURE_MARKER}_CHAT_READY` };
  if (JSON.stringify(payload.input).includes("OMP_E2E_SPEC_FORCE_FAILURE"))
    return { error: { status: 400, message: "OMP_E2E_SPEC_EXPECTED_PROVIDER_FAILURE" } };
  if (payload.specDrivenRole === "requirements")
    return yieldReply(request, {
      proposal: `# ${SPEC_FIXTURE_MARKER}\n\n## Why\nProvide a deterministic greeting.\n\n## What Changes\nAdd greet(name) and real Bun behavior tests.\n\n## Capabilities\n### New Capabilities\n- greeting: normalized greeting\n\n## Impact\nOnly src/greeting.ts and test/greeting.test.ts.\n`,
      specs: [
        {
          path: "specs/greeting/spec.md",
          content: `## ADDED Requirements\n\n### Requirement: Normalized greeting\n${requirement}\n\n#### Scenario: Outer whitespace\n- **WHEN** greet(\"  Ada  \") is called\n- **THEN** return \"Hello, Ada!\"\n\n#### Scenario: Blank name\n- **WHEN** greet(\"  \") is called\n- **THEN** return \"Hello, world!\"\n\n#### Scenario: Internal whitespace\n- **WHEN** greet(\" Ada  Lovelace \") is called\n- **THEN** return \"Hello, Ada  Lovelace!\"\n`,
        },
      ],
      requirements: [{ id: "R001", text: requirement }],
      questions: [],
    });
  if (payload.specDrivenRole === "planner")
    return yieldReply(request, {
      content: `# ${SPEC_FIXTURE_MARKER} implementation plan\n\nT001: create ${SPEC_TEST_PATH}; run ${SPEC_VALIDATION_COMMAND} RED; create ${SPEC_IMPLEMENTATION_PATH}; rerun GREEN; native OMP commits only these new task-owned files and independently reviews the range. Final validation uses the real Bun entry.\n`,
      tasks: [
        {
          id: "T001",
          title: "Implement normalized greeting with behavioral TDD",
          instructions: `${SPEC_FIXTURE_MARKER}: write the real Bun tests, invoke greeting-behavior RED before production writes, implement greet, then invoke GREEN.`,
          requirementIds: ["R001"],
          dependencies: [],
          conditionIds: [],
          ownedPaths: [SPEC_IMPLEMENTATION_PATH, SPEC_TEST_PATH],
          implementationPaths: [SPEC_IMPLEMENTATION_PATH],
          solutionBinding: "pure-greeting-v1",
          validation: [
            { id: SPEC_VALIDATION_ID, command: SPEC_VALIDATION_COMMAND, behavior: requirement },
          ],
          tdd: { mode: "required", behavior: requirement },
        },
      ],
      conditions: [],
      finalValidation: [
        {
          id: "real-bun-entry",
          command: SPEC_VALIDATION_COMMAND,
          behavior: requirement,
          realEntry: true,
        },
      ],
      closure: { sync: true, archive: true },
    });
  if (payload.specDrivenRole === "reviewer") {
    const records: Array<{
      id: string;
      result?: { exitCode?: number; stdout?: string; stderr?: string };
    }> = Array.isArray(payload.input.records) ? payload.input.records : [];
    if (payload.input.kind === "task" || payload.input.kind === "overall") {
      const toolResults = request.messages
        .filter((message) => message.role === "tool")
        .map((message) => text(message.content))
        .join("\n");
      if (!toolResults.includes("export function greet"))
        return toolReply(request, "read", {
          i: "Reviewing actual production behavior",
          path: SPEC_IMPLEMENTATION_PATH,
        });
      if (!toolResults.includes("internal whitespace is preserved"))
        return toolReply(request, "read", {
          i: "Reviewing actual behavioral assertions",
          path: SPEC_TEST_PATH,
        });
      if (!records.length)
        throw new Error("Independent review requires real runner-owned validation evidence");
    }
    const evidenceChecks = records.map((record) => {
      const output = `${record.result?.stdout ?? ""}\n${record.result?.stderr ?? ""}`;
      const green = record.result?.exitCode === 0 && output.includes("3 pass");
      const red =
        record.result?.exitCode !== 0 &&
        output.includes("Hello, Ada!") &&
        /3 fail|Expected:|expect\(received\)/u.test(output);
      if (!green && !red)
        throw new Error(
          `Spec review rejected unrelated or missing validation output: ${record.id}`,
        );
      return {
        recordId: record.id,
        behavior: requirement,
        valid: true,
        reason: green
          ? "Actual Bun assertions pass all normalization cases."
          : "Actual RED assertions compare missing greeting behavior with the required greetings, before production creation.",
      };
    });
    return yieldReply(request, {
      verdict: "pass",
      summary:
        "Independent review: normalization scenarios, owned-path isolation and real command outputs satisfy the approved specification.",
      findings: [],
      resolutions: [],
      questions: [],
      evidenceChecks,
    });
  }
  if (payload.specDrivenRole === "executor") {
    const calls = request.messages.flatMap((message) =>
      message.role === "assistant" && "tool_calls" in message && Array.isArray(message.tool_calls)
        ? message.tool_calls
        : [],
    );
    const executed = calls.flatMap((call: unknown) => {
      if (!call || typeof call !== "object" || !("function" in call)) return [];
      const fn = call.function;
      if (
        !fn ||
        typeof fn !== "object" ||
        !("name" in fn) ||
        !("arguments" in fn) ||
        typeof fn.arguments !== "string"
      )
        return [];
      return [
        {
          name: String(fn.name).replace(/^_/u, ""),
          args: JSON.parse(fn.arguments) as Record<string, unknown>,
        },
      ];
    });
    if (!executed.some((call) => call.name === "write" && call.args.path === SPEC_TEST_PATH))
      return toolReply(request, "write", {
        i: "Writing real greeting behavior tests",
        path: SPEC_TEST_PATH,
        content: SPEC_TEST,
      });
    if (!executed.some((call) => call.name === "spec_verify" && call.args.stage === "red"))
      return toolReply(request, "spec_verify", { validationId: SPEC_VALIDATION_ID, stage: "red" });
    if (
      !executed.some((call) => call.name === "write" && call.args.path === SPEC_IMPLEMENTATION_PATH)
    )
      return toolReply(request, "write", {
        i: "Implementing approved normalized greeting",
        path: SPEC_IMPLEMENTATION_PATH,
        content: SPEC_IMPLEMENTATION,
      });
    if (!executed.some((call) => call.name === "spec_verify" && call.args.stage === "green"))
      return toolReply(request, "spec_verify", {
        validationId: SPEC_VALIDATION_ID,
        stage: "green",
      });
    return yieldReply(request, {
      summary:
        "Implemented pure greeting; real RED and GREEN commands executed through spec_verify.",
      requestedTddException: "",
    });
  }
  throw new Error(`Unknown native spec role: ${payload.specDrivenRole}`);
}

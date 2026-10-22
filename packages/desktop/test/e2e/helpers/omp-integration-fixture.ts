import { createServer, type ServerResponse } from "node:http";
import { mkdir, readFile, writeFile } from "node:fs/promises";
import { resolve } from "node:path";
import type { AddressInfo } from "node:net";
import { parseArgs } from "node:util";
import { parseDocument, type Document } from "yaml";
import {
  seedPersonalProviderConfig,
  seedPersonalDefaultModelSelection,
} from "./model-provider-restart-config.js";
import { respondOmpSubagentRequest } from "./omp-subagents-fixture.js";
import { respondOmpWorkflowRequest } from "./omp-workflows-fixture.js";

// Explicit selection keeps the original Agent's default formal suite unchanged.
export const OMP_INTEGRATION_SPEC = "omp-app-server.e2e.ts";
export const OMP_CORE_INTEGRATION_SPECS = ["omp-subagents.e2e.ts", "omp-workflows.e2e.ts"];
export const OMP_PROVIDER_ID = "omp-e2e";
export const OMP_MODEL_ID = "omp-chat";

export const OMP_COMPACT_ARCHIVE_MARKER = "OMP_E2E_COMPACT_ARCHIVE_BEGIN";
export const OMP_COMPACT_SUMMARY = [
  "## Goal",
  "Continue the isolated native GUI compaction conversation.",
  "## Progress",
  "### Done",
  "- Recorded the archive: the agreed checkpoint is cedar-731.",
  "## Critical Context",
  "OMP_E2E_COMPACT_SUMMARY_COMMITTED: preserve checkpoint cedar-731 and the recent completed turn.",
].join("\n");

// A bounded ~26k-token reply exceeds native keepRecentTokens=20k, but stays
// below the fixture's 128k context. A separate small turn supplies the kept tail.
const compactArchive = `${OMP_COMPACT_ARCHIVE_MARKER}\nCheckpoint: cedar-731.\n${" context".repeat(26000)}\nOMP_E2E_COMPACT_SEED_DONE`;

export interface ModelRequest {
  model: string;
  messages: Array<{ role: string; content?: unknown }>;
  tools?: unknown[];
}

export function isOmpCompactionSummaryRequest(request: ModelRequest): boolean {
  const system = request.messages
    .filter((message) => message.role === "system" || message.role === "developer")
    .map((message) => JSON.stringify(message.content ?? ""))
    .join("\n");
  const last = request.messages.at(-1);
  const instruction = JSON.stringify(last?.content ?? "");
  // Native structured-summary semantics, not absence of tools (title requests
  // also omit tools). Conversation data alone cannot select this response.
  return (
    system.includes("Summarize user") &&
    system.includes("structured format") &&
    last?.role === "user" &&
    instruction.includes("<conversation>") &&
    instruction.includes("</conversation>") &&
    instruction.includes("structured handoff summary")
  );
}

async function updateFixtureConfig(agentDir: string, update: (document: Document) => void) {
  const path = resolve(agentDir, "config.yml");
  const source = await readFile(path, "utf8").catch((error: NodeJS.ErrnoException) => {
    if (error.code !== "ENOENT") throw error;
    return "";
  });
  const document = parseDocument(source);
  if (document.errors.length) throw new Error("Invalid isolated OMP fixture configuration");
  update(document);
  await writeFile(path, document.toString());
}
export async function prepareOmpIntegrationFixture(options: {
  specs: string[];
  homeDir: string;
  environment: NodeJS.ProcessEnv;
  modelSelection: { providerId: string; modelId: string };
}): Promise<(() => Promise<void>) | undefined> {
  const dedicatedFixture = options.specs.some(
    (spec) =>
      spec.endsWith(OMP_INTEGRATION_SPEC) ||
      OMP_CORE_INTEGRATION_SPECS.some((coreSpec) => spec.endsWith(coreSpec)),
  );
  if (!options.environment.ZCODE_AGENT_SERVER_COMMAND?.trim()) {
    if (!dedicatedFixture) return undefined;
    throw new Error("OMP integration requires an explicit actual OMP source CLI/executable");
  }
  const configRoot = resolve(options.homeDir, "omp-config");
  const rawArgs = options.environment.ZCODE_AGENT_SERVER_ARGS_JSON?.trim();
  const args: unknown = rawArgs ? JSON.parse(rawArgs) : [];
  if (!Array.isArray(args) || args.some((arg) => typeof arg !== "string")) {
    throw new Error("ZCODE_AGENT_SERVER_ARGS_JSON must be a JSON string array");
  }
  // 与启动参数一致：最后一个显式 profile 优先，且不把 cwd/surface 的值当作选项。
  const { values } = parseArgs({
    args,
    allowPositionals: true,
    strict: false,
    options: {
      profile: { type: "string", short: "P", multiple: true },
      cwd: { type: "string" },
      surface: { type: "string" },
    },
  });
  const selectedProfile =
    values.profile?.at(-1) ?? options.environment.OMP_PROFILE ?? options.environment.PI_PROFILE;
  if (selectedProfile !== undefined && typeof selectedProfile !== "string") {
    throw new Error("Invalid isolated OMP fixture profile");
  }
  const normalizedProfile = selectedProfile?.trim();
  const profile = normalizedProfile === "default" ? "" : (normalizedProfile ?? "");
  if (
    profile &&
    (!/^[a-z0-9][a-z0-9._-]{0,63}$/.test(profile) ||
      profile.endsWith(".") ||
      /^(?:CON|PRN|AUX|NUL|COM[0-9]|LPT[0-9])(?:\..*)?$/i.test(profile))
  ) {
    throw new Error("Invalid isolated OMP fixture profile");
  }
  const agentDir = profile
    ? resolve(configRoot, "profiles", profile, "agent")
    : resolve(configRoot, "agent");
  await mkdir(agentDir, { recursive: true });
  Object.assign(options.environment, {
    OMP_CONFIG_ROOT: configRoot,
    PI_CODING_AGENT_DIR: agentDir,
    OMP_OFFLINE: "0",
    OMP_PROFILE: profile,
    PI_PROFILE: profile,
    PI_CONFIG_FILES: "",
  });
  // Isolate every explicit OMP source/exe run, not just the dedicated fixture.
  // Preserve harness-owned provider credentials; Host registers those dynamically.
  // Never copy developer auth/config into this root or rewrite production roles.
  for (const key of Object.keys(options.environment)) {
    // Native PI_PROXY overrides Host's explicit local MITM; never inherit it into E2E.
    if (/^PI_PROXY(?:_|$)/i.test(key)) {
      delete options.environment[key];
      continue;
    }
    if (/^(?:E2E_|ZCODE_)/i.test(key)) continue;
    if (
      /(?:API_KEY|AUTH_TOKEN|ACCESS_TOKEN|SECRET_ACCESS_KEY|SESSION_TOKEN)$/i.test(key) ||
      /^(?:OMP_AUTH_BROKER_(?:URL|TOKEN)|AWS_(?:PROFILE|DEFAULT_PROFILE|ACCESS_KEY_ID|SHARED_CREDENTIALS_FILE|CONFIG_FILE|WEB_IDENTITY_TOKEN_FILE|ROLE_ARN)|GOOGLE_APPLICATION_CREDENTIALS|CLOUDSDK_(?:CONFIG|AUTH_CREDENTIAL_FILE_OVERRIDE)|AZURE_CLIENT_SECRET|GH_TOKEN|GITHUB_TOKEN)$/i.test(
        key,
      )
    ) {
      delete options.environment[key];
    }
  }
  // Generic cases retain their existing mock provider, model selection and replay
  // server. Pin auxiliary roles to that dynamic provider, never the fixed fixture.
  if (!dedicatedFixture) {
    const model = `${options.modelSelection.providerId}/${options.modelSelection.modelId}`;
    await updateFixtureConfig(agentDir, (document) => {
      for (const role of ["smol", "tiny", "commit", "judge"]) {
        document.setIn(["modelRoles", role], model);
        document.setIn(["retry", "fallbackChains", role], [model]);
      }
    });
    return undefined;
  }
  const requests: ModelRequest[] = [];
  const activeResponses = new Set<ServerResponse>();
  const server = createServer(async (request, response) => {
    if (request.url === "/__requests") {
      response.setHeader("content-type", "application/json");
      response.end(JSON.stringify(requests));
      return;
    }
    if (
      request.method !== "POST" ||
      !["/v1/chat/completions", "/v1/messages"].includes(request.url ?? "")
    ) {
      response.writeHead(404).end("No external network fallback in OMP fixture");
      return;
    }
    try {
      let raw = "";
      for await (const chunk of request) raw += String(chunk);
      const body = JSON.parse(raw) as ModelRequest;
      requests.push(body);
      const coreReply = respondOmpSubagentRequest(body) ?? respondOmpWorkflowRequest(body);
      if (coreReply?.error) {
        response.writeHead(coreReply.error.status, { "content-type": "application/json" });
        response.end(JSON.stringify({ error: { message: coreReply.error.message } }));
        return;
      }
      const callId = `omp-call-${requests.length}`;
      const marker =
        [...body.messages]
          .reverse()
          .filter((message) => message.role === "user")
          .map((message) =>
            typeof message.content === "string" ? message.content : JSON.stringify(message.content),
          )
          .map((text) => text?.match(/OMP_E2E_[A-Z0-9_]+/u)?.[0])
          .find((value) => value !== undefined) ?? "OMP_E2E_AUXILIARY";
      const last = body.messages.at(-1);
      const summaryRequest = isOmpCompactionSummaryRequest(body);
      const archiveRequest =
        !summaryRequest &&
        marker === "OMP_E2E_COMPACT_SEED" &&
        Array.isArray(body.tools) &&
        body.tools.length > 0;
      const initialText = coreReply
        ? (coreReply.text ?? "")
        : summaryRequest
          ? OMP_COMPACT_SUMMARY
          : archiveRequest
            ? compactArchive
            : `${marker}_STREAMING`;
      const finalText = coreReply || summaryRequest || archiveRequest ? "" : ` ${marker}_DONE`;
      const toolFinished =
        last?.role === "tool" || JSON.stringify(last?.content ?? null).includes('"tool_result"');
      // Fixed public native calls exercise the real runtime without interpreting
      // declarations or translating the original Agent's tool vocabulary.
      const tool =
        coreReply ? coreReply.tool :
        (!toolFinished && marker.includes("TOOL")
          ? {
              name: "write",
              args: {
                i: "Writing isolated GUI proof",
                path: "omp-e2e-proof.txt",
                content: marker,
              },
            }
          : !toolFinished && marker.includes("QUESTION")
            ? {
                name: "ask",
                args: {
                  i: "Asking isolated GUI question",
                  questions: [
                    {
                      id: "fixture",
                      question: "OMP isolated question?",
                      options: [{ label: "Continue" }, { label: "Cancel" }],
                    },
                  ],
                },
              }
            : undefined);
      const responseCallId = callId;
      response.writeHead(200, { "content-type": "text/event-stream", "cache-control": "no-cache" });
      activeResponses.add(response);
      response.on("close", () => activeResponses.delete(response));
      const anthropic = request.url === "/v1/messages";
      const event = (type: string, data: unknown) =>
        response.write(`event: ${type}\ndata: ${JSON.stringify(data)}\n\n`);
      const chunk = (delta: unknown, finish: string | null = null) =>
        response.write(
          `data: ${JSON.stringify({ id: "omp-fixture", object: "chat.completion.chunk", created: 1, model: body.model, choices: [{ index: 0, delta, finish_reason: finish }] })}\n\n`,
        );
      if (anthropic) {
        event("message_start", {
          type: "message_start",
          message: {
            id: "omp-fixture",
            type: "message",
            role: "assistant",
            content: [],
            model: body.model,
            stop_reason: null,
            stop_sequence: null,
            usage: { input_tokens: 10, output_tokens: 0 },
          },
        });
        event("content_block_start", {
          type: "content_block_start",
          index: 0,
          content_block: tool
            ? { type: "tool_use", id: responseCallId, name: tool.name, input: {} }
            : { type: "text", text: "" },
        });
        event("content_block_delta", {
          type: "content_block_delta",
          index: 0,
          delta: tool
            ? { type: "input_json_delta", partial_json: JSON.stringify(tool.args) }
            : { type: "text_delta", text: initialText },
        });
      } else {
        chunk({
          role: "assistant",
          ...(tool
            ? {
                tool_calls: [
                  {
                    index: 0,
                    id: responseCallId,
                    type: "function",
                    function: { name: tool.name, arguments: JSON.stringify(tool.args) },
                  },
                ],
              }
            : { content: initialText }),
        });
      }
      if (coreReply?.hold || (!coreReply && marker.includes("STOP"))) return; // ends only when actual runtime aborts HTTP
      const timer = setTimeout(
        () => {
          if (response.destroyed) return;
          if (anthropic) {
            if (!tool)
              event("content_block_delta", {
                type: "content_block_delta",
                index: 0,
                delta: { type: "text_delta", text: finalText },
              });
            event("content_block_stop", { type: "content_block_stop", index: 0 });
            event("message_delta", {
              type: "message_delta",
              delta: { stop_reason: tool ? "tool_use" : "end_turn", stop_sequence: null },
              usage: { output_tokens: 10 },
            });
            event("message_stop", { type: "message_stop" });
          } else {
            if (!tool) chunk({ content: finalText });
            chunk({}, tool ? "tool_calls" : "stop");
            response.write("data: [DONE]\n\n");
          }
          response.end();
        },
        marker.includes("STREAM") ? 1800 : 50,
      );
      response.on("close", () => clearTimeout(timer));
    } catch (error) {
      response.destroy(error instanceof Error ? error : new Error(String(error)));
    }
  });
  const listening = Promise.withResolvers<void>();
  server.once("error", listening.reject);
  server.listen(0, "127.0.0.1", listening.resolve);
  await listening.promise;
  const baseUrl = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
  const subagentReasoning = options.specs.some((spec) => spec.endsWith("omp-subagents.e2e.ts"));
  await writeFile(
    resolve(agentDir, "models.yml"),
    `providers:\n  ${OMP_PROVIDER_ID}:\n    baseUrl: ${baseUrl}/v1\n    auth: none\n    api: openai-completions\n    models:\n      - id: ${OMP_MODEL_ID}\n        reasoning: ${subagentReasoning}\n      - id: omp-alternate\n        reasoning: ${subagentReasoning}\n  omp-anthropic:\n    baseUrl: ${baseUrl}\n    auth: none\n    api: anthropic-messages\n    models:\n      - id: omp-anthropic-chat\n        reasoning: false\n`,
  );
  await updateFixtureConfig(agentDir, (document) => {
    const model = `${OMP_PROVIDER_ID}/${OMP_MODEL_ID}`;
    document.set("enabledModels", [
      model,
      `${OMP_PROVIDER_ID}/omp-alternate`,
      "omp-anthropic/omp-anthropic-chat",
    ]);
    for (const role of [
      "default",
      "smol",
      "slow",
      "vision",
      "plan",
      "commit",
      "tiny",
      "memory",
      "task",
      "advisor",
      "widget",
      "judge",
    ]) {
      document.setIn(["modelRoles", role], model);
      document.setIn(["retry", "fallbackChains", role], [model]);
    }
    document.setIn(["tools", "xdev"], false);
    document.setIn(
      ["team", "members"],
      [`${OMP_PROVIDER_ID}/${OMP_MODEL_ID}`, "stale-provider/removed-model"],
    );
  });
  Object.assign(options.environment, {
    OMP_CONFIG_ROOT: configRoot,
    PI_CODING_AGENT_DIR: agentDir,
    OMP_OFFLINE: "0",
    OMP_PROFILE: profile,
    PI_PROFILE: profile,
    PI_CONFIG_FILES: "",
    OMP_E2E_PROVIDER_URL: baseUrl,
    ANTHROPIC_API_KEY: "omp-fixture-only",
    OPENAI_API_KEY: "omp-fixture-only",
    HTTP_PROXY: "",
    HTTPS_PROXY: "",
    ALL_PROXY: "",
    NO_PROXY: "127.0.0.1,localhost",
  });
  const providerFile = resolve(options.homeDir, ".zcode/v2/provider_config.json");
  const reasoningLevel = subagentReasoning
    ? { values: ["disabled", "low", "high"], map: '{"reasoning_effort":reasoningLevel}' }
    : { values: ["disabled"], map: "{}" };
  await seedPersonalProviderConfig(providerFile, {
    id: OMP_PROVIDER_ID,
    label: "OMP isolated fixture",
    apiFormat: "openai-chat-completions",
    baseURL: `${baseUrl}/v1`,
    apiKey: "omp-fixture-only",
    enabled: true,
    models: [
      { id: OMP_MODEL_ID, contextWindow: 128000, reasoningLevel },
      { id: "omp-alternate", contextWindow: 128000, reasoningLevel },
    ],
  });
  await seedPersonalProviderConfig(providerFile, {
    id: "omp-anthropic",
    label: "OMP isolated Anthropic fixture",
    apiFormat: "anthropic-messages",
    baseURL: baseUrl,
    apiKey: "omp-fixture-only",
    enabled: true,
    models: [{ id: "omp-anthropic-chat", contextWindow: 128000 }],
  });
  await seedPersonalDefaultModelSelection(providerFile, {
    providerId: OMP_PROVIDER_ID,
    modelId: OMP_MODEL_ID,
  });
  return async () => {
    for (const response of activeResponses) response.destroy();
    const closed = Promise.withResolvers<void>();
    server.close((error) => (error ? closed.reject(error) : closed.resolve()));
    await closed.promise;
  };
}

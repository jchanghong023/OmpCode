/**
 * Anthropic SSE framing/tool-result correlation adapted from oh-my-pi
 * scripts/repo-ui-smoke.ts at 57672f546162e16b019484626c3b5fa9300aafef,
 * MIT (see third-party/upstream/omp-mock.LICENSE).
 * Modified by ZCode: Node HTTP lifecycle, copied mock engine, strict local
 * scenarios and isolated config. Only OMP executes tools or writes workspace files.
 */
import { createServer } from "node:http";
import { randomUUID } from "node:crypto";
import { mkdir, readFile, writeFile } from "node:fs/promises";
import path from "node:path";
import { createMockModel } from "./ompMockModel.mjs";
import { createStrictMockHandler } from "./ompMockScenarios.mjs";

export const MOCK_PROVIDER = "zcode-mock";
export const MOCK_MODEL_ID = "scripted";
export const MOCK_MODEL_NAME = "ZCode Mock";
export const MOCK_MODEL_SELECTOR = `${MOCK_PROVIDER}/${MOCK_MODEL_ID}`;
export const GUI_MOCK_MODELS = [
  { id: MOCK_MODEL_ID, name: MOCK_MODEL_NAME, efforts: ["high", "max"] },
  { id: "scripted-alt", name: "ZCode Mock Alt", efforts: ["high"] },
].map((model) => ({ ...model, selector: `${MOCK_PROVIDER}/${model.id}` }));

function usageOnWire(usage) {
  return {
    input_tokens: usage.input,
    output_tokens: usage.output,
    cache_read_input_tokens: usage.cacheRead,
    cache_creation_input_tokens: usage.cacheWrite,
  };
}

function frame(response, event, data) {
  response.write(`event: ${event}\ndata: ${JSON.stringify({ type: event, ...data })}\n\n`);
}

async function serveStream(response, stream, signal, metadata) {
  const id = `msg_${randomUUID().replaceAll("-", "")}`;
  for await (const event of stream) {
    if (signal.aborted) return;
    if (!response.headersSent) {
      response.writeHead(metadata.status ?? 200, {
        ...metadata.headers,
        "content-type": "text/event-stream",
        "cache-control": "no-cache",
        "request-id": metadata.requestId ?? id,
      });
    }
    const index = event.contentIndex;
    if (event.type === "start")
      frame(response, "message_start", {
        message: {
          id: event.partial.responseId ?? id,
          type: "message",
          role: "assistant",
          model: metadata.modelId ?? MOCK_MODEL_ID,
          content: [],
          stop_reason: null,
          usage: usageOnWire(event.partial.usage),
        },
      });
    else if (event.type === "text_start")
      frame(response, "content_block_start", {
        index,
        content_block: { type: "text", text: "" },
      });
    else if (event.type === "thinking_start")
      frame(response, "content_block_start", {
        index,
        content_block: { type: "thinking", thinking: "" },
      });
    else if (event.type === "toolcall_start") {
      const block = event.partial.content[index];
      frame(response, "content_block_start", {
        index,
        content_block: { type: "tool_use", id: block.id, name: block.name, input: {} },
      });
    } else if (
      event.type === "text_delta" ||
      event.type === "thinking_delta" ||
      event.type === "toolcall_delta"
    ) {
      const delta =
        event.type === "text_delta"
          ? { type: "text_delta", text: event.delta }
          : event.type === "thinking_delta"
            ? { type: "thinking_delta", thinking: event.delta }
            : { type: "input_json_delta", partial_json: event.delta };
      frame(response, "content_block_delta", { index, delta });
    } else if (
      event.type === "text_end" ||
      event.type === "thinking_end" ||
      event.type === "toolcall_end"
    ) {
      if (event.type === "thinking_end") {
        const signature = event.partial.content[index].thinkingSignature;
        if (signature)
          frame(response, "content_block_delta", {
            index,
            delta: { type: "signature_delta", signature },
          });
      }
      frame(response, "content_block_stop", { index });
    } else if (event.type === "done") {
      metadata.terminalReason = event.reason;
      frame(response, "message_delta", {
        delta: {
          stop_reason: { stop: "end_turn", length: "max_tokens", toolUse: "tool_use" }[
            event.reason
          ],
          stop_sequence: null,
        },
        usage: usageOnWire(event.message.usage),
      });
      frame(response, "message_stop", {});
    } else if (event.type === "error") {
      metadata.terminalReason = event.reason;
      frame(response, "error", {
        error: {
          type: event.reason === "aborted" ? "request_aborted" : "api_error",
          message: event.error.errorMessage ?? "mock error",
        },
      });
    }
  }
  response.end();
}

export async function startMockModelServer(options = {}) {
  const failures = [];
  const controllers = new Set();
  const tasks = new Set();
  const custom = options.handler !== undefined || options.responses !== undefined;
  const catalog = options.models ?? [GUI_MOCK_MODELS[0]];
  const calls = [];
  const requests = [];
  const handler = custom ? options.handler : createStrictMockHandler();
  const models = new Map(
    catalog.map((entry) => {
      const instance = createMockModel({
        id: entry.id,
        provider: MOCK_PROVIDER,
        reasoning: true,
        responses: options.responses,
        handler,
      });
      instance.calls = calls;
      return [entry.id, instance];
    }),
  );
  if (!models.has(MOCK_MODEL_ID) || models.size !== catalog.length)
    throw new Error("Mock catalog requires the primary model and unique model IDs");
  const model = models.get(MOCK_MODEL_ID);
  const recordFailure = (error) =>
    failures.push(error instanceof Error ? error : new Error(String(error)));
  const server = createServer((request, response) => {
    const controller = new AbortController();
    controllers.add(controller);
    response.on("close", () => {
      if (!response.writableEnded) controller.abort(new Error("HTTP client disconnected"));
    });
    request.on("aborted", () => controller.abort(new Error("HTTP request aborted")));
    const task = (async () => {
      if (request.method !== "POST" || request.url !== "/v1/messages")
        throw new Error("Unsupported mock HTTP endpoint");
      const chunks = [];
      for await (const chunk of request) chunks.push(chunk);
      const body = JSON.parse(Buffer.concat(chunks).toString("utf8"));
      const selectedModel = models.get(body.model);
      if (!selectedModel) throw new Error(`Unsupported mock model: ${body.model}`);
      if (!Array.isArray(body.messages) || body.stream !== true)
        throw new Error("Expected streaming Anthropic messages");
      const recorded = {
        requestId: randomUUID(),
        model: body.model,
        messages: body.messages,
        system: body.system ?? null,
        tools: body.tools ?? [],
        thinking: body.thinking ?? null,
        outputConfig: body.output_config ?? null,
        aborted: false,
        completed: false,
      };
      requests.push(recorded);
      controller.signal.addEventListener(
        "abort",
        () => {
          recorded.aborted = true;
        },
        { once: true },
      );
      const metadata = { modelId: body.model };
      const stream = selectedModel.stream(
        selectedModel,
        {
          messages: body.messages,
          systemPrompt: body.system,
          tools: body.tools,
        },
        {
          signal: controller.signal,
          modelId: body.model,
          onResponse(value) {
            Object.assign(metadata, value);
          },
        },
      );
      await serveStream(response, stream, controller.signal, metadata);
      recorded.completed =
        !controller.signal.aborted &&
        ["stop", "length", "toolUse"].includes(metadata.terminalReason);
    })()
      .catch((error) => {
        if (controller.signal.aborted) return;
        recordFailure(error);
        if (!response.headersSent) {
          response.writeHead(400, { "content-type": "application/json" });
          response.end(
            JSON.stringify({
              type: "error",
              error: { type: "invalid_request_error", message: String(error.message ?? error) },
            }),
          );
        } else {
          frame(response, "error", {
            error: { type: "api_error", message: String(error.message ?? error) },
          });
          response.end();
        }
      })
      .finally(() => {
        controllers.delete(controller);
        tasks.delete(task);
      });
    tasks.add(task);
  });
  await new Promise((resolve, reject) => {
    server.once("error", reject);
    server.listen(0, "127.0.0.1", resolve);
  });
  server.on("error", recordFailure);
  const baseUrl = `http://127.0.0.1:${server.address().port}`;
  for (const instance of models.values()) instance.baseUrl = baseUrl;
  let closed = false;
  return {
    baseUrl,
    model,
    calls,
    requests,
    models: catalog.map((entry) => ({
      ...entry,
      selector: `${MOCK_PROVIDER}/${entry.id}`,
    })),
    assertHealthy() {
      if (failures.length)
        throw new AggregateError(failures, failures.map((error) => error.message).join("\n"));
    },
    async close() {
      if (closed) return;
      closed = true;
      for (const controller of controllers) controller.abort(new Error("Mock server closing"));
      await new Promise((resolve, reject) => {
        server.close((error) => (error ? reject(error) : resolve()));
        server.closeAllConnections();
      });
      await Promise.all(tasks);
    },
    async writeConfig(
      configRoot,
      {
        defaultModel = MOCK_MODEL_SELECTOR,
        input = ["text", "image"],
        profile = "",
        preserveConfig = false,
      } = {},
    ) {
      if (profile && !/^[A-Za-z0-9_-]+$/u.test(profile))
        throw new Error("Fixture profile must be a single safe directory name");
      const agentDir = profile
        ? path.join(configRoot, "profiles", profile, "agent")
        : path.join(configRoot, "agent");
      await mkdir(agentDir, { recursive: true });
      const models = {
        providers: {
          [MOCK_PROVIDER]: {
            api: "anthropic-messages",
            baseUrl,
            apiKey: "zcode-mock-fixture-key",
            auth: "apiKey",
            compat: { requiresToolResultId: true },
            models: catalog.map((entry) => ({
              id: entry.id,
              name: entry.name,
              reasoning: true,
              input,
              thinking: { mode: "anthropic-budget-effort", efforts: entry.efforts },
              cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
              contextWindow: 200000,
              maxTokens: 32768,
            })),
          },
        },
      };
      const roles = Object.fromEntries(
        [
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
          "image",
          "web",
          "speech",
          "dictation",
          "judge",
        ].map((role) => [role, role === "default" ? defaultModel : MOCK_MODEL_SELECTOR]),
      );
      const config = {
        modelRoles: roles,
        advisor: { enabled: false },
        goal: { continuationModes: [] },
        async: { enabled: false },
        task: {
          batch: false,
          structured: false,
          prewalk: false,
          agentModelOverrides: { task: MOCK_MODEL_SELECTOR },
        },
        startup: { setupWizard: false, checkUpdate: false },
        marketplace: { autoUpdate: "off" },
      };
      // JSON is a YAML subset and avoids adding a production YAML dependency.
      await writeFile(
        path.join(agentDir, "models.yml"),
        `${JSON.stringify(models, null, 2)}\n`,
        "utf8",
      );
      // 冷启动只更新临时端口；覆盖角色配置会把“保存丢失”的回归伪装成测试准备。
      if (preserveConfig) {
        await readFile(path.join(agentDir, "config.yml"));
        return;
      }
      await writeFile(
        path.join(agentDir, "config.yml"),
        `${JSON.stringify(config, null, 2)}\n`,
        "utf8",
      );
    },
  };
}

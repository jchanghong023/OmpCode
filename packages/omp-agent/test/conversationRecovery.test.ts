import assert from "node:assert/strict";
import { test } from "node:test";
import { ConversationProjection } from "../src/domain/conversationProjection.js";
import { PromptResultTracker } from "../src/domain/promptResultTracker.js";
import { ConversationEngine } from "../src/app/conversationEngine.js";
import type {
  HostGateway,
  OmpProcessFactory,
  OmpSessionProcess,
  OmpUiRequest,
} from "../src/app/ports.js";

function input(id: string, routing: "startNow" | "queue" = "startNow") {
  return { text: id, inputId: id, sourceCommandId: id, clientId: "test", routing };
}

test("queued local command finishes without agent_start", () => {
  const projection = new ConversationProjection("session");
  projection.beginUserTurn(input("first"));
  projection.beginUserTurn(input("local", "queue"));
  projection.finishTurn("success");
  assert.equal(projection.finishQueuedLocalOnlyTurn(), true);
  assert.deepEqual(
    projection
      .rowsRange(undefined, 100)
      .rows.filter((row) => row.kind === "turnHeader")
      .map((row) => row.state),
    ["completedSuccess", "completedSuccess"],
  );
});

test("failed queued command does not fail the running turn", () => {
  const projection = new ConversationProjection("session");
  projection.beginUserTurn(input("first"));
  projection.beginUserTurn(input("queued", "queue"));
  projection.failCommandTurn("queued", { code: "omp_prompt_failed", message: "offline" });
  assert.equal(projection.stateSnapshot.control.phase, "running");
  projection.finishTurn("success");
  assert.deepEqual(
    projection
      .rowsRange(undefined, 100)
      .rows.filter((row) => row.kind === "turnHeader")
      .map((row) => row.state),
    ["completedSuccess", "failed"],
  );
});

test("core exit closes active and queued turns", () => {
  const projection = new ConversationProjection("session");
  projection.beginUserTurn(input("first"));
  projection.beginUserTurn(input("queued", "queue"));
  projection.failAllTurns({ code: "omp_process_exit", message: "core exited" });
  assert.deepEqual(
    projection
      .rowsRange(undefined, 100)
      .rows.filter((row) => row.kind === "turnHeader")
      .map((row) => row.state),
    ["failed", "failed"],
  );
});

test("queued follow_up local completion is associated with its request", () => {
  const tracker = new PromptResultTracker();
  tracker.noteResponse({ id: "follow-up", command: "follow_up", success: true, data: {} });
  assert.equal(tracker.shouldFinish({ id: "follow-up", agentInvoked: false }), true);
});

test("rejected omp send ends the submitted turn", async () => {
  const process: OmpSessionProcess = {
    ompSessionFile: null,
    async start() {},
    async refreshState() {
      return null;
    },
    async dispose() {},
    respondUi() {},
    async send(command) {
      if (command.type === "prompt") throw new Error("omp command timeout");
      return { success: true, data: {} };
    },
  };
  const factory: OmpProcessFactory = { create: () => process };
  const gateway = {
    emitFrame() {},
    requestUserInput: async () => ({ action: "cancel" as const }),
  } as HostGateway;
  const engine = new ConversationEngine({
    sessionId: "session",
    workspaceId: "workspace",
    workspacePath: ".",
    ompFactory: factory,
    gateway,
    onIndexChange() {},
  });
  try {
    await engine.sendText("hello", "command", "client");
    const header = engine.projection
      .rowsRange(undefined, 100)
      .rows.find((row) => row.kind === "turnHeader");
    assert.equal(header?.kind === "turnHeader" && header.state, "failed");
  } finally {
    await engine.dispose();
  }
});

test("omp exit cancels a pending UI question", async () => {
  let exit: ((code: number | null) => void) | undefined;
  let uiRequest: ((request: OmpUiRequest) => void) | undefined;
  const process: OmpSessionProcess = {
    ompSessionFile: null,
    async start() {},
    async refreshState() {
      return null;
    },
    async dispose() {},
    respondUi() {},
    async send() {
      return { success: true, data: {} };
    },
  };
  const factory: OmpProcessFactory = {
    create(options) {
      exit = options.onExit;
      uiRequest = options.onUiRequest;
      return process;
    },
  };
  const gateway = {
    emitFrame() {},
    requestUserInput: () => new Promise<never>(() => {}),
  } as HostGateway;
  const engine = new ConversationEngine({
    sessionId: "session",
    workspaceId: "workspace",
    workspacePath: ".",
    ompFactory: factory,
    gateway,
    onIndexChange() {},
  });
  try {
    await engine.ensureOmpStarted();
    let response: unknown;
    uiRequest?.({
      frame: { id: "ask", method: "input", prompt: "Question" },
      respond: (value) => {
        response = value;
      },
    });
    await Promise.resolve();
    exit?.(1);
    await Promise.resolve();
    assert.deepEqual(response, { type: "extension_ui_response", id: "ask", cancelled: true });
  } finally {
    await engine.dispose();
  }
});

test("queued local command completes after the active agent ends", async () => {
  let agentEvent: ((event: { type: "agent_start" | "agent_end" }) => void) | undefined;
  const process: OmpSessionProcess = {
    ompSessionFile: null,
    async start() {},
    async refreshState() {
      return null;
    },
    async dispose() {},
    respondUi() {},
    async send(command) {
      if (command.type === "follow_up") return { success: true, data: { agentInvoked: false } };
      return { success: true, data: { agentInvoked: true } };
    },
  };
  const factory: OmpProcessFactory = {
    create(options) {
      agentEvent = options.onEvent;
      return process;
    },
  };
  const gateway = {
    emitFrame() {},
    requestUserInput: async () => ({ action: "cancel" as const }),
  } as HostGateway;
  const engine = new ConversationEngine({
    sessionId: "session",
    workspaceId: "workspace",
    workspacePath: ".",
    ompFactory: factory,
    gateway,
    onIndexChange() {},
  });
  try {
    await engine.sendText("first", "first", "client");
    agentEvent?.({ type: "agent_start" });
    await engine.sendText("/local", "local", "client");
    agentEvent?.({ type: "agent_end" });
    assert.deepEqual(
      engine.projection
        .rowsRange(undefined, 100)
        .rows.filter((row) => row.kind === "turnHeader")
        .map((row) => row.state),
      ["completedSuccess", "completedSuccess"],
    );
  } finally {
    await engine.dispose();
  }
});

test("omp 崩溃后首轮输入按全新 prompt 路由而非 follow_up", async () => {
  const sentByProcess: string[][] = [];
  let exit: ((code: number | null) => void) | undefined;
  let agentEvent: ((event: { type: "agent_start" | "agent_end" }) => void) | undefined;
  const factory: OmpProcessFactory = {
    create(options) {
      exit = options.onExit;
      agentEvent = options.onEvent;
      const commands: string[] = [];
      sentByProcess.push(commands);
      return {
        ompSessionFile: null,
        async start() {},
        async refreshState() {
          return null;
        },
        async dispose() {},
        respondUi() {},
        async send(command) {
          // 只记录用户输入路由命令；get_subagents 是 startOmp 的启动握手，与路由无关。
          if (
            command.type === "prompt" ||
            command.type === "follow_up" ||
            command.type === "steer"
          ) {
            commands.push(command.type);
          }
          return { success: true, data: {} };
        },
      };
    },
  };
  const gateway = {
    emitFrame() {},
    requestUserInput: async () => ({ action: "cancel" as const }),
  } as HostGateway;
  const engine = new ConversationEngine({
    sessionId: "session",
    workspaceId: "workspace",
    workspacePath: ".",
    ompFactory: factory,
    gateway,
    onIndexChange() {},
  });
  try {
    await engine.sendText("first", "cmd-1", "client");
    assert.deepEqual(sentByProcess[0], ["prompt"]);
    // 进入流式（agent_start 置位 projector.streaming），随后进程在 agent_end 之前崩溃。
    agentEvent?.({ type: "agent_start" });
    exit?.(1);
    // 崩溃恢复后的第一条输入：进程是全新且空闲的，必须按 startNow 下发 prompt，
    // 而不是按陈旧 isStreaming 误路由为 follow_up（静默排队）或 steer（报错）。
    await engine.sendText("second", "cmd-2", "client");
    assert.deepEqual(sentByProcess[1], ["prompt"]);
  } finally {
    await engine.dispose();
  }
});

test("omp 崩溃重启后携带运行期新建的会话文件恢复", async () => {
  const resumeArgs: (string | undefined)[] = [];
  let exit: ((code: number | null) => void) | undefined;
  // 模拟 omp 首个 prompt 后才落盘会话文件（新会话启动时为 null）。
  let sessionFile: string | null = null;
  const factory: OmpProcessFactory = {
    create(options) {
      exit = options.onExit;
      resumeArgs.push(options.resumeSessionPath);
      return {
        get ompSessionFile() {
          return sessionFile;
        },
        async start() {},
        async refreshState() {
          return null;
        },
        async dispose() {},
        respondUi() {},
        async send() {
          sessionFile ??= "D:/fake/.omp/sessions/session-1.jsonl";
          return { success: true, data: {} };
        },
      };
    },
  };
  const gateway = {
    emitFrame() {},
    requestUserInput: async () => ({ action: "cancel" as const }),
  } as HostGateway;
  const engine = new ConversationEngine({
    sessionId: "session",
    workspaceId: "workspace",
    workspacePath: ".",
    ompFactory: factory,
    gateway,
    onIndexChange() {},
  });
  try {
    await engine.sendText("first", "cmd-1", "client");
    assert.equal(engine.ompSessionFile, "D:/fake/.omp/sessions/session-1.jsonl");
    exit?.(1);
    // 崩溃后 ompSessionFile 仍可经 resumeSessionPath 回挂。
    assert.equal(engine.ompSessionFile, "D:/fake/.omp/sessions/session-1.jsonl");
    await engine.sendText("second", "cmd-2", "client");
    assert.deepEqual(resumeArgs, [undefined, "D:/fake/.omp/sessions/session-1.jsonl"]);
  } finally {
    await engine.dispose();
  }
});

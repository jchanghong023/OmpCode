import assert from "node:assert/strict";
import test from "node:test";
import { conversationTopicWireFrameSchema } from "@zcode/shared/zcode-protocol-v4";
import { ConversationEngine } from "../src/app/conversationEngine.js";
import type { HostGateway, OmpProcessFactory, OmpSessionProcess } from "../src/app/ports.js";
import type { OmpSessionEventFrame, OmpStateData } from "../src/domain/ompFrames.js";

test("订阅冷会话先交付快照，后台状态读取与紧接的发送共用一次 omp 启动", async () => {
  let releaseStart!: () => void;
  const startGate = new Promise<void>((resolve) => {
    releaseStart = resolve;
  });
  let starts = 0;
  let sends = 0;
  let onEvent: ((event: OmpSessionEventFrame) => void) | undefined;
  let usedTokens = 512;
  const frames: unknown[] = [];
  const process: OmpSessionProcess = {
    ompSessionFile: "cold.jsonl",
    async start() {
      starts += 1;
      await startGate;
    },
    async refreshState(): Promise<OmpStateData> {
      return {
        model: { provider: "mock", id: "mock-1" },
        thinkingLevel: "max",
        autoCompactionEnabled: true,
        contextUsage: { tokens: usedTokens, contextWindow: 200_000, percent: usedTokens / 2_000 },
      };
    },
    async readContextReport() {
      return { contextWindow: 200_000, entries: [{ label: "Messages", tokens: usedTokens }] };
    },
    async send() {
      sends += 1;
      return { success: true, data: { agentInvoked: false } };
    },
    respondUi() {},
    async dispose() {},
  };
  const factory: OmpProcessFactory = {
    create(options) {
      onEvent = options.onEvent;
      return process;
    },
  };
  const gateway = {
    emitFrame(frame: unknown) {
      frames.push(frame);
    },
    requestUserInput: async () => ({ action: "cancel" as const }),
  } as HostGateway;
  const engine = new ConversationEngine({
    sessionId: "cold-session",
    workspaceId: "workspace",
    workspacePath: ".",
    ompFactory: factory,
    gateway,
    onIndexChange() {},
    resumeSessionPath: "cold.jsonl",
  });
  try {
    const ack = engine.subscribe({ connectionId: "desktop", clientMode: "desktop-continuous" });
    assert.equal(ack.mode, "snapshot");
    assert.ok(frames.length > 0);
    const send = engine.sendText("hello", "command", "client");
    assert.equal(starts, 1);
    assert.equal(sends, 0);
    releaseStart();
    await send;
    assert.equal(starts, 1);
    assert.equal(sends, 1);
    assert.deepEqual(engine.projection.stateSnapshot.usage.contextWindow, {
      usedTokens: 512,
      maxTokens: 200_000,
      autoCompactThresholdTokens: null,
    });
    assert.equal(engine.projection.stateSnapshot.config.autoCompactionEnabled, true);

    usedTokens = 900;
    onEvent?.({ type: "agent_end" });
    for (
      let attempt = 0;
      attempt < 20 && engine.projection.stateSnapshot.usage.contextWindow?.usedTokens !== 900;
      attempt += 1
    ) {
      await new Promise((resolve) => setTimeout(resolve, 10));
    }
    assert.equal(engine.projection.stateSnapshot.usage.contextWindow?.usedTokens, 900);
    for (
      let attempt = 0;
      attempt < 20 && !engine.projection.stateSnapshot.usage.contextWindow?.details;
      attempt += 1
    ) {
      await new Promise((resolve) => setTimeout(resolve, 10));
    }
    assert.deepEqual(engine.projection.stateSnapshot.usage.contextWindow?.details?.entries, [
      { label: "Messages", tokens: 900 },
    ]);
    const mobileAck = engine.subscribe({
      connectionId: "mobile",
      clientMode: "web-remote-replayable",
      base: { logEpoch: ack.logEpoch, seq: 0 },
    });
    assert.equal(mobileAck.mode, "resume");
    assert.ok(frames.every((frame) => conversationTopicWireFrameSchema.safeParse(frame).success));
    assert.ok(frames.some((frame) => JSON.stringify(frame).includes('"details"')));
  } finally {
    releaseStart();
    await engine.dispose();
  }
});

import assert from "node:assert/strict";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import test from "node:test";
import { createOmpProcessFactory } from "../src/adapters/ompProcess.js";

test("/context 输出只进入报告，随后用户本地命令仍进入聊天侧信道", async () => {
  const fixture = join(fileURLToPath(new URL(".", import.meta.url)), "fixtures", "fakeOmp.mjs");
  const output: string[] = [];
  const ompProcess = createOmpProcessFactory(process.execPath, [fixture]).create({
    cwd: fileURLToPath(new URL(".", import.meta.url)),
    onEvent() {},
    onUiRequest() {},
    onExit() {},
    onCommandOutput: ({ text }) => output.push(text),
  });
  try {
    await ompProcess.start();
    const report = ompProcess.readContextReport();
    const user = ompProcess.send({ type: "prompt", message: "/help" });
    assert.deepEqual(await report, {
      contextWindow: 200_000,
      entries: [
        { label: "System prompt", tokens: 200 },
        { label: "Messages", tokens: 312 },
        { label: "Free", tokens: 169_488 },
        { label: "Auto-compact buf", tokens: 30_000 },
      ],
    });
    assert.equal((await user).success, true);
    assert.deepEqual(output, ["Fake help output"]);
  } finally {
    await ompProcess.dispose();
  }
});

import assert from "node:assert/strict";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import test from "node:test";
import { createOmpProcessFactory } from "../src/adapters/ompProcess.js";
import { OmpDirectoryGateway } from "../src/adapters/ompDirectoryGateway.js";

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

test("目录 start 等待异步 v3 协商 ACK，ready 同批目录更新不丢失", { timeout: 5000 }, async () => {
  const core = `
    const {createInterface}=require("node:readline");
    const out=value=>process.stdout.write(JSON.stringify(value)+"\\n");
    process.stdout.write(JSON.stringify({type:"ready",protocolVersion:1,supportedProtocolVersions:[1,2,3]})+"\\n"+
      JSON.stringify({type:"available_commands_update",commands:[{name:"help",source:"builtin"}]})+"\\n");
    createInterface({input:process.stdin}).on("line",line=>{
      const command=JSON.parse(line);
      const respond=()=>out({type:"response",id:command.id,command:command.type,success:true,data:{}});
      if(command.type==="negotiate_protocol")setImmediate(respond);else respond();
    });
  `;
  const updates: unknown[] = [];
  const directory = new OmpDirectoryGateway({
    cwd: process.cwd(),
    ompFactory: createOmpProcessFactory(process.execPath, ["-e", core, "--"]),
    onCommandsUpdate: (commands) => updates.push(commands),
  });
  try {
    assert.equal(await directory.availability(), "available");
    assert.deepEqual(updates, [[{ name: "help", source: "builtin" }]]);
    const outcome = await directory.sendDirectory({ type: "list_sessions" });
    assert.equal(outcome.success, true);
  } finally {
    await directory.dispose();
  }
});

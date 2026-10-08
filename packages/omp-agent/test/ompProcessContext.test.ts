import assert from "node:assert/strict";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import test from "node:test";
import { createOmpProcessFactory } from "../src/adapters/ompProcess.js";
import { OmpDirectoryGateway } from "../src/adapters/ompDirectoryGateway.js";

test("目录与会话进程原样继承入口 OMP 环境，不注入 --offline", { timeout: 5000 }, async () => {
  const core = `
    const {createInterface}=require("node:readline");
    const out=value=>process.stdout.write(JSON.stringify(value)+"\\n");
    out({type:"ready",protocolVersion:1});
    createInterface({input:process.stdin}).on("line",line=>{
      const command=JSON.parse(line);
      out({type:"response",id:command.id,command:command.type,success:true,data:{
        env:Object.fromEntries(["OMP_CONFIG_ROOT","OMP_OFFLINE","OMP_FUTURE_OPTION","PI_CONFIG_DIR"].map(key=>[key,process.env[key]])),
        argv:process.argv.slice(1)
      }});
    });
  `;
  const expected = {
    OMP_CONFIG_ROOT: "~/relocated",
    OMP_OFFLINE: "1",
    OMP_FUTURE_OPTION: "value",
    PI_CONFIG_DIR: "legacy",
  };
  const factory = createOmpProcessFactory(process.execPath, ["-e", core, "--"], {
    ...process.env,
    ...expected,
  });
  for (const sessionless of [false, true]) {
    const child = factory.create({
      cwd: process.cwd(),
      sessionless,
      onEvent() {},
      onUiRequest() {},
      onExit() {},
    });
    try {
      await child.start();
      const result = await child.send({ type: "get_available_models" });
      assert.equal(result.success, true);
      const data = result.data as { env: Record<string, string>; argv: string[] };
      assert.deepEqual(data.env, expected);
      assert.equal(data.argv.includes("--offline"), false);
      assert.equal(data.argv.includes("--no-session"), sessionless);
    } finally {
      await child.dispose();
    }
  }
});

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

test(
  "/context ACK 前后交错的原生业务输出仍交付，只有完整报告进入侧信道",
  { timeout: 5000 },
  async () => {
    const core = `
    const {createInterface}=require("node:readline");
    const out=value=>process.stdout.write(JSON.stringify(value)+"\\n");
    out({type:"ready",protocolVersion:1});
    createInterface({input:process.stdin}).on("line",line=>{
      const command=JSON.parse(line);
      const response={type:"response",id:command.id,command:command.type,success:true,data:{}};
      if(command.type==="prompt" && command.message==="/context") {
        const frames=[
          {type:"command_output",text:"Plan mode paused."},
          {type:"command_output",text:"Context window: 200000 tokens (0% used)\\n  Messages [░░░░] 0% 312 tokens\\n  Free [████] 99% 199688 tokens"},
          {...response,data:{agentInvoked:false}},
          {type:"command_output",text:"Goal mode resumed."}
        ];
        process.stdout.write(frames.map(frame=>JSON.stringify(frame)).join("\\n")+"\\n");
        setImmediate(()=>out({type:"command_output",text:"Plan mode disabled."}));
      } else out(response);
    });
  `;
    const output: string[] = [];
    const processPort = createOmpProcessFactory(process.execPath, ["-e", core, "--"]).create({
      cwd: process.cwd(),
      onEvent() {},
      onUiRequest() {},
      onExit() {},
      onCommandOutput: ({ text }) => output.push(text),
    });
    try {
      await processPort.start();
      assert.deepEqual(await processPort.readContextReport(), {
        contextWindow: 200000,
        entries: [
          { label: "Messages", tokens: 312 },
          { label: "Free", tokens: 199688 },
        ],
      });
      const deadline = Date.now() + 1000;
      while (output.length < 3 && Date.now() < deadline)
        await new Promise((done) => setTimeout(done, 10));
      assert.deepEqual(output, ["Plan mode paused.", "Goal mode resumed.", "Plan mode disabled."]);
    } finally {
      await processPort.dispose();
    }
  },
);

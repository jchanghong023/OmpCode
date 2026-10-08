// 透明测试诊断：实际安装的 OMP stdio 原字节转发；仅记录与命令/交互有关的非敏感帧摘要。
import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { appendFile } from "node:fs/promises";
const binary = process.env.OMP_NATIVE_E2E_REAL_BINARY;
const logPath = process.env.OMP_NATIVE_E2E_NATIVE_FRAME_PATH;
assert.ok(binary && logPath, "Native wire tap requires the real binary and fixture evidence path");
const secret = process.env.ZHIPU_API_KEY;
let writes = Promise.resolve();
function capture(direction, line) {
  let frame;
  try {
    frame = JSON.parse(line);
  } catch {
    return;
  }
  let summary;
  if (frame.type === "command_output") summary = { type: frame.type, text: frame.text };
  else if (frame.type === "prompt")
    summary = { type: frame.type, id: frame.id, message: frame.message };
  else if (frame.type === "response")
    summary = {
      type: frame.type,
      id: frame.id,
      command: frame.command,
      success: frame.success,
      agentInvoked: frame.data?.agentInvoked,
    };
  else if (frame.type === "extension_ui_request" || frame.type === "extension_ui_response")
    summary = {
      type: frame.type,
      id: frame.id,
      method: frame.method,
      title: frame.title,
      message: frame.message,
      confirmed: frame.confirmed,
      cancelled: frame.cancelled,
    };
  if (!summary) return;
  let text = JSON.stringify({ timestamp: new Date().toISOString(), direction, frame: summary });
  if (secret) text = text.replaceAll(secret, "[redacted]");
  writes = writes.then(() => appendFile(logPath, `${text}\n`));
}
function tap(stream, target, direction) {
  let pending = "";
  stream.on("data", (chunk) => {
    target.write(chunk);
    pending += chunk.toString("utf8");
    const lines = pending.split("\n");
    pending = lines.pop() ?? "";
    for (const line of lines) capture(direction, line);
  });
}
const child = spawn(binary, process.argv.slice(2), {
  env: process.env,
  stdio: ["pipe", "pipe", "pipe"],
  windowsHide: true,
});
tap(process.stdin, child.stdin, "adapter-to-omp");
tap(child.stdout, process.stdout, "omp-to-adapter");
child.stderr.pipe(process.stderr);
process.stdin.once("end", () => child.stdin.end());
child.once("error", () => {
  process.exitCode = 1;
});
child.once("exit", async (code) => {
  await writes;
  process.exit(code ?? 1);
});
for (const signal of ["SIGTERM", "SIGINT"]) process.once(signal, () => child.kill());

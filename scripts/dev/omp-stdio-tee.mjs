// stdio tee wrapper：host ↔ omp-agent 之间的帧记录到文件（GUI 调试用）。
// 用法：ZCODE_AGENT_SERVER_COMMAND=node ZCODE_AGENT_SERVER_ARGS_JSON='["<this file>","<real adapter>"]'
// host 会在 ARGS_JSON 后追加 app-server --stdio --surface desktop 等参数。
import { spawn } from "node:child_process";
import { createInterface } from "node:readline";
import { appendFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

const real = process.argv[2];
const rest = process.argv.slice(3);
const log = (dir, line) => appendFileSync(join(tmpdir(), `omp-tap-${dir}.log`), line + "\n");

const child = spawn(process.execPath, [real, ...rest], { stdio: ["pipe", "pipe", "pipe"] });
child.stdout.on("data", (chunk) => process.stdout.write(chunk));
child.stderr.on("data", (chunk) => process.stderr.write(chunk));
process.stdin.pipe(child.stdin);

// host→adapter（stdin of child）；adapter→host（stdout of child）
createInterface({ input: process.stdin }).on("line", (line) => log("h2a", line.slice(0, 500)));
createInterface({ input: child.stdout }).on("line", (line) => log("a2h", line.slice(0, 300)));

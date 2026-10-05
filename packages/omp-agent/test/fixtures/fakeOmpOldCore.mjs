// fake 真旧核（pre-fork.271）：不识别 --rpc-project，镜像 omp cli/args.ts 的
// reportUnrecognizedFlags stderr 报错与 main.ts 的 process.exit(2)，永远不会 emit
// ready。供网关旧核回落 UT（B4）驱动 OmpProjectGateway 的永久回落分支。
// 以 `node fakeOmpOldCore.mjs --mode rpc-ui --rpc-project` 拉起（gateway 组装参数）。
//
// FAKE_OMP_FAILURE_MODE=invalid-flag-value：镜像 omp reportInvalidFlagValues +
// main.ts 的 exit(2) 路径（args.ts:422-428）——stderr 文案是 `Error: <message>`，
// 不含 "unknown flag"。用于验证「exit 2 不再单独充分判定旧核」（S1-1）：
// 非法 flag 值必须保持可重试 unavailable，而不是被误判旧核造成永久回落。

import { appendFileSync } from "node:fs";

if (process.env.FAKE_OMP_MARKER) {
  appendFileSync(process.env.FAKE_OMP_MARKER, `start ${process.pid}\n`);
}
if (process.env.FAKE_OMP_FAILURE_MODE === "invalid-flag-value") {
  process.stderr.write("Error: Invalid value for --model: no-such-model\n");
  process.exit(2);
}
process.stderr.write("Error: unknown flag: --rpc-project\n");
process.stderr.write("Run `omp --help` for available flags.\n");
process.exit(2);

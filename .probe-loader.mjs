// 只读探针：直调适配器 createWorkspaceConfigLoader，打印模型目录加载结果。
import { spawn } from "node:child_process";
import { createRequire } from "node:module";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { pathToFileURL } from "node:url";

const cwd = mkdtempSync(join(tmpdir(), "omp-loader-probe-"));
const script = `
import { createWorkspaceConfigLoader } from "./packages/omp-agent/src/adapters/workspaceConfig.js";
import { createOmpProcessFactory } from "./packages/omp-agent/src/adapters/ompProcess.js";
const binary = process.argv[2];
const loader = createWorkspaceConfigLoader(createOmpProcessFactory(binary), cwd);
const state = await loader();
const modelOption = state.configOptions.find((o) => o.id === "model");
console.log(JSON.stringify({ options: modelOption?.options?.length ?? -1, currentValue: modelOption?.currentValue, levels: state.configOptions.filter(o=>o.id==="thought_level").length }));
process.exit(0);
`;
const child = spawn(
  process.execPath,
  [
    join(dirname(createRequire(import.meta.url).resolve("tsx/package.json")), "dist", "cli.mjs"),
    "--eval",
    script,
    "D:\\code1111111111\\forkZcode\\packages\\desktop\\dist\\win-unpacked\\resources\\glm\\omp\\omp.exe",
  ],
  {
    cwd: "D:/code1111111111/forkZcode",
    env: { ...process.env, OMP_RPC_BINARY_PATH: undefined },
    stdio: ["inherit", "inherit", "inherit"],
  },
);
child.on("exit", (code) => console.log("exit", code));

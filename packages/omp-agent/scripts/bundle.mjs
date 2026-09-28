#!/usr/bin/env node

// omp-agent 单文件 bundle（dist/omp-agent.cjs）：dev 与桌面打包共用同一产物。
// 由 Electron 内置 Node（ELECTRON_RUN_AS_NODE）或系统 Node 执行，也作为
// --prepare-storage worker_threads 入口。

import { build } from "esbuild";
import { mkdirSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const packageRoot = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const outfile = resolve(packageRoot, "dist", "omp-agent.cjs");
mkdirSync(dirname(outfile), { recursive: true });

await build({
  entryPoints: [resolve(packageRoot, "src/adapters/cliMain.ts")],
  bundle: true,
  format: "cjs",
  platform: "node",
  // 修复依据：内嵌 omp adapter 由 Electron 28 的 Node 18 子进程执行。
  target: "node18",
  outfile,
  sourcemap: false,
  minify: false,
  legalComments: "none",
  logLevel: "info",
});

console.log(`[omp-agent:bundle] wrote ${outfile}`);

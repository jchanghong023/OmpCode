#!/usr/bin/env node
import { readFile } from "node:fs/promises";
import {
  checkArchitecture,
  changedFilesFromGit,
  formatMarkdownReport,
  formatReport,
  generateContext,
  updateBaseline,
} from "./index.mjs";

const args = process.argv.slice(2);
const command = args[0] ?? "check";
const cwd = process.cwd();

if (command === "context") {
  const moduleId = args[1];
  if (!moduleId) throw new Error("用法: pnpm architecture:context <module-id>");
  console.log(await generateContext({ cwd, moduleId }));
  process.exit(0);
}

const scopeOption = args.indexOf("--changed-files-control");
let changed = null;
if (scopeOption !== -1) {
  const filename = args[scopeOption + 1];
  if (!filename || filename.startsWith("--"))
    throw new Error("--changed-files-control requires a control JSON file");
  // 门禁缓存与执行必须消费同一个文件集合；这里不能再次读取可能不同的 HEAD。
  const control = JSON.parse(await readFile(filename, "utf8"));
  changed = control.stage?.changedFiles;
  if (!Array.isArray(changed) || !changed.every((file) => typeof file === "string"))
    throw new Error("--changed-files-control requires stage.changedFiles: string[]");
} else if (args.includes("--changed")) {
  changed = await changedFilesFromGit(cwd);
}
const result = await checkArchitecture({ cwd, changedFiles: changed });

if (command === "baseline:update") {
  await updateBaseline({ cwd, violations: result.violations });
  console.log(`baseline updated: ${result.violations.length} violations`);
  process.exit(0);
}

if (command === "report") {
  console.log(
    args.includes("--markdown") ? formatMarkdownReport(result) : JSON.stringify(result, null, 2),
  );
  process.exit(result.newViolations.length > 0 ? 1 : 0);
}

console.log(formatReport(result));
process.exit(result.newViolations.length > 0 ? 1 : 0);

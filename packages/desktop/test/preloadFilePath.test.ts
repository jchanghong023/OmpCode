import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";
import ts from "@typescript/typescript6";

// 用实际 preload 函数体验证 Windows 文件路径桥接，不启动应用或读取用户数据。
const preload = readFileSync(new URL("../src/preload/index.ts", import.meta.url), "utf8");
const body = /getPathForFile: \(file: File\): string \| null => \{([\s\S]*?)\n  \},/u.exec(
  preload,
)?.[1];
assert.ok(body, "Expected the production getPathForFile bridge implementation");
const compiled = ts.transpileModule(
  `const resolvePath = (file: File): string | null => {${body}};`,
  {
    compilerOptions: { target: ts.ScriptTarget.ES2022, module: ts.ModuleKind.None },
  },
).outputText;

function bridge(webUtils: { getPathForFile?: (file: object) => string } | undefined) {
  return new Function("webUtils", `${compiled}\nreturn resolvePath;`)(webUtils) as (
    file: object,
  ) => string | null;
}

test("Electron 44 原生 File 无 path 时使用 webUtils", () => {
  const file = {};
  let received: object | undefined;
  const resolvePath = bridge({
    getPathForFile: (value) => {
      received = value;
      return "C:\\temp\\attachment.txt";
    },
  });
  assert.equal(resolvePath(file), "C:\\temp\\attachment.txt");
  assert.equal(received, file);
});

test("无本地路径不能伪装成本地附件", () => {
  assert.equal(bridge(undefined)({}), null);
  assert.equal(bridge(undefined)({ path: 42 }), null);
  assert.equal(bridge(undefined)({ path: "  " }), null);
  assert.equal(bridge({ getPathForFile: () => "" })({ path: "/spoofed/path" }), null);
});

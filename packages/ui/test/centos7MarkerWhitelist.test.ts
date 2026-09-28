import assert from "node:assert/strict";
import { test } from "node:test";
import { readdir, readFile } from "node:fs/promises";
import { fileURLToPath } from "node:url";
import { dirname, join, sep } from "node:path";

/**
 * CentOS 7 构建标记越界扫描（refactor-plan.md W4）：
 * `__OMPCODE_CENTOS7_DESKTOP__` 只允许出现在枚举的封装模块内（lib 封装、Root 视觉策略、
 * MessageResponse 缓冲）。白名单外的模块 import `lib/centos7Desktop` 或直接引用标记字面量
 * 即失败——防止渲染性能策略再次越界成入口隐藏或界面分叉。
 */

const UI_SRC_DIR = join(dirname(fileURLToPath(import.meta.url)), "..", "src");

/** 允许消费 CentOS 7 构建标记的模块（相对 packages/ui/src，统一正斜杠）。 */
const CENTOS7_MARKER_CONSUMER_WHITELIST = new Set([
  "lib/centos7Desktop.ts",
  "Root.tsx",
  "components/ai-elements/message.tsx",
]);

async function collectSourceFiles(dir: string, collected: string[] = []): Promise<string[]> {
  for (const entry of await readdir(dir, { withFileTypes: true })) {
    const fullPath = join(dir, entry.name);
    if (entry.isDirectory()) {
      await collectSourceFiles(fullPath, collected);
    } else if (/\.(ts|tsx)$/.test(entry.name)) {
      collected.push(fullPath);
    }
  }
  return collected;
}

test("CentOS 7 构建标记只出现在白名单封装模块内", async () => {
  const violations: string[] = [];
  for (const fullPath of await collectSourceFiles(UI_SRC_DIR)) {
    const relativePath = fullPath.slice(UI_SRC_DIR.length + sep.length).replaceAll("\\", "/");
    if (CENTOS7_MARKER_CONSUMER_WHITELIST.has(relativePath)) continue;
    const source = await readFile(fullPath, "utf8");
    if (/centos7Desktop/u.test(source) || /__OMPCODE_CENTOS7_DESKTOP__/u.test(source)) {
      violations.push(relativePath);
    }
  }
  assert.deepEqual(
    violations,
    [],
    `以下模块越界引用 CentOS 7 构建标记（只允许 ${[...CENTOS7_MARKER_CONSUMER_WHITELIST].join("、")}）：\n${violations.join("\n")}`,
  );
});

test("白名单模块必须真实存在，防止白名单失效成摆设", async () => {
  for (const relativePath of CENTOS7_MARKER_CONSUMER_WHITELIST) {
    await assert.doesNotReject(readFile(join(UI_SRC_DIR, relativePath), "utf8"), relativePath);
  }
});

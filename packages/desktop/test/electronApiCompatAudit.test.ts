import assert from "node:assert/strict";
import { readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";

// 需求依据：centos7-release.md「Ownership and boundaries」——Electron 44 → 28 的 API 差异面必须
// 维护构建期可检查的清单；新增 Main/Host/renderer 代码不得引入清单外仅 Electron 44 可用的 API。
// 差异清单权威文档：docs/electron-44-28-api-compat.md（W2 审计交付，含双 ABI 实测结论与所有者）。
// 本测试是清单的机器检查面：扫描 Main/Host（Node 18.18 目标）与 renderer（Chromium 120 目标）
// 源码中的禁用 API/语法 token；既有已登记差异进 baseline（带所有者），修复落地后必须移除 baseline。

const repoRoot = fileURLToPath(new URL("../../../", import.meta.url));

interface CompatContext {
  name: string;
  dirs: string[];
  extensions: ReadonlySet<string>;
  forbidden: ReadonlyArray<readonly [label: string, pattern: RegExp]>;
  /** 已登记差异：相对路径（/ 分隔）→ 允许的 token label 列表（均带所有者，见差异清单 §3/§4）。 */
  baseline: Readonly<Record<string, readonly string[]>>;
}

const CONTEXTS: readonly CompatContext[] = [
  {
    name: "main/host (Node 18.18)",
    dirs: [
      "packages/desktop/src/main",
      "packages/desktop/src/host",
      "packages/desktop/src/preload",
      "packages/services/src",
    ],
    extensions: new Set([".ts", ".tsx"]),
    forbidden: [
      ["AbortSignal.any", /AbortSignal\.any\(/g],
      ["Array.fromAsync", /Array\.fromAsync/g],
      ["Promise.try", /Promise\.try\(/g],
      ["Promise.withResolvers", /Promise\.withResolvers\(/g],
      ["Object.groupBy", /Object\.groupBy\(/g],
      ["Map.groupBy", /Map\.groupBy\(/g],
      ["RegExp.escape", /RegExp\.escape\(/g],
      ["Array.prototype.toReversed", /\.toReversed\(/g],
      ["Array.prototype.toSorted", /\.toSorted\(/g],
    ],
    baseline: {
      // 历史登记的 4 处 Node 18.18 破坏点（AbortSignal.any、toReversed ×3）已修复并移出 baseline；
      // 新登记差异须附所有者与修复建议，见 docs/electron-44-28-api-compat.md §3。
    },
  },
  {
    name: "renderer (Chromium 120)",
    dirs: ["packages/desktop/src/renderer", "packages/ui/src"],
    extensions: new Set([".ts", ".tsx", ".css"]),
    forbidden: [
      ["Array.fromAsync", /Array\.fromAsync/g],
      ["Promise.try", /Promise\.try\(/g],
      ["RegExp.escape", /RegExp\.escape\(/g],
      // toSorted/toReversed（Chromium 110）、withResolvers（119）、groupBy（117）在 120 可用，不列。
      ["CSS field-sizing", /field-sizing/g],
      ["CSS scrollbar-width", /scrollbar-width/g],
      ["CSS scrollbar-color", /scrollbar-color/g],
      ["CSS light-dark()", /light-dark\(/g],
      ["CSS anchor-name", /anchor-name/g],
      ["CSS position-anchor", /position-anchor/g],
      ["CSS position-area", /position-area/g],
      ["CSS calc-size()", /calc-size\(/g],
      ["CSS interpolate-size", /interpolate-size/g],
      ["CSS corner-shape", /corner-shape/g],
      ["CSS text-box-trim", /text-box-trim/g],
      ["CSS reading-flow", /reading-flow/g],
    ],
    baseline: {
      // 降级语义（属性被 Chromium 120 忽略）与所有者见 docs/electron-44-28-api-compat.md §4。
      // field-sizing-fixed 在 120 上与默认行为一致（无影响）；field-sizing-content 退化为固定高度。
      // scrollbar-width:none 隐藏失效，滚动条变为系统默认可见样式。
      "packages/ui/src/GitActionMenu.tsx": ["CSS field-sizing"],
      "packages/ui/src/components/ai-elements/prompt-input-textarea.tsx": ["CSS field-sizing"],
      "packages/ui/src/components/ui/textarea.tsx": ["CSS field-sizing"],
      "packages/ui/src/feedback/FeatureRequestDialog.tsx": ["CSS field-sizing"],
      "packages/ui/src/feedback/FeedbackSubmitSections.tsx": ["CSS field-sizing"],
      "packages/ui/src/settings/model-provider-section/ProviderModelMetadataFields.tsx": [
        "CSS field-sizing",
      ],
      "packages/ui/src/settings/model-provider-section/ProviderModelReasoningLevelEditor.tsx": [
        "CSS field-sizing",
      ],
      "packages/ui/src/presentation/presentationPdfPrintExport.ts": ["CSS scrollbar-width"],
      "packages/ui/src/settings/model-provider-section/codingPlanEmbeddedWebview.ts": [
        "CSS scrollbar-width",
      ],
      "packages/ui/src/v4/ConversationDraftSuggestedPrompts.tsx": ["CSS scrollbar-width"],
      "packages/ui/src/styles.css": ["CSS scrollbar-width", "CSS scrollbar-color"],
    },
  },
];

function stripComments(source: string): string {
  return source
    .replace(/\/\*[\s\S]*?\*\//g, (match) => match.replace(/[^\n]/g, " "))
    .replace(/\/\/[^\n]*/g, (match) => " ".repeat(match.length));
}

function walkSources(dir: string, extensions: ReadonlySet<string>): string[] {
  const collected: string[] = [];
  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    const fullPath = join(dir, entry.name);
    if (entry.isDirectory()) {
      collected.push(...walkSources(fullPath, extensions));
    } else if (extensions.has(entry.name.slice(entry.name.lastIndexOf(".")))) {
      collected.push(fullPath);
    }
  }
  return collected;
}

interface Violation {
  file: string;
  line: number;
  token: string;
}

function scanContext(context: CompatContext): {
  violations: Violation[];
  matches: Map<string, Set<string>>;
} {
  const violations: Violation[] = [];
  const matches = new Map<string, Set<string>>();
  for (const dir of context.dirs) {
    for (const fullPath of walkSources(join(repoRoot, dir), context.extensions)) {
      const relativePath = fullPath.slice(repoRoot.length).replace(/\\/g, "/");
      const stripped = stripComments(readFileSync(fullPath, "utf8"));
      for (const [label, pattern] of context.forbidden) {
        const regex = new RegExp(pattern.source, pattern.flags);
        let hit = false;
        for (const match of stripped.matchAll(regex)) {
          hit = true;
          const upToMatch = stripped.slice(0, match.index ?? 0);
          const line = upToMatch.split("\n").length;
          const allowed = context.baseline[relativePath]?.includes(label) ?? false;
          if (!allowed) violations.push({ file: relativePath, line, token: label });
        }
        if (hit) {
          const labels = matches.get(relativePath) ?? new Set<string>();
          labels.add(label);
          matches.set(relativePath, labels);
        }
      }
    }
  }
  return { violations, matches };
}

for (const context of CONTEXTS) {
  test(`Electron 28 兼容扫描：${context.name} 无 baseline 外的 Electron 44 独占 API`, () => {
    const { violations } = scanContext(context);
    assert.deepEqual(
      violations,
      [],
      `发现未登记的 Electron 44 独占/Node 22+ API 使用（登记方式见 docs/electron-44-28-api-compat.md）:\n` +
        violations.map((entry) => `  ${entry.file}:${entry.line} → ${entry.token}`).join("\n"),
    );
  });

  test(`Electron 28 兼容扫描：${context.name} baseline 条目仍然命中（修复后须移除条目）`, () => {
    const { matches } = scanContext(context);
    const stale: string[] = [];
    for (const [relativePath, labels] of Object.entries(context.baseline)) {
      for (const label of labels) {
        if (!matches.get(relativePath)?.has(label)) {
          stale.push(`${relativePath} → ${label}`);
        }
      }
    }
    assert.deepEqual(
      stale,
      [],
      `baseline 条目已无对应命中，请从扫描测试 baseline 移除（回退已落地）:\n` +
        stale.map((entry) => `  ${entry}`).join("\n"),
    );
  });
}

test("Electron 28 兼容扫描：四项已知差异的回退仍然成立", () => {
  // webUtils.getPathForFile（Electron 29+）：preload 必须保留非 webUtils 的 File.path 回退。
  const preload = readFileSync(join(repoRoot, "packages/desktop/src/preload/index.ts"), "utf8");
  assert.ok(
    preload.includes("path?: unknown"),
    "preload getPathForFile 缺少 Electron 28 的 File.path 回退",
  );

  // webContents.navigationHistory（Electron 31+）：全库不得直接使用，历史导航走经典 canGoBack/goBack。
  let navigationHistoryHits = 0;
  for (const dir of [
    "packages/desktop/src/main",
    "packages/desktop/src/preload",
    "packages/desktop/src/host",
  ]) {
    for (const fullPath of walkSources(join(repoRoot, dir), new Set([".ts", ".tsx"]))) {
      if (stripComments(readFileSync(fullPath, "utf8")).includes("navigationHistory")) {
        navigationHistoryHits += 1;
      }
    }
  }
  assert.equal(
    navigationHistoryHits,
    0,
    "main/preload/host 出现 navigationHistory 直接使用：Electron 28 无该 API，须回退经典历史导航",
  );

  // node:sqlite（Node 22.5+）：服务层必须保持双驱动单入口与强制后端注入点。
  const sqliteWrapper = readFileSync(
    join(repoRoot, "packages/services/src/session/tasksDatabase/sqlite.ts"),
    "utf8",
  );
  for (const marker of ["node:sqlite", "better-sqlite3", "OMP_CODE_SQLITE_FORCE_BACKEND"]) {
    assert.ok(sqliteWrapper.includes(marker), `sqlite 封装缺少 ${marker} 双驱动要素`);
  }

  // fs/promises.glob（Node 22+）：SSH 配置扫描必须保留 expandPathGlob 回退。
  const sshAlias = readFileSync(
    join(repoRoot, "packages/services/src/system/sshConfigAlias.ts"),
    "utf8",
  );
  assert.ok(
    sshAlias.includes("nativeGlob ?") && sshAlias.includes("expandPathGlob"),
    "sshConfigAlias 缺少 fs/promises.glob 回退",
  );
});

import type { FileContents, SupportedLanguages } from "@pierre/diffs";
import type { BundledTheme } from "shiki";

function hashCodeViewerContent(code: string): string {
  let hash = 5381;
  for (let index = 0; index < code.length; index += 1) {
    hash = (hash * 33) ^ code.charCodeAt(index);
  }
  return (hash >>> 0).toString(36);
}

export function createCodeViewerFile(params: {
  code: string;
  enableSyntaxHighlighting: boolean;
  language: string;
  theme?: BundledTheme;
}): FileContents {
  const lang = params.enableSyntaxHighlighting
    ? (params.language as SupportedLanguages)
    : ("text" as SupportedLanguages);
  const name = params.language ? `preview.${params.language}` : "preview.txt";
  const themeCacheKey = params.theme ?? "auto";

  return {
    name,
    contents: params.code,
    lang,
    // 流式代码使用 text，不会进入 worker 高亮缓存；逐帧全文 hash 只增加扫描。
    // 无 cacheKey 时库按完整 contents/name/lang 更新；完成态仍保留含主题的缓存键，
    // 避免切换 light/dark 后复用旧 token，同时保留既有高亮缓存行为。
    ...(params.enableSyntaxHighlighting
      ? {
          cacheKey: `${themeCacheKey}:${name}:${lang}:${params.code.length}:${hashCodeViewerContent(params.code)}`,
        }
      : {}),
  };
}

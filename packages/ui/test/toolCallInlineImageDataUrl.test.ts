import assert from "node:assert/strict";
import { test } from "node:test";
import zhCN from "../src/i18n/locales/zh-CN.js";
import enUS from "../src/i18n/locales/en-US.js";
import { toMediaDataUrl } from "../src/lib/mediaDataUrl.js";

test("toolCall 内联图片按 mediaType 与裸 base64 拼 data URL", () => {
  // 回归依据：FileMediaPreview.dataBase64 是裸 base64，直接赋给 <img src> 会被
  // 浏览器当相对 URL 请求而必然 404；必须拼出带 data: 前缀的 URL。
  assert.equal(toMediaDataUrl("image/png", "aGVsbG8="), "data:image/png;base64,aGVsbG8=");
});

test("toolCall 内联图片 data URL 保留带参数与子类型的 mediaType", () => {
  assert.equal(
    toMediaDataUrl("image/svg+xml", "PHN2Zz48L3N2Zz4="),
    "data:image/svg+xml;base64,PHN2Zz48L3N2Zz4=",
  );
});

test("toolCall 内联图片读取失败占位文案在全部 locale 都存在", () => {
  assert.equal(zhCN["chat.toolCall.imageLoadFailed"], "图片加载失败，文件可能已不可读");
  assert.equal(enUS["chat.toolCall.imageLoadFailed"], "Failed to load image");
});

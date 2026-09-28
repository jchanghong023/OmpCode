import assert from "node:assert/strict";
import { chromium } from "playwright-core";

const endpoint = process.env.OMP_E2E_CDP_URL;
assert.ok(endpoint, "Set OMP_E2E_CDP_URL for an isolated Linux desktop instance");

const browser = await chromium.connectOverCDP(endpoint);
try {
  const page = browser
    .contexts()[0]
    ?.pages()
    .find((candidate) => /^(file:|http:\/\/127\.0\.0\.1:)/u.test(candidate.url()));
  assert.ok(page, "Expected an isolated OmpCode renderer page");
  await page.getByRole("button", { name: /^(Settings|设置)$/u }).waitFor({ timeout: 10000 });
  const glyphs = await page.evaluate(async () => {
    await document.fonts.load('64px "OmpCode CJK"', "中文");
    await document.fonts.ready;
    const canvas = document.createElement("canvas");
    canvas.width = 128;
    canvas.height = 128;
    const context = canvas.getContext("2d");
    if (!context) throw new Error("Canvas 2D is unavailable");
    context.fillStyle = "black";
    const draw = (text) => {
      context.clearRect(0, 0, canvas.width, canvas.height);
      context.fillText(text, 8, 80);
      return Array.from(context.getImageData(0, 0, canvas.width, canvas.height).data);
    };
    const distinct = (font) => {
      context.font = `64px ${font}`;
      return String(draw("中")) !== String(draw("文"));
    };
    return {
      uiDistinct: distinct(getComputedStyle(document.body).fontFamily),
      codeDistinct: distinct(
        getComputedStyle(document.documentElement).getPropertyValue("--font-mono"),
      ),
    };
  });
  assert.ok(glyphs.uiDistinct, "Chinese UI characters must not render as missing-font boxes");
  assert.ok(glyphs.codeDistinct, "Chinese monospace text must not render as missing-font boxes");
  console.log("Linux desktop Chinese glyphs rendered distinctly without host CJK fonts");
} finally {
  await browser.close();
}

const { appendFile, readFile, writeFile } = require("node:fs/promises");

// Windows 读者打开证据文件时替换可能 EPERM；单写者追加完整行，不替换正在读取的文件。
async function appendIsolationEvidence(path, state) {
  await appendFile(path, `${JSON.stringify(state)}\n`, "utf8");
}

async function readIsolationEvidence(path) {
  const text = await readFile(path, "utf8");
  const end = text.lastIndexOf("\n");
  if (end < 0) throw new Error("No complete native-window isolation evidence");
  const start = text.lastIndexOf("\n", end - 1) + 1;
  return JSON.parse(text.slice(start, end));
}

// 同一隐藏 Electron 通过 native capturePage 产出 PNG；不使用等待可见合成面的 CDP 截图。
async function captureIsolationScreenshot(path, endpoint = process.env.OMP_E2E_SCREENSHOT_URL) {
  if (!endpoint) throw new Error("Missing isolated Electron screenshot endpoint");
  const response = await fetch(endpoint);
  if (!response.ok) throw new Error(`Native screenshot failed: ${await response.text()}`);
  const png = Buffer.from(await response.arrayBuffer());
  if (!png.subarray(0, 8).equals(Buffer.from([137, 80, 78, 71, 13, 10, 26, 10])))
    throw new Error("Native screenshot endpoint did not return a PNG");
  await writeFile(path, png);
}

module.exports = { appendIsolationEvidence, readIsolationEvidence, captureIsolationScreenshot };

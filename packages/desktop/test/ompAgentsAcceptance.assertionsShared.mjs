// omp agents GUI 验收断言的会话驱动原语（自 ompAgentsAcceptance.assertions.mjs 拆出，架构 maxFileLines=400）：
// 轮询等待、mock 门闸释放、输入提交与回执确认只做真实页面交互，被各断言分组共享。
import assert from "node:assert/strict";

export async function eventually(read, accept, description, timeout = 90_000) {
  const deadline = Date.now() + timeout;
  let value;
  do {
    value = await read();
    if (accept(value)) return value;
    await new Promise((resolve) => setTimeout(resolve, 100));
  } while (Date.now() < deadline);
  assert.fail(`${description}: ${JSON.stringify(value)}`);
}
export async function control(runtime, gate) {
  const response = await fetch(runtime.mock.controlUrl, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ type: "release", gate }),
  });
  assert.equal(response.status, 200, await response.text());
}
export async function submit(page, prompt) {
  await page.getByTestId("v4-composer-input").fill(prompt);
  await page.getByTestId("v4-composer-send").click();
}
export async function acknowledge(page, marker) {
  await page.getByText(marker, { exact: true }).waitFor({ state: "visible", timeout: 90_000 });
  // 中文原因：后台子代理运行时父会话 canStop 仍为真，输入区按设计把发送键换成“停止”
  // （ConversationComposer: showStopControl = canStop && !hasDraftToSubmit，只有存在草稿时才显示
  // 发送键；空输入区的真实控件是停止）。所以“发送键可见”不是有效就绪信号，这里等真实输入框可用。
  const input = page.getByTestId("v4-composer-input");
  await input.waitFor({ state: "visible" });
  assert.equal(
    await input.isEnabled(),
    true,
    "The composer input must stay usable for the next step",
  );
}

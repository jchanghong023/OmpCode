import { inspect } from "node:util";

// 原生 TAP 会按文件/用例顺序缓冲，后发生的失败可被前面挂起的用例遮挡。
// stdout 保留 TAP；stderr 用 Node 执行完成事件立即发送完整原始断言。
const failurePrefix = "\u001eOMP_TEST_FAILURE ";

export function immediateTestArguments(args) {
  args = args.filter((arg) => !/^--test-reporter(?:-destination)?=/u.test(arg));
  const index = args.indexOf("--test") + 1;
  return [
    ...args.slice(0, index),
    "--test-reporter=tap",
    "--test-reporter-destination=stdout",
    `--test-reporter=${new URL("./test-gates-test-reporter.mjs", import.meta.url).href}`,
    "--test-reporter-destination=stderr",
    ...args.slice(index),
  ];
}

export default async function* testGateReporter(source) {
  const activeNames = new Map();
  let reported = false;
  for await (const { type, data } of source) {
    if (reported || (type !== "test:enqueue" && type !== "test:complete")) continue;
    const scope = data.entryFile ?? data.file;
    const key = typeof data.testId === "number" ? `${scope}\0${data.testId}` : undefined;
    if (type === "test:enqueue" && key !== undefined) {
      const parent = activeNames.get(`${scope}\0${data.parentId}`);
      activeNames.set(key, parent ? `${parent} > ${data.name}` : data.name);
      continue;
    }
    if (type !== "test:complete") continue;
    const fullName = activeNames.get(key) ?? data.name;
    activeNames.delete(key);
    if (
      data.details?.passed !== false ||
      (data.todo !== undefined && data.todo !== false) ||
      (data.skip !== undefined && data.skip !== false)
    ) {
      continue;
    }
    reported = true;
    activeNames.clear();
    yield `${failurePrefix}${JSON.stringify({
      version: 1,
      name: data.name,
      fullName,
      file: data.file,
      line: data.line,
      column: data.column,
      failureType: data.details.error?.failureType,
      error: inspect(data.details.error, {
        depth: null,
        colors: false,
        customInspect: false,
        maxArrayLength: null,
        maxStringLength: null,
      }),
    })}\n`;
  }
}

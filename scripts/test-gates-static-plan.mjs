// 静态阶段独立维护，避免完整测试计划随入口契约扩展超过文件边界；范围与原语不变。
export const pnpm = (id, args, extra = {}) => ({
  id,
  command: "pnpm",
  args,
  kind: "check",
  ...extra,
});

export const staticPlan = (all) => [
  pnpm("typecheck", ["typecheck", "--stopBuildOnErrors"], { kind: "compile" }),
  pnpm("lint", ["lint"]),
  pnpm("formal-proof-typecheck", ["--filter", "@zcode/formal-proof", "typecheck"], {
    kind: "compile",
  }),
  pnpm("formal-proof-lint", ["--filter", "@zcode/formal-proof", "lint"]),
  pnpm(all ? "architecture-all" : "architecture-changed", [
    "architecture:check",
    ...(all ? [] : ["--changed"]),
  ]),
  ...(all
    ? [pnpm("format-all", ["fmt:check"]), pnpm("unused-dependencies-exports", ["knip"])]
    : []),
];

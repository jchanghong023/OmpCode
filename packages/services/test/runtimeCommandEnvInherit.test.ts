import assert from "node:assert/strict";
import test from "node:test";
import { buildRuntimeProcessEnvPatch } from "../src/runtime-tools/runtimeCommandEnv.js";

// CentOS 7 IBus 会话对齐（分支 07a4f44/931abda 的纯逻辑部分）：
// 输入法守护进程状态目录经 XDG_STATE_HOME 传递；Bash/终端工具子进程必须继承它，
// 否则容器/SSH 场景下 GUI 内终端与 ibus 会话脱钩。同时防止宽继承回潮（NODE_OPTIONS 等）。

test("login shell 快照中的 XDG_STATE_HOME 进入运行时环境补丁", () => {
  const patch = buildRuntimeProcessEnvPatch(
    { PATH: "/usr/bin:/bin" },
    {
      PATH: "/home/u/.nvm/versions/node/v24/bin:/usr/bin:/bin",
      XDG_CONFIG_HOME: "/home/u/.config",
      XDG_DATA_HOME: "/home/u/.local/share",
      XDG_CACHE_HOME: "/home/u/.cache",
      XDG_STATE_HOME: "/home/u/.local/state",
      TERM: "xterm-256color",
    },
    { platform: "linux" },
  );
  assert.equal(patch.XDG_STATE_HOME, "/home/u/.local/state");
  assert.equal(patch.XDG_CONFIG_HOME, "/home/u/.config");
  assert.equal(patch.XDG_DATA_HOME, "/home/u/.local/share");
  assert.equal(patch.XDG_CACHE_HOME, "/home/u/.cache");
  assert.equal(patch.TERM, "xterm-256color");
});

test("快照外的白名单变量不进入补丁，NODE_OPTIONS 不因 XDG_STATE_HOME 加入而回潮", () => {
  const patch = buildRuntimeProcessEnvPatch(
    { PATH: "/usr/bin:/bin", NODE_OPTIONS: "--inspect" },
    { PATH: "/usr/bin:/bin", XDG_STATE_HOME: "/home/u/.local/state" },
    { platform: "linux" },
  );
  assert.equal(patch.XDG_STATE_HOME, "/home/u/.local/state");
  assert.equal(patch.NODE_OPTIONS, undefined);
});

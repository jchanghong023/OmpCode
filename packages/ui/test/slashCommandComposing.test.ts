// Fork（omp-project-mode.md）：slash 命令编辑态（命令名后已带空白）判定。
// 回归背景：旧正则要求空格后紧跟非空白字符，`/cmd `（刚敲空格）与 `/cmd  a`
//（连续空格）都不进入编辑态，OMP 在这两种形态下提供的参数级补全被整体关闭。
import { test } from "node:test";
import assert from "node:assert/strict";
import { slashComposingQueryOf } from "../src/slashCommandHelpers.js";

test("命令名后出现空白即进入参数补全编辑态", () => {
  assert.equal(slashComposingQueryOf("/help "), "help ");
  assert.equal(slashComposingQueryOf("/help --"), "help --");
  // 连续空格与多参数：仍以最后一个词为过滤词（由调用方 slice 决定），编辑态保持。
  assert.equal(slashComposingQueryOf("/help  a"), "help  a");
  assert.equal(slashComposingQueryOf("/security --verbose ver"), "security --verbose ver");
});

test("非编辑态：无空白、非斜杠开头、多行输入", () => {
  assert.equal(slashComposingQueryOf("/help"), null);
  assert.equal(slashComposingQueryOf("/"), null);
  assert.equal(slashComposingQueryOf(""), null);
  assert.equal(slashComposingQueryOf("hello /help "), null);
  assert.equal(slashComposingQueryOf("/first line\n/help "), null);
});

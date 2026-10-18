import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { readFile, writeFile } from "node:fs/promises";
import { join } from "node:path";

const PRIMARY = "zcode-mock/scripted";
const ALTERNATE = "zcode-mock/scripted-alt";
const usage = { input: 16, output: 8, cacheRead: 0, cacheWrite: 0 };
export const textOf = (content) =>
  typeof content === "string"
    ? content
    : (content ?? [])
        .filter((part) => part.type === "text")
        .map((part) => part.text)
        .join("\n");
export function promptOf(content) {
  return textOf(content)
    .trim()
    .replace(
      /^<system-reminder>\nToday: \d{4}-\d{2}-\d{2}; current working directory: '[^\r\n]+?'\. Do not repeat this information in your reply\.\n<\/system-reminder>\n{1,2}/u,
      "",
    );
}

export async function prepareSuite({ root, workspace, configRoot, phase }) {
  assert.ok(["live", "profile", "default"].includes(phase));
  const marker = createHash("sha256").update(root).digest("hex").slice(0, 16);
  const turns = {
    live: [
      { key: "FIRST", model: "scripted", effort: "high", afterSwitch: "max" },
      { key: "HOLD", model: "scripted", effort: "high", retainSelection: true },
      { key: "SECOND", model: "scripted-alt", effort: "high", afterSwitch: "high" },
      { key: "THIRD", model: "scripted", effort: "max", afterSwitch: "max" },
      { key: "FOURTH", model: "scripted", effort: "high", afterSwitch: "max" },
    ],
    profile: [{ key: "PROFILE", model: "scripted-alt", effort: "high", retainSelection: true }],
    default: [{ key: "RETURN", model: "scripted", effort: "high", retainSelection: true }],
  };
  const turn = (entry) => ({
    ...entry,
    prompt: `MODELS_${marker}_${entry.key}`,
    reply: `MODELS_REPLY_${marker}_${entry.key}`,
  });
  const allTurns = Object.fromEntries(
    Object.entries(turns).map(([key, entries]) => [key, entries.map(turn)]),
  );
  const expected = allTurns[phase];
  let completed = 0;
  return {
    manifest: {
      marker,
      workspace,
      configRoot,
      profile: "acceptance",
      turns: allTurns,
      defaultAgent: join(configRoot, "agent"),
      profileAgent: join(configRoot, "profiles", "acceptance", "agent"),
      defaultModelNames: ["ZCode Mock", "ZCode Mock Alt"],
      profileModelNames: ["ZCode Mock Acceptance Profile", "ZCode Mock Alt Acceptance Profile"],
    },
    async prepare(mock) {
      await mock.writeConfig(configRoot, {
        profile: "acceptance",
        defaultModel: ALTERNATE,
        preserveConfig: phase !== "live",
        input: ["text", "image"],
      });
      if (phase === "live") {
        // 只写初始配置；历史和任务索引必须全部由 GUI + 真实 OMP 创建。
        for (const [agent, defaults] of [
          [join(configRoot, "agent"), PRIMARY],
          [join(configRoot, "profiles", "acceptance", "agent"), `${ALTERNATE}:high`],
        ]) {
          const file = join(agent, "config.yml");
          const config = JSON.parse(await readFile(file, "utf8"));
          config.modelRoles.default = defaults;
          if (defaults !== PRIMARY) config.modelRoles.task = `${PRIMARY}:high`;
          await writeFile(
            file,
            `${JSON.stringify(config, null, 2)}\n# models-acceptance-preserve-${marker}\n`,
          );
        }
      }
      // 每次只刷新本 fixture 的目录输入名称，绝不重写 live 保存的角色。
      const modelFile = join(configRoot, "profiles", "acceptance", "agent", "models.yml");
      const models = JSON.parse(await readFile(modelFile, "utf8"));
      for (const model of models.providers["zcode-mock"].models) {
        assert.ok(["scripted", "scripted-alt"].includes(model.id));
        model.name =
          model.id === "scripted"
            ? "ZCode Mock Acceptance Profile"
            : "ZCode Mock Alt Acceptance Profile";
      }
      assert.equal(models.providers["zcode-mock"].models.length, 2);
      await writeFile(modelFile, `${JSON.stringify(models, null, 2)}\n`);
    },
    handler(context, options) {
      const next = expected[completed];
      assert.ok(next, "No extra model request is permitted in this phase");
      assert.equal(options.modelId, next.model, "HTTP model must match the selected GUI model");
      const users = context.messages.filter((message) => message.role === "user");
      const history =
        phase === "default" ? [...allTurns.live, next] : expected.slice(0, completed + 1);
      assert.deepEqual(
        users.map((message) => promptOf(message.content)),
        history.map((entry) => entry.prompt),
      );
      assert.deepEqual(
        context.messages
          .filter((message) => message.role === "assistant")
          .map((message) => textOf(message.content)),
        history.slice(0, -1).map((entry) => entry.reply),
        "Continuation must retain this exact conversation, not start another session",
      );
      assert.ok(
        context.messages.every(
          (message) =>
            typeof message.content === "string" ||
            message.content.every((part) => part.type === "text" || part.type === "thinking"),
        ),
        "Models-only acceptance must not receive hidden tool calls/results",
      );
      completed++;
      return { content: [next.reply], usage };
    },
    snapshot: () => ({ phase, completed, expected: expected.length }),
  };
}

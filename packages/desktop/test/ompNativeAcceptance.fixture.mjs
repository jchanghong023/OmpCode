import assert from "node:assert/strict";
import { dirname } from "node:path";
import { nativeInputs, prepareNativeInputs } from "./ompNativeAcceptance.inputs.mjs";
import { nativePromptConfigPath, queryNativeCatalog } from "./ompNativeAcceptance.catalog.mjs";
import { checkedArgs, schemaOf } from "./ompAgentsAcceptance.protocol.mjs";
import { createRepoScenarioReader } from "./ompNativeAcceptance.repoScenarios.mjs";
import { createTeamFixture } from "./ompNativeAcceptance.teamFixture.mjs";

const textOf = (content) =>
  typeof content === "string"
    ? content
    : Array.isArray(content)
      ? content
          .filter((part) => part.type === "text")
          .map((part) => part.text)
          .join("\n")
      : "";
const promptOf = (content) =>
  textOf(content).replace(
    /^<system-reminder>\nToday: \d{4}-\d{2}-\d{2}; current working directory: '[^\r\n]+'\. Do not repeat this information in your reply\.\n<\/system-reminder>\n{1,2}/u,
    "",
  );
const usage = { input: 32, output: 24, cacheRead: 0, cacheWrite: 0 };
const answer = (text) => ({ content: [text], usage });

export async function prepareSuite({ root, workspace, configRoot, phase }) {
  assert.ok(["live", "recovery"].includes(phase));
  const inputs = nativeInputs(workspace, configRoot);
  const { marker, paths, values, skills } = inputs;
  const state = {
    phase,
    catalog: [],
    issued: [],
    completed: [],
    finiteTurns: 0,
    stopTurns: 0,
  };
  const readRepoScenario = createRepoScenarioReader(values);
  const pending = new Map();
  const seen = new Set();
  let nextId = 0;
  const issue = (context, key, name, args, expected, done, failed = false, detail = {}) => {
    checkedArgs(schemaOf(context, name), args, name);
    assert.ok(!seen.has(key), `Duplicate initial model turn: ${key}`);
    seen.add(key);
    const id = `native_${++nextId}_${name}`;
    // Terminal yield has no model callback; its actual completion is proved from the journal.
    if (name !== "yield") pending.set(id, { key, name, args, expected, done, failed, ...detail });
    state.issued.push({ id, key, name, args, ...detail });
    return { usage, content: [{ type: "toolCall", id, name, arguments: args }] };
  };
  const team = createTeamFixture({
    readPath: paths.read,
    readEvidence: values.read,
    task: values.team,
    issued: state.issued,
    issue,
    answer,
  });
  async function handler(context, options) {
    assert.ok(Array.isArray(context.messages) && context.messages.length > 0);
    assert.ok(
      ["scripted", "scripted-alt"].includes(options.modelId),
      "Only the two explicitly isolated local models are allowed",
    );
    if (phase === "recovery") throw new Error("Cold native history must not invoke any model");
    const last = context.messages.at(-1);
    const results =
      last.role === "user" && Array.isArray(last.content)
        ? last.content.filter((part) => part.type === "tool_result")
        : [];
    if (results.length) {
      assert.equal(
        results.length,
        1,
        "One exact outstanding native tool result per scripted request",
      );
      const result = results[0];
      const invocation = pending.get(result.tool_use_id);
      assert.ok(invocation, `Unknown/replayed tool result ${result.tool_use_id}`);
      const calls = context.messages
        .filter((message) => message.role === "assistant")
        .flatMap((message) => (Array.isArray(message.content) ? message.content : []))
        .filter((part) => part.type === "tool_use" && part.id === result.tool_use_id);
      assert.equal(
        calls.length,
        1,
        "Result must correlate to this conversation, not another Team member",
      );
      assert.equal(calls[0].name, invocation.name);
      assert.deepEqual(calls[0].input, invocation.args);
      assert.equal(
        result.is_error,
        invocation.failed,
        `Unexpected real ${invocation.name} outcome: ${textOf(result.content)}`,
      );
      const output = textOf(result.content);
      if (invocation.repoDocs) {
        assert.match(output, /^# repo — Repo$/mu);
        assert.ok(output.includes("type Args ="), "Read must return the actual device schema");
        for (const field of ["action", "query", "path", "cursor"])
          assert.ok(output.includes(field));
        assert.ok(output.includes("Execute by writing JSON to xd://repo."));
      } else if (invocation.repo?.unavailable) {
        // 缺索引是设备公开的 missing 结果，不是 tool error，更不能冒充空查询成功。
        assert.equal(
          output,
          "No repository index exists. Open /repo to build one; use read/grep for current files meanwhile.",
        );
      } else if (invocation.repo?.missing) {
        assert.equal(
          output,
          `Text for "${invocation.repo.query}": 0 hit(s) on this page\nNo indexed matches. Try another query or use grep for exhaustive/current file coverage.`,
        );
        assert.doesNotMatch(output, /NATIVE_REPO_SENTINEL_731|NATIVE_REPO_UPDATED_732/u);
      } else {
        assert.ok(
          output.includes(invocation.expected),
          `Actual ${invocation.name} output lacks ${invocation.expected}`,
        );
        if (invocation.repo) {
          assert.match(
            output,
            new RegExp(
              `^Text for "${invocation.repo.query}": [1-9]\\d* hit\\(s\\) on this page`,
              "u",
            ),
          );
          assert.match(output, /^\[\d+\] native-code\/timing\.mjs:\d+-\d+ \[[^\]]+\] .+/mu);
          assert.ok(
            output.includes(invocation.repo.content),
            "The actual indexed snippet must contain the exact current source, not just its path/query",
          );
        }
      }
      pending.delete(result.tool_use_id);
      state.completed.push({
        id: result.tool_use_id,
        key: invocation.key,
        output,
        isError: result.is_error,
      });
      if (invocation.key.startsWith("team-read-"))
        return team.complete(context, invocation, output, result.tool_use_id);
      if (invocation.repoDocs)
        return issue(
          context,
          invocation.repoDocs.key,
          "write",
          {
            i: "Searching genuine repository device",
            path: "xd://repo",
            content: JSON.stringify({ action: "search", query: invocation.repoDocs.query }),
          },
          invocation.repoDocs.symbol,
          invocation.done,
          false,
          { repo: invocation.repoDocs },
        );
      if (invocation.repo?.symbol)
        return issue(
          context,
          `${invocation.key}-file`,
          "read",
          { i: "Reading indexed source evidence", path: paths.code },
          invocation.repo.content,
          invocation.done,
        );
      return answer(invocation.done);
    }
    assert.ok(last.role === "user", "Unsolicited non-user model continuation");
    const prompt = promptOf(last.content);
    const teamTitle = team.title(context, prompt);
    if (teamTitle) return teamTitle;
    const users = context.messages
      .filter((message) => message.role === "user")
      .map((message) => promptOf(message.content));
    for (const part of Array.isArray(last.content) ? last.content : [])
      assert.notEqual(part.type, "image", "Native fixture has no submitted image");
    if (prompt.includes(values.draft)) {
      assert.ok(!seen.has("attachment"), "Draft attachment must be consumed exactly once");
      assert.ok(
        prompt.includes(values.attachment),
        "Actual model request must contain real text attachment bytes",
      );
      const selected = skills.find(
        (skill) => skill.name === "native-project" && skill.scope === "project",
      );
      assert.ok(
        prompt.includes(`"${selected.name}" skill`) &&
          prompt.includes(selected.sentinel) &&
          prompt.includes(`[Skill directory: ${dirname(selected.path)}]`),
        "OMP must expand the migrated rich skill from its exact selected source",
      );
      assert.ok(prompt.includes("draft-argument-731"));
      seen.add("attachment");
      return answer("NATIVE_ATTACHMENT_CONSUMED_731");
    }
    for (const name of ["before", "after"]) {
      if (prompt === `NATIVE_SKILL_${name.toUpperCase()}_731`) {
        assert.ok(!seen.has(name), `Repeated ${name} turn`);
        if (name === "after")
          assert.ok(
            users.some((input) => input.includes("skill-argument-731")),
            "After turn must retain actual skill history",
          );
        seen.add(name);
        return answer(`NATIVE_SKILL_${name.toUpperCase()}_REPLY_731`);
      }
    }
    // OMP expands the selected token before the HTTP request; the current expanded body,
    // not a /skill token or a skill from older messages, identifies this invocation.
    const bodySkill = skills.find((skill) => prompt.includes(skill.sentinel));
    if (bodySkill) {
      const skill = bodySkill.name;
      const argumentsBySkill = {
        "native-project": "skill-argument-731",
        "native-user": "skill-user-731",
        "native-shared": "skill-shared-731",
        "native-collision": "skill-collision-731",
      };
      assert.ok(
        prompt.includes(argumentsBySkill[skill]),
        "OMP must preserve exact skill arguments",
      );
      const scope = {
        "native-project": "project",
        "native-user": "user",
        "native-shared": "shared",
        "native-collision": "shared",
      }[skill];
      const selected = skills.find((item) => item.name === skill && item.scope === scope);
      assert.ok(
        prompt.includes(`"${selected.name}" skill`) &&
          prompt.includes(selected.sentinel) &&
          prompt.includes(`[Skill directory: ${dirname(selected.path)}]`),
        "Each invocation must expand the exact current resolved skill and source directory",
      );
      const injected = JSON.stringify(context.messages);
      assert.ok(injected.includes(selected.sentinel), "OMP must inject the selected skill body");
      for (const shadow of skills.filter(
        (item) => item.name === skill && item.path !== selected.path,
      ))
        assert.ok(
          !injected.includes(shadow.sentinel),
          "Shadowed skill body must never be executed",
        );
      return issue(
        context,
        `skill-${skill}`,
        "read",
        { i: "Reading invoked skill evidence", path: paths.read },
        values.read.trim(),
        `${skill.toUpperCase().replaceAll("-", "_")}_READ_DONE_731`,
      );
    }
    const scenario = readRepoScenario(prompt);
    if (scenario) {
      return issue(
        context,
        `${scenario.key}-docs`,
        "read",
        { i: "Reading repository device contract", path: "xd://repo" },
        "Execute by writing JSON to xd://repo.",
        scenario.done,
        false,
        { repoDocs: scenario },
      );
    }
    if (prompt.includes(values.goal)) {
      assert.ok(!seen.has("goal"), "Goal setup must have one explicit model execution");
      seen.add("goal");
      return answer("NATIVE_GOAL_READY_731");
    }
    if (prompt.includes(values.loop)) {
      assert.ok(!prompt.includes(values.stopLoop));
      assert.ok(++state.finiteTurns <= 3, "Finite loop exceeded initial turn plus two repeats");
      return answer(`NATIVE_LOOP_ITERATION_${state.finiteTurns}_731`);
    }
    if (prompt.includes(values.stopLoop)) {
      assert.equal(
        ++state.stopTurns,
        1,
        "Stopped loop must never auto-retry or leak into another session",
      );
      await new Promise((resolveAbort) => {
        assert.ok(options.signal, "Use the real HTTP cancellation signal");
        if (options.signal.aborted) return resolveAbort();
        options.signal.addEventListener("abort", resolveAbort, { once: true });
      });
      return answer("FORBIDDEN_LATE_LOOP_REPLY_731");
    }
    const teamRead = team.read(context, prompt);
    if (teamRead) return teamRead;
    if (prompt === "NATIVE_ISOLATION_PROBE_731") {
      assert.ok(!seen.has("isolation"));
      assert.ok(
        !JSON.stringify(context.messages).includes(values.stopLoop),
        "Loop state leaked to another session",
      );
      seen.add("isolation");
      return answer("NATIVE_ISOLATION_REPLY_731");
    }
    throw new Error(`Unknown/extra native model request: ${JSON.stringify(prompt)}`);
  }
  return {
    handler,
    env: { OMP_SKILLS_DIR: paths.shared, OMP_WIKI_DIR: paths.wiki },
    rpcArgs: ["--config", nativePromptConfigPath(configRoot)],
    async prepare() {
      if (phase === "live") await prepareNativeInputs(workspace, configRoot, inputs);
      state.catalog = await queryNativeCatalog({
        root,
        workspace,
        configRoot,
        env: { OMP_SKILLS_DIR: paths.shared, OMP_WIKI_DIR: paths.wiki },
      });
      for (const name of ["native-project", "native-user", "native-shared", "native-collision"])
        assert.equal(
          state.catalog.filter((item) => item.name.replace(/^skill:/u, "") === name).length,
          1,
          `Real catalog missing/doubled ${name}`,
        );
      assert.equal(
        state.catalog.find((item) => item.name === "skill:native-collision").description,
        `${marker} shared native-collision`,
      );
    },
    snapshot: () => ({ ...state, pending: [...pending.keys()] }),
    manifest: {
      marker,
      paths,
      values,
      skills,
      expectedSkillNames: ["native-project", "native-user", "native-shared", "native-collision"],
    },
  };
}

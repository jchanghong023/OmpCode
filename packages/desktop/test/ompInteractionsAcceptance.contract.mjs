import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { checkedArgs } from "./ompAgentsAcceptance.protocol.mjs";

export const UI_TOOL = "acceptance_ui_probe";
export const QUESTION = "Choose the database for this identical question";
// 探针只覆盖真实可得的扩展输入面：`ctx.ui.input`（单行）与 `ctx.ui.editor`（多行/prefill）。
// 证据（2026-10-18 实测本机 omp.exe `--mode rpc-ui`，扩展传 {sensitive:true}）：
// 线上帧仅 {"method":"input","title":…,"placeholder":…} / {"method":"editor","title":…,"prefill":…}，
// OMP 的 ExtensionUIDialogOptions 无 sensitive 字段、rpc-mode 也不转发它，宿主无从渲染密码框，
// 故不再虚构「敏感输入」探针；宿主侧 sensitive 投影保留为前向兼容。
export const PROBES = [
  "input-submit",
  "input-cancel",
  "editor-submit",
  "editor-cancel",
  "editor-empty-submit",
  "editor-empty-cancel",
];
export const LIVE_CASES = ["ask-rich", "ask-cancel", "ask-timeout", ...PROBES];
export const hash = (value) => createHash("sha256").update(value).digest("hex");
export const promptFor = (name, nonce) => `ZCODE_INTERACTIONS ${name} ${nonce}`;
export const markerFor = (name, nonce) =>
  `INTERACTIONS_${name.toUpperCase().replaceAll("-", "_")}_${nonce}`;
export const callIdFor = (name, nonce) => `interactions_${name.replaceAll("-", "_")}_${nonce}`;

// OMP 向扩展的真实 advertised schema 加入必填 i（concise intent）；发起与持久验收共用实参。
export const probeArguments = (name) => ({ i: "Exercising native extension UI", case: name });

export function probeSpec(name, nonce) {
  assert.ok(PROBES.includes(name), `Unknown extension probe: ${name}`);
  const editor = name.includes("editor");
  const cancelled = name.endsWith("-cancel");
  const empty = name.startsWith("editor-empty-");
  const title = `Acceptance ${name} ${nonce}`;
  // editor 是多行文本：用换行 + 首尾空白证明逐字节保留。
  // input 是单行 <input>：取值清洗会丢弃换行，只用首尾空白证明不裁剪。
  const prefill = editor && !empty ? `  original ${nonce}\nsecond original line  \n` : undefined;
  const value = empty
    ? ""
    : editor
      ? `  changed ${nonce}\nsecond changed line  \n`
      : `  changed ${nonce}  `;
  return { name, title, editor, cancelled, prefill, value };
}

export function probeResult(spec) {
  return spec.cancelled
    ? { case: spec.name, cancelled: true }
    : {
        case: spec.name,
        cancelled: false,
        sha256: hash(spec.value),
        bytes: Buffer.byteLength(spec.value),
      };
}

// 只解释 HTTP advertised ask 参数；未暴露可调参数时保留 core 默认 deadline，不臆造 UI 帧字段。
export function askTimeout(schema) {
  const fields = Object.entries(schema.properties ?? {}).filter(
    ([name, field]) =>
      /timeout|deadline|time[\s_-]*limit/iu.test(name) ||
      (["number", "integer"].includes(field.type) &&
        /timeout|deadline|time[\s_-]*limit/iu.test(field.description ?? "")),
  );
  if (fields.length === 0) return null;
  assert.equal(fields.length, 1, "An advertised timeout parameter must have unambiguous semantics");
  const [field, definition] = fields[0];
  assert.ok(
    ["number", "integer"].includes(definition.type),
    "An advertised ask timeout must be a numeric relative duration",
  );
  const name = field
    .replace(/([a-z])([A-Z])/gu, "$1 $2")
    .replaceAll("_", " ")
    .replaceAll("-", " ");
  const wording = [
    name,
    definition.title,
    definition.description,
    definition.unit,
    definition.units,
  ]
    .filter((part) => part !== undefined)
    .join(" ");
  assert.doesNotMatch(
    wording,
    /epoch|timestamp|unix|absolute/iu,
    "An absolute deadline is not a relative timeout",
  );
  const units = [
    ["milliseconds", 1, /\b(?:ms|milliseconds?)\b/iu],
    ["seconds", 1000, /\b(?:s|secs?|seconds?)\b/iu],
    ["minutes", 60_000, /\b(?:mins?|minutes?)\b/iu],
  ].filter(([, , expression]) => expression.test(wording));
  assert.equal(
    units.length,
    1,
    `Ask timeout ${field} must state exactly one known unit; unknown/ambiguous units are rejected`,
  );
  const [unit, scale] = units[0];
  // 优先选 12 秒，仍尊重真实公开边界/枚举；不额外要求 API 必须允许某个测试自定区间。
  const bounds = [
    12_000 / scale,
    definition.default,
    definition.minimum,
    definition.maximum,
    definition.exclusiveMinimum,
    definition.exclusiveMaximum,
  ].filter(Number.isFinite);
  const step = definition.multipleOf ?? (definition.type === "integer" ? 1 : undefined);
  const candidates =
    definition.const !== undefined
      ? [definition.const]
      : (definition.enum ??
        bounds.flatMap((value) =>
          step === undefined
            ? [value]
            : [
                value,
                Math.ceil(value / step) * step,
                Math.floor(value / step) * step,
                (Math.floor(value / step) + 1) * step,
                (Math.ceil(value / step) - 1) * step,
              ],
        ));
  const legal = (value) =>
    Number.isFinite(value) &&
    Number.isFinite(value * scale) &&
    value > 0 &&
    (definition.type !== "integer" || Number.isInteger(value)) &&
    (definition.minimum === undefined || value >= definition.minimum) &&
    (definition.maximum === undefined || value <= definition.maximum) &&
    (definition.exclusiveMinimum === undefined || value > definition.exclusiveMinimum) &&
    (definition.exclusiveMaximum === undefined || value < definition.exclusiveMaximum) &&
    (definition.multipleOf === undefined ||
      Math.abs(value / definition.multipleOf - Math.round(value / definition.multipleOf)) < 1e-9);
  const value = candidates.find(legal);
  assert.notEqual(
    value,
    undefined,
    "An advertised timeout parameter must permit a finite enabled duration",
  );
  checkedArgs(definition, value, `ask.${field}`);
  return { field, unit, value, milliseconds: value * scale };
}

export function askArguments(name, nonce, schema) {
  assert.ok(
    schema?.properties,
    "Every ask intent requires the real advertised input_schema/parameters",
  );
  // 真实 OMP advertised schema 要求顶层 i（concise intent）；遗漏会让本地模型
  // 在发出 ask 意图前返回 HTTP 400，后续 DOM 等待不能证明题卡或 role 有错。
  let args;
  if (name === "ask-timeout") {
    const timeout = askTimeout(schema);
    args = {
      i: "Waiting for recommendation deadline",
      questions: [
        {
          id: `${nonce}_deadline`,
          question: `Timeout recommendation ${nonce}`,
          options: [
            { label: "SQLite", description: "Timeout must choose this recommendation" },
            { label: "Postgres", description: "Must not be chosen without user input" },
          ],
          recommended: 0,
        },
      ],
      ...(timeout ? { [timeout.field]: timeout.value } : {}),
    };
  } else {
    assert.ok(name === "ask-rich" || name === "ask-cancel");
    args = {
      i: "Choosing database options",
      questions: ["primary", "secondary"].map((key) => ({
        id: `${nonce}_${key}`,
        question: QUESTION,
        header: `${key} database`,
        multi: true,
        options: [
          {
            label: "Postgres",
            description: `${key} PostgreSQL option`,
            preview: `SELECT '${key}-${nonce}';`,
          },
          {
            label: "SQLite",
            description: `${key} SQLite option`,
            preview: `PRAGMA '${key}-${nonce}';`,
          },
        ],
        recommended: key === "primary" ? 0 : 1,
      })),
    };
  }
  return checkedArgs(schema, args, `ask.${name}`);
}

export function richAnswers(nonce) {
  return [
    {
      id: `${nonce}_primary`,
      selectedOptions: ["Postgres", "SQLite"],
      customInput: `custom-primary, exact-${nonce}`,
    },
    {
      id: `${nonce}_secondary`,
      selectedOptions: ["SQLite"],
      customInput: `custom-secondary, exact-${nonce}`,
    },
  ];
}

export const textOf = (content) =>
  typeof content === "string"
    ? content
    : (content ?? [])
        .filter((part) => part.type === "text")
        .map((part) => part.text)
        .join("\n");
export const normalizedPrompt = (content) =>
  textOf(content).replace(
    /^<system-reminder>\nToday: \d{4}-\d{2}-\d{2}; current working directory: '[^\r\n]*'\. Do not repeat this information in your reply\.\n<\/system-reminder>\n{1,2}/u,
    "",
  );
const escape = (value) => value.replace(/[.*+?^${}()|[\]\\]/gu, "\\$&");

function decodedAskOutput(output) {
  const source = output
    .trim()
    .replace(/^```(?:json)?\s*\n([\s\S]*)\n```$/u, "$1")
    .trim();
  return /^(?:\{|\[)/u.test(source) ? JSON.parse(source) : undefined;
}

function selectedSet(actual, expected) {
  assert.ok(Array.isArray(actual), "An ask result must carry its selected option set");
  assert.equal(new Set(actual).size, actual.length, "A selected option cannot be duplicated");
  assert.deepEqual([...actual].sort(), [...expected].sort());
}

function structuredAnswers(decoded) {
  const answers = Array.isArray(decoded)
    ? decoded
    : (decoded.results ?? decoded.answers ?? [decoded]);
  assert.ok(Array.isArray(answers));
  return answers;
}

export function assertAskModelResult(name, output, nonce) {
  const decoded = decodedAskOutput(output);
  if (name === "ask-cancel") {
    // 取消认实际标志/语义而非某一句英文；同时拒绝任何已填写题目的部分答案。
    if (decoded !== undefined) {
      assert.ok(
        decoded.cancelled === true || decoded.canceled === true,
        "Ask cancellation needs an actual cancellation flag",
      );
      for (const answer of structuredAnswers(decoded)) {
        assert.equal(answer.selectedOptions?.length ?? 0, 0);
        assert.ok(answer.customInput === undefined || answer.customInput === "");
      }
    } else {
      assert.match(output, /\b(?:cancel(?:led|ed|lation)?|aborted)\b|取消/iu);
      const answers = richAnswers(nonce);
      const normalized = output.toLowerCase();
      // 仅出现取消词不足以证明整体取消；方括号、逗号列表和自由文本都不能携带已选答案。
      for (const option of new Set(answers.flatMap((answer) => answer.selectedOptions)))
        assert.equal(
          normalized.includes(option.toLowerCase()),
          false,
          "A cancelled request must not return selected options in any text layout",
        );
      for (const answer of answers)
        assert.equal(
          normalized.includes(answer.customInput.split(",")[0].toLowerCase()),
          false,
          "A cancelled request must not return even a partial custom answer",
        );
    }
    return;
  }
  if (name === "ask-timeout") {
    if (decoded !== undefined) {
      const answers = structuredAnswers(decoded);
      assert.equal(answers.length, 1);
      const answer = answers[0];
      assert.ok(
        answer.timedOut === true || decoded.timedOut === true,
        "Timeout must carry its actual flag",
      );
      if (answer.id !== undefined) assert.equal(answer.id, `${nonce}_deadline`);
      selectedSet(answer.selectedOptions, ["SQLite"]);
      assert.ok(answer.customInput === undefined || answer.customInput === "");
    } else {
      assert.match(output, /\b(?:timed?\s*out|timeout|deadline\s+(?:expired|elapsed))\b|超时/iu);
      assert.match(output, /\bSQLite\b/u);
      assert.doesNotMatch(output, /\bPostgres\b/u);
      assert.equal(output.includes(`${nonce}_primary`), false);
      assert.equal(output.includes(`${nonce}_secondary`), false);
    }
    return;
  }
  const expected = richAnswers(nonce);
  if (decoded !== undefined) {
    const answers = structuredAnswers(decoded);
    assert.equal(answers.length, expected.length);
    answers.forEach((answer, index) => {
      assert.equal(
        answer.id,
        expected[index].id,
        "Answers must retain real question IDs and question order",
      );
      selectedSet(answer.selectedOptions, expected[index].selectedOptions);
      assert.equal(answer.customInput, expected[index].customInput);
    });
    return;
  }
  // 文本按真实题 ID 分段；标题、选项包装及自定义字段标签不是固定英文契约。
  const starts = [
    ...output.matchAll(
      new RegExp(`(?:^|\\n)\\s*(?:[-*]\\s*)?(${nonce}_(?:primary|secondary))\\s*[:：]\\s*`, "gu"),
    ),
  ];
  assert.equal(
    starts.length,
    expected.length,
    "Exactly two ID-addressed answer sections must reach the model",
  );
  starts.forEach((start, index) => {
    const answer = expected[index];
    assert.equal(start[1], answer.id, "Text answers must retain question order");
    assert.equal(
      [...output.matchAll(new RegExp(escape(answer.id), "gu"))].length,
      1,
      "Question identities cannot be duplicated",
    );
    const section = output
      .slice(start.index + start[0].length, starts[index + 1]?.index ?? output.length)
      .trim();
    const selection = /^\[([^\]]*)\]/u.exec(section);
    assert.ok(selection, "The ID-addressed text answer must carry a concrete selected option list");
    selectedSet(
      selection[1].split(/[,，]/u).map((value) => value.trim().replace(/^(['"])(.*)\1$/u, "$2")),
      answer.selectedOptions,
    );
    const suffix = section.slice(selection[0].length).trim();
    const custom = [answer.customInput, JSON.stringify(answer.customInput)].find((value) =>
      suffix.endsWith(value),
    );
    assert.ok(
      custom,
      "Custom input must survive completely, without truncation or appended answer bytes",
    );
    const label = suffix.slice(0, -custom.length).trim();
    assert.match(
      label,
      /^(?:[+;,，]\s*)?(?:[\p{L}\p{N}_ -]+[:：]\s*)?$/u,
      "Only a presentation label may separate the selected set from the full custom input",
    );
  });
}

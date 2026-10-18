import assert from "node:assert/strict";

const reminder =
  /^<system-reminder>\nToday: \d{4}-\d{2}-\d{2}; current working directory: '[^\r\n]+?'\. Do not repeat this information in your reply\.\n<\/system-reminder>\n{1,2}/u;
const fileEnvelope =
  /<attached_file name="([^"\r\n]+)" mime="([^"\r\n]+)">\n([\s\S]*?)\n<\/attached_file>/gu;
const separator = /^\n{1,2}$/u;

/**
 * 仅解析模型 HTTP 输入，不读取被测实现。文件簇可以放在正文前或后；
 * 1/2 个换行属于封装排版，文件内容和剩余正文不得 trim 或模糊匹配。
 * @param {unknown} content
 */
export function attachmentInput(content) {
  const blocks = typeof content === "string" ? [{ type: "text", text: content }] : content;
  assert.ok(Array.isArray(blocks) && blocks.length > 0, "附件请求必须包含完整 text/image 块");
  const texts = [];
  const images = [];
  for (const block of blocks) {
    assert.ok(block && typeof block === "object" && !Array.isArray(block), "附件块必须是对象");
    if (block.type === "text") {
      assert.equal(typeof block.text, "string", "text 块不能缺失正文");
      texts.push(block.text);
    } else {
      assert.equal(block.type, "image", `附件输入出现未约定块 ${block.type}`);
      const source = block.source;
      assert.ok(
        source && typeof source === "object" && !Array.isArray(source),
        "image 块不能缺失 source",
      );
      assert.deepEqual(Object.keys(source).sort(), ["data", "media_type", "type"]);
      assert.equal(source.type, "base64");
      assert.equal(typeof source.media_type, "string");
      assert.match(source.media_type, /^image\/[a-z0-9.+-]+$/u);
      assert.equal(typeof source.data, "string");
      assert.ok(source.data.length > 0, "image 块不能以空字节成功");
      assert.equal(
        Buffer.from(source.data, "base64").toString("base64"),
        source.data,
        "图片必须使用完整规范的 base64 字节",
      );
      images.push(source);
    }
  }
  const text = texts.join("\n").replace(reminder, "");
  const matches = [...text.matchAll(fileEnvelope)];
  const files = matches.map((match) => {
    assert.doesNotMatch(match[3], /<\/?attached_file\b/u, "不接受嵌套或截断的附件封装");
    return { name: match[1], mime: match[2], text: match[3] };
  });
  let prompt = text;
  if (matches.length) {
    const first = matches[0];
    const last = matches.at(-1);
    const before = text.slice(0, first.index);
    const after = text.slice(last.index + last[0].length);
    for (let index = 1; index < matches.length; index++) {
      const previous = matches[index - 1];
      const gap = text.slice(previous.index + previous[0].length, matches[index].index);
      assert.match(gap, separator, "附件之间只允许1/2换行，不能夹入额外正文或坏封装");
    }
    if (before === "" && after === "") prompt = "";
    else if (before === "") {
      const suffix = /^\n{1,2}([^\n][\s\S]*)$/u.exec(after);
      assert.ok(suffix, "前置附件与正文之间必须恰有1/2换行");
      prompt = suffix[1];
    } else {
      assert.equal(after, "", "附件必须整体位于正文前或后，不能分割或包围额外正文");
      const prefix = /^([\s\S]*[^\n])\n{1,2}$/u.exec(before);
      assert.ok(prefix, "后置附件与正文之间必须恰有1/2换行");
      prompt = prefix[1];
    }
  }
  assert.doesNotMatch(prompt, /<\/?attached_file\b/u, "不能留下未闭合、错误或多余附件封装");
  assert.doesNotMatch(
    prompt,
    /<\/?system-reminder\b/u,
    "只允许去除一次完整的已知首部 reminder，重复或坏封装必须失败",
  );
  return { prompt, files, images };
}

import type { AttachmentRef } from "@zcode/shared/zcode-protocol-v4";
import type { AttachmentStore } from "./attachmentStore.js";

const MAX_TEXT_FILE_BYTES = 256 * 1024;
const MAX_TEXT_TOTAL_BYTES = 512 * 1024;
// S5-5 依据：omp rpc-fork-attachments MAX_ATTACHMENTS=8（resolveRpcAttachments 超限抛
// RpcAttachmentError "attachment_limit"）——该上限约束 v3 attachments 数组；本适配器经
// images 载体发送（omp 侧无数量检查），此处为对齐同一上限的本地保守预检，给明确错误。
const MAX_TOTAL_ATTACHMENTS = 8;

type OmpImage = { type: "image"; data: string; mimeType: string };
type PreparedInput = { ok: true; text: string; images: OmpImage[] } | { ok: false; error: string };

function isTextMime(mime: string): boolean {
  return (
    mime.startsWith("text/") ||
    [
      "application/json",
      "application/xml",
      "application/javascript",
      "application/x-yaml",
      "application/yaml",
    ].includes(mime)
  );
}

/** 已提交附件转成 omp prompt；不支持的类型必须在发送前拒绝。 */
export function prepareOmpAttachmentInput(
  prompt: string,
  refs: readonly AttachmentRef[] | undefined,
  store: AttachmentStore,
): PreparedInput {
  // S5-5：附件总数（image+text 合计）预检；超限整条 prompt 在 omp 侧必被拒。
  if ((refs?.length ?? 0) > MAX_TOTAL_ATTACHMENTS) {
    return {
      ok: false,
      error: `too many attachments: ${refs!.length} (limit ${MAX_TOTAL_ATTACHMENTS})`,
    };
  }
  const sections: string[] = [];
  const images: OmpImage[] = [];
  let textBytes = 0;
  for (const ref of refs ?? []) {
    const attachment = store.lookup(ref.ref);
    const bytes = store.bytesOf(ref.ref);
    if (!attachment || !bytes) return { ok: false, error: "attachment reference missing" };
    const mime = attachment.mime.split(";", 1)[0]?.trim().toLowerCase() ?? "";
    const name = [...attachment.fileName]
      .map((character) => {
        const code = character.codePointAt(0) ?? 0;
        return code < 32 || code === 127 ? " " : character;
      })
      .join("")
      .slice(0, 255);
    if (mime.startsWith("image/")) {
      images.push(...store.ompImagesOf(ref.ref));
      continue;
    }
    // Bug 原因：旧路径只收集图片，PDF/文本虽上传成功却被静默丢弃。
    // omp RPC 的 prompt 只接受文本和图片；文本显式并入 prompt，其余类型拒绝。
    if (!isTextMime(mime))
      return { ok: false, error: `${name}: unsupported attachment type ${mime || "unknown"}` };
    if (bytes.length > MAX_TEXT_FILE_BYTES)
      return { ok: false, error: `${name}: text attachment exceeds 256 KiB` };
    textBytes += bytes.length;
    if (textBytes > MAX_TEXT_TOTAL_BYTES)
      return { ok: false, error: "text attachments exceed 512 KiB in total" };
    let content: string;
    try {
      content = new TextDecoder("utf-8", { fatal: true }).decode(bytes);
    } catch {
      return { ok: false, error: `${name}: invalid UTF-8 text` };
    }
    sections.push(
      `<attached_file name=${JSON.stringify(name)} mime=${JSON.stringify(mime)}>\n${content}\n</attached_file>`,
    );
  }
  return {
    ok: true,
    // 优化项（S5-8）依据：omp 语义为 `${textPrefix}${message}`（rpc-session-host
    // #resolveCommandAttachments → resolveRpcAttachments 的 textPrefix 以 "\n\n" 结尾前置），
    // 附件上下文先于用户消息；此前后置拼接与 omp 原生顺序不一致。
    text: sections.length ? `${sections.join("\n\n")}\n\n${prompt}` : prompt,
    images,
  };
}

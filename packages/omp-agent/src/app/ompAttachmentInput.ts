import { PROTOCOL_V4_LIMITS, type AttachmentRef } from "@zcode/shared/zcode-protocol-v4";
import type { AttachmentStore } from "./attachmentStore.js";

const MAX_TEXT_FILE_BYTES = 256 * 1024;
const MAX_TEXT_TOTAL_BYTES = 512 * 1024;
// S5-5 依据：omp rpc-fork-attachments MAX_ATTACHMENTS=8（resolveRpcAttachments 超限抛
// RpcAttachmentError "attachment_limit"）——该上限约束 v3 attachments 数组；本适配器经
// images 载体发送（omp 侧无数量检查），此处为对齐同一上限的本地保守预检，给明确错误。
const MAX_TOTAL_ATTACHMENTS = 8;

type OmpImage = { type: "image"; data: string; mimeType: string };
type PreparedInput = { ok: true; text: string; images: OmpImage[] } | { ok: false; error: string };

/** app 只决定读取预算；路径语义与真实文件 IO 均由目标 Host 的适配器提供。 */
export interface OmpAttachmentFileReader {
  isAbsolutePath(path: string): boolean;
  readFile(path: string, maxBytes: number): Promise<Buffer>;
}

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

/** 已提交附件和目标 Host 文件统一转成 omp prompt；失败必须先于核心调用。 */
export async function prepareOmpAttachmentInput(
  prompt: string,
  refs: readonly AttachmentRef[] | undefined,
  store: AttachmentStore,
  fileReader?: OmpAttachmentFileReader,
): Promise<PreparedInput> {
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
    // 根因：零拷贝与远端 staged ref 是目标 Host 绝对路径，并非上传事务 ID。
    // 上传 ref 仍只能由 store 验真；缺失/过期事务绝不回退成文件读取。
    const uploaded = ref.ref.startsWith("omp-attachment://");
    const attachment = uploaded ? store.lookup(ref.ref) : ref;
    if (!attachment) return { ok: false, error: "attachment reference missing" };
    const mime = attachment.mime.split(";", 1)[0]?.trim().toLowerCase() ?? "";
    const name = [...attachment.fileName]
      .map((character) => {
        const code = character.codePointAt(0) ?? 0;
        return code < 32 || code === 127 ? " " : character;
      })
      .join("")
      .slice(0, 255);
    const image = mime.startsWith("image/");
    if (!image && !isTextMime(mime))
      return { ok: false, error: `${name}: unsupported attachment type ${mime || "unknown"}` };
    let bytes: Buffer | null;
    if (uploaded) {
      bytes = store.bytesOf(ref.ref);
      if (!bytes) return { ok: false, error: "attachment reference missing" };
    } else {
      if (!fileReader) return { ok: false, error: `${name}: attachment file reader unavailable` };
      if (!fileReader.isAbsolutePath(ref.ref))
        return {
          ok: false,
          error: `${name}: attachment reference must be an absolute host file path`,
        };
      const maxBytes = image
        ? PROTOCOL_V4_LIMITS.attachmentMaxBytes
        : Math.min(MAX_TEXT_FILE_BYTES, MAX_TEXT_TOTAL_BYTES - textBytes);
      try {
        bytes = await fileReader.readFile(ref.ref, maxBytes);
      } catch {
        // 不透传 fs 错误：其中含路径；这里只返回无正文、无凭据的稳定拒绝说明。
        return {
          ok: false,
          error: `${name}: attachment file unreadable or exceeds ${maxBytes} byte limit`,
        };
      }
    }
    if (image) {
      if (bytes.length > PROTOCOL_V4_LIMITS.attachmentMaxBytes)
        return { ok: false, error: `${name}: image attachment exceeds byte limit` };
      images.push({ type: "image", data: bytes.toString("base64"), mimeType: mime });
      continue;
    }
    // omp RPC 只接受文本和图片；两种来源复用同一真实字节校验，不信任 ref.bytes。
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

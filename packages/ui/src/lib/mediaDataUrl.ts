/**
 * 把 FileMediaPreview 的裸 base64 与 mediaType 拼成 <img> 可用的 data URL。
 *
 * 修复依据：fileService.readMediaPreview 返回的 dataBase64 是不带 data: 前缀的裸 base64
 * （packages/shared/src/protocol.ts 的 FileMediaPreview 与 packages/services
 * fileService 均按裸 base64 定义），直接赋给 <img src> 会被浏览器当相对 URL
 * 请求而必然 404。拼法与 nodeReplImageGrid、FeedbackScreenshotPicker 的既有先例一致。
 */
export function toMediaDataUrl(mediaType: string, dataBase64: string): string {
  return `data:${mediaType};base64,${dataBase64}`;
}

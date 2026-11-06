export const MAX_IMAGE_BYTES = 10 * 1024 * 1024;
export interface ImageContent { type: "image"; data: string; mimeType: string }
export type UserContent = string | ({ type: "text"; text: string } | ImageContent)[];

/** Verify actual bytes, never trust Telegram's filename or declared content type. */
export function imageMime(bytes: Uint8Array): string | undefined {
  const b = Buffer.from(bytes);
  if (b.length < 12) return;
  if (b.subarray(0, 8).equals(Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]))) return "image/png";
  if (b[0] === 255 && b[1] === 216 && b[2] === 255) return "image/jpeg";
  if (["GIF87a", "GIF89a"].includes(b.toString("ascii", 0, 6))) return "image/gif";
  if (b.toString("ascii", 0, 4) === "RIFF" && b.toString("ascii", 8, 12) === "WEBP") return "image/webp";
}

export async function readImage(response: Response): Promise<ImageContent> {
  if (!response.ok || !response.body) throw new Error("图片下载失败");
  const reader = response.body.getReader();
  const buffers: Uint8Array[] = [];
  let size = 0;
  try {
    if (Number(response.headers.get("content-length")) > MAX_IMAGE_BYTES) throw new Error("图片超过 10 MiB");
    while (true) {
      const { done, value } = await reader.read();
      if (done) break;
      size += value.length;
      if (size > MAX_IMAGE_BYTES) throw new Error("图片超过 10 MiB");
      buffers.push(value);
    }
    const bytes = Buffer.concat(buffers);
    const mimeType = imageMime(bytes);
    if (!mimeType) throw new Error("仅支持 PNG、JPEG、WebP、GIF 图片");
    return { type: "image", mimeType, data: bytes.toString("base64") };
  } finally {
    await reader.cancel().catch(() => {});
    reader.releaseLock();
  }
}

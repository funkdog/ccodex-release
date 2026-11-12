import "../tools/typescript-runtime.mjs";
import type { Attachment } from "./contracts.mjs";
import fs from "node:fs";
import path from "node:path";

const invalid = (message: string) => Object.assign(new Error(message), { code: -32602 });
const maxImageBytes = 4 * 1024 * 1024;
export const imageMime = (bytes: Buffer) => bytes.subarray(0, 8).equals(Buffer.from([137, 80, 78, 71, 13, 10, 26, 10])) ? "image/png"
  : bytes[0] === 255 && bytes[1] === 216 && bytes[2] === 255 ? "image/jpeg"
  : /^(GIF87a|GIF89a)$/.test(bytes.subarray(0, 6).toString("ascii")) ? "image/gif"
  : bytes.subarray(0, 4).toString("ascii") === "RIFF" && bytes.subarray(8, 12).toString("ascii") === "WEBP" ? "image/webp" : null;

export function cliInput(input: unknown, { supportsImages = false } = {}) {
  if (!Array.isArray(input) || !input.length || input.length > 100) throw invalid("Provide bounded text or image input.");
  const text: string[] = [], attachments: Attachment[] = [];
  let totalImageBytes = 0;
  for (const item of input) {
    if (item?.type === "text") {
      if (typeof item.text !== "string" || item.text.length > 1024 * 1024) throw invalid("Invalid text input.");
      text.push(item.text);
      continue;
    }
    if (!supportsImages || !["image", "localImage"].includes(item?.type)) throw invalid("所选 CLI 模型不支持该输入；请选择支持图片的模型，其他附件暂不可用。");
    let bytes, declared;
    if (item.type === "localImage") {
      if (typeof item.path !== "string" || !path.isAbsolute(item.path)) throw invalid("Image input requires an absolute local path.");
      const fd = fs.openSync(item.path, fs.constants.O_RDONLY | fs.constants.O_NONBLOCK);
      try {
        const stat = fs.fstatSync(fd);
        if (!stat.isFile() || stat.size > maxImageBytes) throw invalid("Local image must be a regular file no larger than 4 MiB.");
        const buffer = Buffer.alloc(maxImageBytes + 1);
        const size = fs.readSync(fd, buffer, 0, buffer.length, 0);
        if (size > maxImageBytes) throw invalid("Local image exceeds 4 MiB.");
        bytes = buffer.subarray(0, size);
      } finally { fs.closeSync(fd); }
    } else {
      if (typeof item.url !== "string" || item.url.length > Math.ceil(maxImageBytes / 3) * 4 + 128) throw invalid("Inline image exceeds 4 MiB.");
      const match = /^data:(image\/(?:png|jpeg|gif|webp));base64,([A-Za-z0-9+/]+={0,2})$/.exec(item.url);
      if (!match || match[2].length % 4) throw invalid("图片必须是本地文件或有效的 PNG/JPEG/GIF/WebP data URL；不抓取远程 URL。");
      declared = match[1]; bytes = Buffer.from(match[2], "base64");
      if (bytes.toString("base64") !== match[2]) throw invalid("Invalid base64 image.");
    }
    const mimeType = imageMime(bytes);
    if (!mimeType || (declared && mimeType !== declared)) throw invalid("Image contents do not match a supported image format.");
    totalImageBytes += bytes.length;
    if (totalImageBytes > maxImageBytes) throw invalid("Combined CLI images exceed 4 MiB.");
    attachments.push({ type: "blob", data: bytes.toString("base64"), mimeType });
  }
  return { prompt: text.join("\n"), ...(attachments.length ? { attachments } : {}) };
}

import fs from "node:fs";
import path from "node:path";
import { pathToFileURL, fileURLToPath } from "node:url";
import type { EngineImage, ImageGenerationThreadItem } from "./contracts.mjs";
import { imageMime } from "./input.mjs";
import { privateDirectory } from "./spine/storage.mjs";

export const MAX_MEDIA_BYTES = 10 * 1024 * 1024;
const extensions: Record<string, string> = { "image/png": "png", "image/jpeg": "jpg", "image/webp": "webp", "image/gif": "gif" };
const uuid = /^[a-f0-9]{8}(?:-[a-f0-9]{4}){3}-[a-f0-9]{12}$/;
/** Strip multimodal payloads before JSON serialization. Only explicit image
 * blocks or image-tool artifact fields/announcements become file candidates. */
export function extractToolOutput(value: unknown, { toolName = "", cwd = "" }: { toolName?: string; cwd?: string } = {}) {
  const images: EngineImage[] = []; let nodes = 0;
  const imageTool = /image|screenshot|capture|render|view.*file/i.test(toolName);
  const local = (value: string) => {
    let file = value;
    try { if (file.startsWith("file://")) file = fileURLToPath(file); } catch { return; }
    if (!/\.(?:png|jpe?g|webp|gif)$/i.test(file)) return;
    if (!path.isAbsolute(file) && cwd) file = path.resolve(cwd, file);
    if (path.isAbsolute(file)) images.push({ kind: "file", path: file });
  };
  const visit = (item: unknown, depth = 0): unknown => {
    if (++nodes > 1024 || depth > 12) return "[Output structure exceeds display limit]";
    if (typeof item === "string") {
      const announced = imageTool ? /^(?:Saved|Generated|Viewed|Screenshot|Image)(?:\s+(?:image|screenshot))?\s*(?:at|to|:)?\s+([^\n]+\.(?:png|jpe?g|webp|gif))\s*$/i : /^(?:Saved|Generated|Viewed)\s+(?:image|screenshot)\s*(?:at|to|:)?\s+([^\n]+\.(?:png|jpe?g|webp|gif))\s*$/i;
      const match = announced.exec(item.trim()); if (match) local(match[1]);
      return item.length > 128 * 1024 ? item.slice(0, 128 * 1024) + "\n[Text exceeds display limit]" : item;
    }
    if (!item || typeof item !== "object") return item;
    if (Array.isArray(item)) return item.slice(0, 256).map(child => visit(child, depth + 1));
    const p = item as Record<string, unknown>;
    if (p.type === "image" || p.type === "image_url" || typeof p.mimeType === "string" && p.mimeType.startsWith("image/")) {
      const source = p.source && typeof p.source === "object" ? p.source as Record<string, unknown> : p;
      const mimeType = source.mimeType ?? source.media_type ?? p.mimeType;
      const data = source.data ?? source.blob;
      if (typeof data === "string" && typeof mimeType === "string") {
        if (!extensions[mimeType] || data.length > Math.ceil(MAX_MEDIA_BYTES / 3) * 4) throw new Error("Unsupported or oversized image output.");
        images.push({ kind: "blob", mimeType, data });
        return `[Image output: ${mimeType}, approximately ${Math.floor(data.length / 4) * 3} bytes]`;
      }
      const imageUrl = p.image_url && typeof p.image_url === "object" ? (p.image_url as Record<string, unknown>).url : p.url;
      if (typeof imageUrl === "string" && imageUrl.startsWith("data:")) {
        const match = /^data:(image\/(?:png|jpeg|gif|webp));base64,([A-Za-z0-9+/]*={0,2})$/.exec(imageUrl);
        if (!match || match[2].length > Math.ceil(MAX_MEDIA_BYTES / 3) * 4) throw new Error("Invalid inline image URL.");
        images.push({ kind: "blob", mimeType: match[1], data: match[2] }); return `[Image output: ${match[1]}]`;
      }
      for (const key of ["path", "url", "uri"]) if (typeof p[key] === "string") local(p[key]);
      return "[Image output: local artifact]";
    }
    const result: Record<string, unknown> = {};
    for (const [key, child] of Object.entries(p).slice(0, 128)) {
      if (["__proto__", "constructor", "prototype"].includes(key)) continue;
      if (typeof child === "string" && (imageTool && ["path", "savedPath", "imagePath", "screenshotPath", "uri"].includes(key) || /^(?:image|screenshot)Path$/.test(key))) local(child);
      result[key] = visit(child, depth + 1);
    }
    return result;
  };
  const safe = visit(value);
  if (images.length > 16) throw new Error("Too many image outputs in one event.");
  return { output: typeof safe === "string" ? safe : JSON.stringify(safe) ?? "", images, safe };
}
export class MediaStore {
  directory: string;
  constructor(home: string) { this.directory = privateDirectory(path.join(home, "gateway", "media")); }
  save(threadId: string, itemId: string, image: EngineImage): ImageGenerationThreadItem {
    if (!uuid.test(threadId) || !uuid.test(itemId)) throw new Error("Invalid media identity.");
    let bytes: Buffer;
    if (image.kind === "blob") {
      if (!extensions[image.mimeType] || typeof image.data !== "string" || image.data.length > Math.ceil(MAX_MEDIA_BYTES / 3) * 4 || !/^[A-Za-z0-9+/]*={0,2}$/.test(image.data) || image.data.length % 4) throw new Error("Invalid inline image.");
      bytes = Buffer.from(image.data, "base64"); if (bytes.toString("base64") !== image.data) throw new Error("Invalid image base64.");
    } else {
      if (!path.isAbsolute(image.path) || !/\.(?:png|jpe?g|webp|gif)$/i.test(image.path)) throw new Error("Image artifact needs an absolute supported path.");
      const stat = fs.lstatSync(image.path); if (!stat.isFile() || stat.isSymbolicLink() || stat.size > MAX_MEDIA_BYTES) throw new Error("Image artifact must be a bounded regular file.");
      const fd = fs.openSync(image.path, fs.constants.O_RDONLY | fs.constants.O_NOFOLLOW | fs.constants.O_NONBLOCK);
      try {
        const actual = fs.fstatSync(fd); if (!actual.isFile() || actual.size > MAX_MEDIA_BYTES) throw new Error("Invalid image artifact.");
        const buffer = Buffer.alloc(MAX_MEDIA_BYTES + 1); let length = 0;
        while (length < buffer.length) { const count = fs.readSync(fd, buffer, length, buffer.length - length, length); if (!count) break; length += count; }
        bytes = buffer.subarray(0, length);
      } finally { fs.closeSync(fd); }
    }
    const mime = imageMime(bytes);
    if (!mime || !bytes.length || bytes.length > MAX_MEDIA_BYTES || image.kind === "blob" && mime !== image.mimeType) throw new Error("Image bytes do not match a supported format/size.");
    const directory = privateDirectory(path.join(this.directory, threadId));
    const existing = fs.readdirSync(directory).map(name => fs.lstatSync(path.join(directory, name)));
    if (existing.some(stat => !stat.isFile() || stat.isSymbolicLink()) || existing.length >= 128 || existing.reduce((sum, stat) => sum + stat.size, 0) + bytes.length > 256 * 1024 * 1024) throw new Error("Thread media limit reached or storage is invalid.");
    const savedPath = path.join(directory, `${itemId}.${extensions[mime]}`);
    const fd = fs.openSync(savedPath, fs.constants.O_WRONLY | fs.constants.O_CREAT | fs.constants.O_NOFOLLOW | fs.constants.O_EXCL, 0o600);
    try { fs.writeFileSync(fd, bytes); fs.fsyncSync(fd); } catch (error) { fs.closeSync(fd); fs.unlinkSync(savedPath); throw error; }
    fs.closeSync(fd);
    return { id: itemId, type: "imageGeneration", status: "completed", savedPath, result: pathToFileURL(savedPath).href };
  }
  removeThread(threadId: string) {
    if (!uuid.test(threadId)) throw new Error("Invalid media thread identity.");
    const directory = path.join(this.directory, threadId);
    if (!fs.existsSync(directory)) return;
    privateDirectory(directory, false);
    for (const name of fs.readdirSync(directory)) {
      const file = path.join(directory, name), stat = fs.lstatSync(file);
      if (!stat.isFile() || stat.isSymbolicLink() || !/^[a-f0-9-]+\.(?:png|jpg|webp|gif)$/.test(name)) throw new Error("Refusing unsafe media cleanup.");
      fs.unlinkSync(file);
    }
    fs.rmdirSync(directory);
  }
}

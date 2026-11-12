import fs from "node:fs";
import path from "node:path";
import { createHash, randomUUID } from "node:crypto";
import type { LogPointer, LogRead, ReadLogParams } from "./contracts.mjs";
interface LogMetadata extends LogPointer { mtimeMs: number; ino: number; dev: number }

const segment = /^[A-Za-z0-9][A-Za-z0-9_-]{0,95}$/;
function privateStat(stat: fs.Stats, directory = false) {
  if (!(directory ? stat.isDirectory() : stat.isFile()) ||
      (process.getuid && stat.uid !== process.getuid()) || (process.platform !== "win32" && (stat.mode & 0o077)))
    throw new Error("Spine requires owned private regular storage.");
}
/** Check each component; never follow a symlink into another profile. */
export function privateDirectory(directory: string, create = true) {
  // macOS exposes system temporary storage via /var and /tmp aliases. Resolve
  // only these known OS prefixes; user-controlled links still fail below.
  const resolved = path.resolve(directory);
  const full = process.platform === "darwin" ? resolved.replace(/^\/(var|tmp)(?=\/)/, "/private/$1") : resolved;
  const parts = full.slice(path.parse(full).root.length).split(path.sep);
  let current = path.parse(full).root;
  for (const part of parts) {
    current = path.join(current, part);
    if (!fs.existsSync(current)) {
      if (!create) throw new Error("Spine storage is unavailable.");
      fs.mkdirSync(current, { mode: 0o700 });
    }
    const stat = fs.lstatSync(current);
    if (!stat.isDirectory() || stat.isSymbolicLink()) throw new Error("Linked Spine storage is forbidden.");
  }
  privateStat(fs.lstatSync(full), true);
  return full;
}
function openPrivate(file: string, flags: number) {
  const fd = fs.openSync(file, flags | fs.constants.O_NOFOLLOW, 0o600);
  try { privateStat(fs.fstatSync(fd)); return fd; } catch (error) { fs.closeSync(fd); throw error; }
}
function identity(id: string) {
  const parts = id.split("/");
  if (parts.length !== 2 || parts.some(part => !segment.test(part))) throw new Error("Invalid log ID.");
  return parts;
}
export function validateReadLog(value: unknown): ReadLogParams {
  if (!value || typeof value !== "object" || Array.isArray(value)) throw new Error("Invalid log range.");
  const p = value as Record<string, unknown>;
  if (Object.keys(p).some(key => !["id", "startLine", "endLine", "byteOffset", "maxBytes"].includes(key)) || typeof p.id !== "string") throw new Error("Invalid log parameters.");
  identity(p.id);
  if (!Number.isSafeInteger(p.startLine) || !Number.isSafeInteger(p.endLine) || (p.startLine as number) < 1 || (p.endLine as number) < (p.startLine as number) || (p.endLine as number) - (p.startLine as number) >= 10000 ||
      (p.byteOffset !== undefined && (!Number.isSafeInteger(p.byteOffset) || (p.byteOffset as number) < 0)) ||
      (p.maxBytes !== undefined && (!Number.isSafeInteger(p.maxBytes) || (p.maxBytes as number) < 1 || (p.maxBytes as number) > 128 * 1024))) throw new Error("Log range exceeds limits.");
  return p as unknown as ReadLogParams;
}

/** Unique per-call logs, no shared shim-written catalogue. LF defines a line;
 * its terminating LF (and any CR) belongs to that line. Empty output has 0 lines. */
export class SpilloverStore {
  directory: string;
  constructor(home: string) { this.directory = privateDirectory(path.join(home, "gateway", "spillover")); }
  begin(sessionId: string = randomUUID(), callId: string = randomUUID()) {
    const id = `${sessionId}/${callId}`;
    identity(id);
    const directory = privateDirectory(path.join(this.directory, sessionId));
    const file = path.join(directory, `${callId}.log`);
    const fd = openPrivate(file, fs.constants.O_WRONLY | fs.constants.O_CREAT | fs.constants.O_EXCL);
    const hash = createHash("sha256"); let bytes = 0, lines = 0, last = -1, done = false;
    return { id, file,
      append(chunk: Uint8Array) {
        if (done) throw new Error("Log capture already finished.");
        const data = Buffer.from(chunk);
        let written = 0; while (written < data.length) written += fs.writeSync(fd, data, written);
        hash.update(data); bytes += data.length;
        for (const byte of data) if (byte === 10) lines++;
        if (data.length) last = data[data.length - 1];
      },
      finish: (): LogPointer => {
        if (done) throw new Error("Log capture already finished.");
        done = true;
        try { fs.fsyncSync(fd); } finally { fs.closeSync(fd); }
        if (bytes && last !== 10) lines++;
        const pointer: LogPointer = { id, startLine: lines ? 1 : 0, endLine: lines, bytes, sha256: hash.digest("hex") };
        const stat = fs.lstatSync(file);
        const pending = `${file}.${randomUUID()}.pending`;
        const metadata = openPrivate(pending, fs.constants.O_WRONLY | fs.constants.O_CREAT | fs.constants.O_EXCL);
        try {
          try { fs.writeFileSync(metadata, JSON.stringify({ ...pointer, mtimeMs: stat.mtimeMs, ino: stat.ino, dev: stat.dev })); fs.fsyncSync(metadata); } finally { fs.closeSync(metadata); }
          // Atomic, exclusive completion marker: readers never see partial JSON.
          fs.linkSync(pending, `${file}.json`);
          const directoryFd = fs.openSync(directory, fs.constants.O_RDONLY | fs.constants.O_NOFOLLOW);
          try { fs.fsyncSync(directoryFd); } finally { fs.closeSync(directoryFd); }
        } finally { fs.unlinkSync(pending); }
        return pointer;
      },
      abort() { if (!done) { done = true; fs.closeSync(fd); } /* retain partial evidence; not readable until finish */ },
    };
  }
  save(raw: Uint8Array, sessionId?: string, callId?: string) {
    const capture = this.begin(sessionId, callId);
    try { capture.append(raw); return capture.finish(); } catch (error) { capture.abort(); throw error; }
  }
  async read(value: unknown): Promise<LogRead> {
    const p = validateReadLog(value), [sessionId, callId] = identity(p.id);
    privateDirectory(this.directory, false);
    const directory = privateDirectory(path.join(this.directory, sessionId), false);
    const file = path.join(directory, `${callId}.log`);
    const metaFd = openPrivate(`${file}.json`, fs.constants.O_RDONLY);
    let metadata: LogMetadata;
    try {
      if (fs.fstatSync(metaFd).size > 2048) throw new Error("Invalid log metadata.");
      metadata = JSON.parse(fs.readFileSync(metaFd, "utf8")) as LogMetadata;
      if (metadata.id !== p.id || !Number.isSafeInteger(metadata.endLine) || metadata.endLine < 0 || !Number.isSafeInteger(metadata.bytes) || metadata.bytes < 0 || !Number.isFinite(metadata.mtimeMs) || !Number.isSafeInteger(metadata.ino) || !Number.isSafeInteger(metadata.dev) || !/^[a-f0-9]{64}$/.test(metadata.sha256)) throw new Error("Invalid log metadata.");
    } finally { fs.closeSync(metaFd); }
    if (p.endLine > metadata.endLine) throw new Error("Log line is out of range.");
    const fd = openPrivate(file, fs.constants.O_RDONLY);
    try {
      const unchanged = () => { const stat = fs.fstatSync(fd); return stat.size === metadata.bytes && stat.mtimeMs === metadata.mtimeMs && stat.ino === metadata.ino && stat.dev === metadata.dev; };
      if (!unchanged()) throw new Error("Log changed after capture.");
      // Scan fixed blocks without loading the file or its line index into memory.
      const chunk = Buffer.alloc(64 * 1024); let line = 1, position = 0, start = p.startLine === 1 ? 0 : -1, end = -1;
      while (position < metadata.bytes && end < 0) {
        // Cooperatively yield during long-line scans. A read_log never monopolizes
        // the shared gateway event loop while an engine is actively streaming.
        await new Promise<void>(resolve => setImmediate(resolve));
        const count = fs.readSync(fd, chunk, 0, chunk.length, position);
        if (!count) throw new Error("Log changed during read.");
        for (let i = 0; i < count; i++) if (chunk[i] === 10) {
          if (line === p.endLine) { end = position + i + 1; break; }
          line++; if (line === p.startLine) start = position + i + 1;
        }
        position += count;
      }
      if (end < 0) end = metadata.bytes;
      if (start < 0) throw new Error("Log line is out of range.");
      const offset = p.byteOffset ?? 0, length = end - start;
      if (offset > length) throw new Error("Log byte offset is out of range.");
      // Even all-control-byte UTF8 (JSON expansion up to 6x) stays within the
      // tunnel response budget. Every short read exposes its continuation.
      const bytes = Buffer.alloc(Math.min(p.maxBytes ?? 32 * 1024, 32 * 1024, length - offset));
      let count = 0; while (count < bytes.length) {
        const n = fs.readSync(fd, bytes, count, bytes.length - count, start + offset + count);
        if (!n) throw new Error("Log changed during read."); count += n;
      }
      const utf8 = bytes.toString("utf8"), valid = Buffer.from(utf8).equals(bytes);
      if (!unchanged()) throw new Error("Log changed during read.");
      return { id: metadata.id, bytes: metadata.bytes, sha256: metadata.sha256, startLine: p.startLine, endLine: p.endLine,
        encoding: valid ? "utf8" : "base64", content: valid ? utf8 : bytes.toString("base64"),
        byteOffset: offset, complete: offset + count === length, nextByteOffset: offset + count < length ? offset + count : null };
    } finally { fs.closeSync(fd); }
  }
}

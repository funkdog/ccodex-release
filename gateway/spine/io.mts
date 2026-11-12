import fs from "node:fs";
import path from "node:path";
import { randomUUID } from "node:crypto";
import { spawn } from "node:child_process";
import { StringDecoder } from "node:string_decoder";
import type { CommandSpec } from "./contracts.mjs";
import { privateDirectory } from "./storage.mjs";

export function readJson(file: string, maxBytes = 2 * 1024 * 1024, { privateFile = false } = {}): unknown {
  if (!path.isAbsolute(file)) throw new Error("Configured data path must be absolute.");
  const fd = fs.openSync(file, fs.constants.O_RDONLY | fs.constants.O_NOFOLLOW | fs.constants.O_NONBLOCK);
  try {
    const stat = fs.fstatSync(fd); if (!stat.isFile() || stat.size > maxBytes) throw new Error("Data file must be bounded and regular.");
    if (privateFile && ((process.getuid && stat.uid !== process.getuid()) || process.platform !== "win32" && (stat.mode & 0o077))) throw new Error("State must be owned and private.");
    const data = Buffer.alloc(maxBytes + 1); let length = 0;
    while (length < data.length) { const n = fs.readSync(fd, data, length, data.length - length, length); if (!n) break; length += n; }
    if (length > maxBytes) throw new Error("Data file exceeds limit.");
    return JSON.parse(data.subarray(0, length).toString("utf8"));
  } finally { fs.closeSync(fd); }
}
export function writeJson(file: string, value: unknown) {
  const directory = privateDirectory(path.dirname(file));
  if (fs.existsSync(file) && (!fs.lstatSync(file).isFile() || fs.lstatSync(file).isSymbolicLink())) throw new Error("Refusing unsafe Spine state replacement.");
  const bytes = JSON.stringify(value); if (Buffer.byteLength(bytes) > 2 * 1024 * 1024) throw new Error("Spine state exceeds limit.");
  const pending = `${file}.${randomUUID()}.pending`, fd = fs.openSync(pending, fs.constants.O_WRONLY | fs.constants.O_CREAT | fs.constants.O_EXCL | fs.constants.O_NOFOLLOW, 0o600);
  try { fs.writeFileSync(fd, bytes); fs.fsyncSync(fd); } finally { fs.closeSync(fd); }
  try { fs.renameSync(pending, file); const d = fs.openSync(directory, fs.constants.O_RDONLY); try { fs.fsyncSync(d); } finally { fs.closeSync(d); } }
  finally { if (fs.existsSync(pending)) fs.unlinkSync(pending); }
}
export function redact(value: string) {
  return value.replace(/-----BEGIN (?:RSA |EC |OPENSSH )?PRIVATE KEY-----[\s\S]*?(?:-----END (?:RSA |EC |OPENSSH )?PRIVATE KEY-----|$)/g, "[私钥已脱敏]")
    .replace(/(?:github_pat_|gh[pousr]_)[A-Za-z0-9_]{16,}|sk-[A-Za-z0-9_-]{16,}|eyJ[A-Za-z0-9_.-]{24,}|(?:AKIA|ASIA)[A-Z0-9]{16}|AIza[A-Za-z0-9_-]{30,}/g, "[凭据已脱敏]")
    .replace(/\b(password|passwd|token|secret|api[_-]?key|authorization)["']?\s*[:=]\s*["']?(?:Bearer\s+)?[^\s,"';]+/gi, "$1=[已脱敏]")
    .replace(/[A-Za-z0-9._%+-]+@[A-Za-z0-9.-]+\.[A-Za-z]{2,}/g, "[邮箱已脱敏]");
}
export async function runCommand(spec: CommandSpec, input?: string): Promise<string> {
  if (!path.isAbsolute(spec.executable) || !fs.statSync(spec.executable).isFile() || !Array.isArray(spec.args) || spec.args.length > 64 || spec.args.some(arg => typeof arg !== "string" || arg.length > 8192 || arg.includes("\0")) || spec.cwd && !path.isAbsolute(spec.cwd)) throw new Error("Invalid configured command.");
  const timeout = spec.timeoutMs ?? 60000; if (!Number.isSafeInteger(timeout) || timeout < 100 || timeout > 300000) throw new Error("Invalid command timeout.");
  const env = { ...process.env, ...spec.env };
  for (const key of Object.keys(env)) if (/^(?:CCODEX_|CODEX_|ELECTRON_)/.test(key) || ["NODE_OPTIONS", "MYCODEX_GOOGLE_TOKEN"].includes(key)) delete env[key];
  const child = spawn(spec.executable, spec.args, { cwd: spec.cwd, env, stdio: ["pipe", "pipe", "pipe"] });
  return new Promise((resolve, reject) => {
    let stdout = "", stderr = "", bytes = 0, failure: Error | undefined;
    const decoder = new StringDecoder("utf8");
    const kill = () => child.kill("SIGKILL");
    const timer = setTimeout(() => { failure = new Error("Configured task timed out; no automatic retry."); kill(); }, timeout);
    child.stdout.on("data", chunk => { bytes += chunk.length; if (bytes > 2 * 1024 * 1024) { failure = new Error("Configured task output exceeds limit."); kill(); } else stdout += decoder.write(chunk); });
    child.stderr.on("data", chunk => { stderr = (stderr + chunk.toString()).slice(-8192); });
    child.once("error", error => { clearTimeout(timer); reject(error); });
    child.once("close", code => { clearTimeout(timer); stdout += decoder.end(); failure ? reject(failure) : code ? reject(new Error(`Configured task failed (${code}): ${redact(stderr).slice(-1000)}`)) : resolve(stdout); });
    child.stdin.on("error", () => {}); child.stdin.end(input);
  });
}

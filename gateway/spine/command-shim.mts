import fs from "node:fs";
import path from "node:path";
import { spawn } from "node:child_process";
import { randomUUID } from "node:crypto";
import { pathToFileURL } from "node:url";
import { SpilloverStore, privateDirectory } from "./storage.mjs";
import { compressLayer1, logReadPointer } from "./compressor.mjs";

const quote = (text: string) => `'${text.replaceAll("'", "'\\''")}'`;
/** Explicit selected commands only; no shell parsing, eval or global PATH.
 * Exact original command paths are fixed at preparation, never resolved via shim PATH. */
export function prepareCommandShims(home: string, commands: Readonly<Record<string, string>>, sessionId: string = randomUUID()) {
  if (process.platform === "win32") throw new Error("P1 shims currently support Unix child processes.");
  if (!/^[A-Za-z0-9][A-Za-z0-9_-]{0,95}$/.test(sessionId)) throw new Error("Invalid shim session ID.");
  const directory = privateDirectory(path.join(home, "gateway", "shims", sessionId));
  for (const [name, executable] of Object.entries(commands)) {
    if (!/^[a-z][a-z0-9_-]{0,63}$/.test(name) || !path.isAbsolute(executable) || !fs.statSync(executable).isFile() || fs.realpathSync(executable).startsWith(path.join(home, "gateway", "shims") + path.sep)) throw new Error("Invalid original shim command.");
    const script = `#!/bin/sh\nexec ${[process.execPath, path.join(import.meta.dirname, "command-shim.mjs"), home, sessionId, executable].map(quote).join(" ")} "$@"\n`;
    fs.writeFileSync(path.join(directory, name), script, { flag: "wx", mode: 0o700 });
  }
  return directory;
}
export async function runCompressedCommand({ home, sessionId, executable, args, thresholdBytes = 24 * 1024 }: {
  home: string; sessionId: string; executable: string; args: string[]; thresholdBytes?: number;
}) {
  if (!path.isAbsolute(executable) || !fs.statSync(executable).isFile()) throw new Error("Original command is unavailable.");
  // Interactive TTY semantics are preserved; compression is a piped-tool hook.
  if (process.stdout.isTTY || process.stderr.isTTY) {
    const child = spawn(executable, args, { stdio: "inherit" });
    return new Promise<number>(resolve => child.once("exit", code => resolve(code ?? 1)));
  }
  const store = new SpilloverStore(home), callId = randomUUID();
  const captures = { stdout: store.begin(sessionId, `${callId}-stdout`), stderr: store.begin(sessionId, `${callId}-stderr`) };
  const child = spawn(executable, args, { stdio: ["inherit", "pipe", "pipe"] });
  // Preserve stdout/stderr ownership. Capture failures must fail visibly; a
  // partial log is never advertised as the complete original.
  let captureError: Error | undefined;
  const append = (channel: "stdout" | "stderr", chunk: Buffer) => {
    try { if (captureError) process[channel].write(chunk); else captures[channel].append(chunk); }
    catch (cause) { captureError = cause instanceof Error ? cause : new Error("Log capture failed."); process[channel].write(chunk); child.kill("SIGTERM"); }
  };
  child.stdout.on("data", chunk => append("stdout", chunk)); child.stderr.on("data", chunk => append("stderr", chunk));
  const forward = (signal: NodeJS.Signals) => child.kill(signal);
  const interrupt = () => forward("SIGINT"), terminate = () => forward("SIGTERM");
  process.on("SIGINT", interrupt); process.on("SIGTERM", terminate);
  try {
    const result = await new Promise<{ code: number; signal: NodeJS.Signals | null }>((resolve, reject) => {
      child.once("error", reject); child.once("close", (code, signal) => resolve({ code: code ?? (signal === "SIGINT" ? 130 : 143), signal }));
    });
    if (captureError) throw captureError;
    // Bounded memory even for an unbounded build log. Huge originals are fully
    // on disk and require explicit read_log, never a truncated error summary.
    for (const channel of ["stdout", "stderr"] as const) {
      const capture = captures[channel], pointer = capture.finish();
      if (!pointer.bytes) continue;
      let summary = "[MyCodex: complete output exceeds context limit; read original including failure details.]";
      if (pointer.bytes <= 2 * 1024 * 1024) {
        const layer1 = compressLayer1(fs.readFileSync(capture.file, "utf8"), result.code);
        if (Buffer.byteLength(layer1) <= thresholdBytes) summary = layer1;
      }
      process[channel].write(`${summary}\n${logReadPointer(pointer)}\n`);
    }
    return result;
  } catch (cause) { captures.stdout.abort(); captures.stderr.abort(); throw cause; }
  finally { process.off("SIGINT", interrupt); process.off("SIGTERM", terminate); }
}
if (process.argv[1] && import.meta.url === pathToFileURL(path.resolve(process.argv[1])).href) {
  const [home, sessionId, executable, ...args] = process.argv.slice(2);
  runCompressedCommand({ home, sessionId, executable, args }).then(result => {
    if (typeof result !== "number" && result.signal) process.kill(process.pid, result.signal);
    else process.exitCode = typeof result === "number" ? result : result.code;
  }, cause => { console.error(`MyCodex compression failed: ${cause instanceof Error ? cause.message : "failed"}`); process.exitCode = 1; });
}

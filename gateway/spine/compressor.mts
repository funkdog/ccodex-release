import type { LogPointer } from "./contracts.mjs";
import { SpilloverStore } from "./storage.mjs";

export interface CompressionResult { output: string; layer1: string; changed: boolean; pointer?: LogPointer; omitted: boolean }
const failure = /(?:^not ok\b|\b(?:Error|AssertionError|FAILED|FAILURES?|panic|panicked|fatal|exception)\b|^\s*at\s|^\s*Traceback|^# fail [1-9]|^failures:|失败|异常|错误)/im;
/** Conservative deterministic templates. A nonzero exit/error/stack disables
 * all folding. Removed bytes remain in spillover, including escape sequences. */
export function compressLayer1(raw: string, exitCode = 0): string {
  const clean = raw.replace(/\x1b\][^\x07\x1b]*(?:\x07|\x1b\\)/g, "").replace(/\x1b\[[0-?]*[ -/]*[@-~]/g, "");
  const failed = exitCode !== 0 || failure.test(clean.replace(/^# fail 0\r?$/gm, ""));
  const lines = clean.split("\n"), output: string[] = [];
  let passed = 0, repeats = 0, previous: string | undefined, lockfile = false, lockCount = 0, tapDiagnostics = false;
  const flushRepeat = () => { if (repeats) output.push(`[MyCodex: ${repeats} additional identical log lines; original retained]`); repeats = 0; };
  const flushLock = () => { if (lockCount) output.push(`[MyCodex: ${lockCount} lockfile diff lines; original retained]`); lockCount = 0; };
  for (let index = 0; index < lines.length; index++) {
    const original = lines[index];
    // Only known numeric progress refreshes. Never discard arbitrary CR text.
    const line = !failed && /\r/.test(original) && original.split("\r").every(s => !s || /^\s*(?:\d{1,3}%|\[[#= .>\d/%-]+\])/.test(s))
      ? original.split("\r").filter(Boolean).at(-1) ?? "" : original;
    if (!failed && /^diff --git /.test(line)) { flushLock(); lockfile = /\/(?:package-lock\.json|pnpm-lock\.yaml|yarn\.lock|Cargo\.lock|poetry\.lock)(?:\s|$)/.test(line); }
    if (!failed && lockfile) { lockCount++; continue; }
    if (!failed && tapDiagnostics) {
      if (/^\s+(?:---|duration_ms:|type:|\.\.\.)/.test(line)) continue;
      tapDiagnostics = false;
    }
    if (!failed && /^# Subtest:/.test(line) && /^ok \d+\b/.test(lines[index + 1] ?? "")) continue;
    if (!failed && (/^ok \d+\b/.test(line) || /^test .+ \.\.\. ok$/.test(line) || /^.+::\S+ PASSED(?:\s|$)/.test(line) || /^✔ .+\([\d.]+m?s\)$/.test(line))) { passed++; tapDiagnostics = /^ok /.test(line); continue; }
    if (!failed && line && line === previous) { repeats++; continue; }
    flushRepeat(); output.push(line); previous = line;
  }
  flushRepeat(); flushLock();
  if (passed) output.push(`[MyCodex: ${passed} passing test verdicts; original retained]`);
  return output.join("\n");
}
export function logReadPointer(pointer: LogPointer) {
  return `[MyCodex original output: mycodex.read_log({"id":${JSON.stringify(pointer.id)},"startLine":1,"endLine":${Math.min(pointer.endLine, 10000)}}); total ${pointer.endLine} LF lines, ${pointer.bytes} bytes, sha256 ${pointer.sha256}. Ranges over 10000 lines must be split; use nextByteOffset until complete.]`;
}
export function compressOutput({ raw, store, sessionId, callId, exitCode = 0, thresholdBytes = 24 * 1024 }: {
  raw: Uint8Array; store: SpilloverStore; sessionId?: string; callId?: string; exitCode?: number; thresholdBytes?: number;
}): CompressionResult {
  if (!Number.isSafeInteger(thresholdBytes) || thresholdBytes < 256) throw new Error("Invalid compression threshold.");
  const bytes = Buffer.from(raw), text = bytes.toString("utf8"), layer1 = compressLayer1(text, exitCode);
  const changed = !Buffer.from(layer1).equals(bytes);
  const pointer = changed || bytes.length > thresholdBytes ? store.save(bytes, sessionId, callId) : undefined;
  const omitted = Buffer.byteLength(layer1) > thresholdBytes;
  return { layer1, changed, pointer, omitted,
    output: pointer ? `${omitted ? "[MyCodex: output exceeds context limit; read the complete original below, including all failure details.]" : layer1}\n${logReadPointer(pointer)}` : layer1 };
}

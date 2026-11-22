import "../../tools/typescript-runtime.mjs";
import fs from "node:fs";
import path from "node:path";
import type { DisplaySink, FileChange, PlanStep } from "../display-contracts.mjs";
import { clipUtf8, displayLimits } from "../display-projector.mjs";
import { extractToolOutput } from "../media.mjs";
export const object = (value: unknown): Record<string, unknown> => value && typeof value === "object" && !Array.isArray(value) ? value as Record<string, unknown> : {};
export function displayOutputText(value: unknown): string {
  const { safe, output } = extractToolOutput(value);
  if (!Array.isArray(safe)) return clipUtf8(output);
  return clipUtf8(safe.map(entry => {
    const block = object(entry), nested = object(block.content);
    if (block.type === "text" && typeof block.text === "string") return block.text;
    if (block.type === "content" && nested.type === "text" && typeof nested.text === "string") return nested.text;
    return typeof entry === "string" ? entry : JSON.stringify(entry);
  }).join("\n"));
}
const string = (value: unknown): value is string => typeof value === "string" && value.length > 0;
export function planSteps(value: unknown): PlanStep[] | null {
  if (!Array.isArray(value) || value.length > 100) return null;
  const steps: PlanStep[] = [];
  for (const item of value) {
    const entry = object(item), step = entry.content;
    if (!string(step) || Buffer.byteLength(step) > 4096 || !["pending", "in_progress", "inProgress", "completed"].includes(String(entry.status))) return null;
    steps.push({ step, status: entry.status === "completed" ? "completed" : entry.status === "pending" ? "pending" : "inProgress" });
  }
  return steps;
}
export function unifiedDiff(file: string, before: string, after: string, kind: FileChange["kind"] = "update"): FileChange | null {
  if (Buffer.byteLength(before) + Buffer.byteLength(after) > 96 * 1024 || /[\r\n\0]/.test(file)) return null;
  const lines = (text: string) => text ? text.replace(/\n$/, "").split("\n") : [];
  const old = lines(before), next = lines(after);
  const section = (text: string, list: string[], marker: string) => list.map((line, index) => marker + line + "\n" +
    (index === list.length - 1 && !text.endsWith("\n") ? "\\ No newline at end of file\n" : "")).join("");
  const diff = `--- ${kind === "add" ? "/dev/null" : file}\n+++ ${kind === "delete" ? "/dev/null" : file}\n@@ -${old.length ? 1 : 0},${old.length} +${next.length ? 1 : 0},${next.length} @@\n` + section(before, old, "-") + section(after, next, "+");
  return Buffer.byteLength(diff) <= displayLimits.output ? { path: file, kind, diff } : null;
}
function editPreview(name: string, input: Record<string, unknown>, cwd: string): FileChange[] | null {
  if (!string(input.file_path) || !path.isAbsolute(input.file_path)) return null;
  const file = input.file_path;
  let before = "", exists = false;
  try {
    const real = fs.realpathSync(file), root = fs.realpathSync(cwd), relative = path.relative(root, real);
    if (relative.startsWith("..") || path.isAbsolute(relative) || fs.lstatSync(file).isSymbolicLink()) return null;
    const fd = fs.openSync(file, fs.constants.O_RDONLY | fs.constants.O_NOFOLLOW | fs.constants.O_NONBLOCK);
    try {
      const stat = fs.fstatSync(fd); if (!stat.isFile() || stat.size > 96 * 1024) return null;
      const bytes = Buffer.alloc(96 * 1024 + 1);
      let count = 0;
      while (count < bytes.length) { const size = fs.readSync(fd, bytes, count, bytes.length - count, count); if (!size) break; count += size; }
      if (count > 96 * 1024) return null;
      const value = bytes.subarray(0, count);
      before = value.toString("utf8");
      if (!Buffer.from(before).equals(value) || before.includes("\0")) return null;
      exists = true;
    } finally { fs.closeSync(fd); }
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== "ENOENT" || name !== "Write") return null;
    try { const relative = path.relative(fs.realpathSync(cwd), fs.realpathSync(path.dirname(file))); if (relative.startsWith("..") || path.isAbsolute(relative)) return null; } catch { return null; }
  }
  let after = before;
  if (name === "Write") { if (typeof input.content !== "string") return null; after = input.content; }
  else {
    const edits = name === "MultiEdit" ? input.edits : [input];
    if (!Array.isArray(edits) || !edits.length || edits.length > 100) return null;
    for (const value of edits) {
      const edit = object(value);
      if (!string(edit.old_string) || typeof edit.new_string !== "string") return null;
      const count = after.split(edit.old_string).length - 1;
      if (!count || (count > 1 && edit.replace_all !== true)) return null;
      after = edit.replace_all === true ? after.split(edit.old_string).join(edit.new_string) : after.replace(edit.old_string, () => edit.new_string as string);
      if (Buffer.byteLength(after) > 96 * 1024) return null;
    }
  }
  const change = unifiedDiff(file, before, after, exists ? "update" : "add"); return change ? [change] : null;
}
type Mapping = { kind: "command" | "file" | "mcp" | "plan" | "web"; start(): void; command?: string; steps?: PlanStep[]; changes?: FileChange[] };
export function claudeToolMapping(display: DisplaySink, id: string, name: string, raw: unknown, cwd: string): Mapping | null {
  const input = object(raw);
  if (Buffer.byteLength(JSON.stringify(input)) > displayLimits.arguments) return null;
  const source = { tool: name, arguments: structuredClone(input) };
  const command = (text: string, actionHint: Parameters<DisplaySink["commandStart"]>[0]["actionHint"]): Mapping => ({ kind: "command", command: text, start: () => display.commandStart({ id, command: text, cwd, actionHint, source }) });
  if (name === "Read" && string(input.file_path) && path.isAbsolute(input.file_path)) return command(`Read ${JSON.stringify(input.file_path)}`, { type: "read", path: input.file_path, name: path.basename(input.file_path) });
  if (["Grep", "Glob"].includes(name) && string(input.pattern)) return command(`${name} ${JSON.stringify(input)}`, { type: "search", query: input.pattern, path: string(input.path) ? path.resolve(cwd, input.path) : null });
  if (name === "LS" && (input.path === undefined || string(input.path))) return command(`LS ${JSON.stringify(input.path ?? cwd)}`, { type: "listFiles", path: string(input.path) ? path.resolve(cwd, input.path) : cwd });
  if (name === "Bash" && string(input.command)) return command(input.command, { type: "unknown" });
  if (["Edit", "MultiEdit", "Write"].includes(name)) {
    const changes = editPreview(name, input, cwd); if (changes) return { kind: "file", changes, start: () => display.fileChangeStart({ id, changes, source }) };
  }
  if (name === "TodoWrite") { const steps = planSteps(input.todos); if (steps) return { kind: "plan", steps, start() {} }; }
  if (name === "WebSearch" && string(input.query)) return { kind: "web", start: () => display.webSearch({ id, query: input.query as string, action: { type: "search", query: input.query as string } }) };
  if (name === "WebFetch" && string(input.url)) {
    try { const url = new URL(input.url); if (["http:", "https:"].includes(url.protocol)) return { kind: "web", start: () => display.webSearch({ id, query: input.url as string, action: { type: "openPage", url: input.url as string } }) }; } catch {}
  }
  const match = /^mcp__(.+?)__(.+)$/.exec(name);
  if (match) return { kind: "mcp", start: () => display.mcpStart({ id, server: match[1]!, tool: match[2]!, arguments: raw }) };
  return null;
}
export function endToolDisplay(display: DisplaySink, mapping: Mapping, id: string, success: boolean, output: unknown, metadata: unknown = {}) {
  const detail = object(metadata), text = displayOutputText(output);
  if (mapping.kind === "command") display.commandEnd({ id, status: success ? "completed" : "failed", output: clipUtf8(text),
    exitCode: Number.isInteger(detail.exitCode) ? detail.exitCode as number : null,
    durationMs: Number.isSafeInteger(detail.durationMs) ? detail.durationMs as number : null });
  else if (mapping.kind === "file") display.fileChangeEnd({ id, status: success ? "completed" : "failed" });
  else if (mapping.kind === "mcp") display.mcpEnd({ id, status: success ? "completed" : "failed", result: output, errorMessage: success ? null : text });
  else if (mapping.kind === "plan" && success) display.planUpdate({ steps: mapping.steps! });
  else if (mapping.kind === "web" && success) mapping.start();
}

import { createHash } from "node:crypto";
import path from "node:path";
import fs from "node:fs";
import type { SquadSessionSettings } from "./spine/squad-v2-contracts.mjs";
import type { HostThreadRef } from "./spine/host-thread-contracts.mjs";

export type SquadNativeRequest = { operation: "list" | "models"; cursor?: string | null }
  | { operation: "read" }
  | { operation: "turn"; turnId: string; includeText?: boolean }
  | { operation: "create"; requestId: string; cwd: string; model?: string; reasoningEffort?: string; anchorThreadId?: string; approvalPolicy?: string; sandbox?: string; trusted?: boolean; stripSquadTools?: boolean }
  | { operation: "send"; requestId: string; message: string; cwd: string; stripSquadTools?: boolean; readOnly?: boolean }
  | { operation: "receipt"; requestId: string };
export interface SquadNativeThread { id: string; title: string; cwd: string; model: string | null; reasoningEffort?: string | null; status: unknown; archived: boolean; hostRef: HostThreadRef; activeSubagents?: boolean }
export interface SquadNativeTurn { status: string; thread?: SquadNativeThread; text?: string; error?: { message: string } }
export interface SquadNativeReceipt { state: "accepted" | "not_sent" | "unknown" | "pending" | "not_found"; result?: { thread?: SquadNativeThread; turnId?: string }; reason?: string }
const object = (value: unknown) => {
  if (!value || typeof value !== "object" || Array.isArray(value)) throw new Error("Invalid Squad native response.");
  return value as Record<string, unknown>;
};
const nativeModel = (id: string) => !id.startsWith("mycodex/") || /^mycodex\/codex-(?:copilot|gemini)\//.test(id);
const uuid = /^[a-f0-9]{8}(?:-[a-f0-9]{4}){3}-[a-f0-9]{12}$/i;

type Permissions = { approvalPolicy?: string; sandbox?: string; config?: Record<string, unknown> };
function readRolloutContext<T>(rolloutPath: unknown, select: (payload: Record<string, unknown>) => T | undefined): T | undefined {
  if (typeof rolloutPath !== "string" || !path.isAbsolute(rolloutPath)) return undefined;
  let fd: number | undefined;
  try {
    const stat = fs.lstatSync(rolloutPath);
    if (!stat.isFile() || stat.isSymbolicLink() || stat.size === 0) return undefined;
    fd = fs.openSync(rolloutPath, fs.constants.O_RDONLY | fs.constants.O_NOFOLLOW);
    // Keep byte fragments until a complete JSONL line is available: decoding
    // individual blocks would corrupt UTF-8 characters split across reads.
    let carry: Buffer[] = [];
    for (let end = fs.fstatSync(fd).size; end > 0;) {
      const start = Math.max(0, end - 64 * 1024), block = Buffer.alloc(end - start);
      let read = 0;
      while (read < block.length) {
        const count = fs.readSync(fd, block, read, block.length - read, start + read);
        if (!count) throw new Error("Rollout changed while reading permissions.");
        read += count;
      }
      let lineEnd = block.length;
      for (let i = block.length - 1; i >= -1; i--) {
        if (i >= 0 && block[i] !== 10) continue;
        if (i === -1 && start > 0) break;
        const segment = block.subarray(i + 1, lineEnd);
        const line = (carry.length ? Buffer.concat([segment, ...carry.reverse()]) : segment).toString("utf8").trim();
        carry = [];
        lineEnd = i;
        if (!line || !line.includes('"turn_context"')) continue;
        // A partially written final record or corrupt row must not hide the
        // latest valid context earlier in the transcript.
        try {
          const row = JSON.parse(line) as { type?: string; payload?: Record<string, unknown> } | null;
          if (row?.type !== "turn_context" || !row.payload || typeof row.payload !== 'object' || Array.isArray(row.payload)) continue;
          const selected = select(row.payload);
          if (selected !== undefined) return selected;
        } catch { /* Skip this row, not the remaining history. */ }
      }
      if (start > 0 && lineEnd > 0) carry.push(block.subarray(0, lineEnd));
      end = start;
    }
  } catch { /* Fall back to host defaults when rollout history is unavailable. */ }
  finally { if (fd !== undefined) try { fs.closeSync(fd); } catch {} }
  return undefined;
}

function readRolloutPermissions(rolloutPath: unknown): Permissions {
  return readRolloutContext(rolloutPath, payload => {
    const approvalPolicy = typeof payload.approval_policy === "string" && ["untrusted", "on-request", "never"].includes(payload.approval_policy) ? payload.approval_policy : undefined;
    const sb = payload.sandbox_policy as Record<string, unknown> | undefined;
    const sandbox = sb && ["danger-full-access", "read-only", "workspace-write"].includes(String(sb.type)) ? String(sb.type) : undefined;
    if (!approvalPolicy && !sandbox) return undefined;
    const config: Record<string, unknown> = {};
    if (sandbox === "workspace-write" && sb) {
      if (Array.isArray(sb.writable_roots) && sb.writable_roots.every(root => typeof root === "string" && path.isAbsolute(root))) config["sandbox_workspace_write.writable_roots"] = sb.writable_roots;
      for (const key of ["network_access", "exclude_tmpdir_env_var", "exclude_slash_tmp"]) if (typeof sb[key] === "boolean") config[`sandbox_workspace_write.${key}`] = sb[key];
    }
    return { ...(approvalPolicy ? { approvalPolicy } : {}), ...(sandbox ? { sandbox } : {}), config };
  }) ?? {};
}

function sessionSettings(value: Record<string, unknown>): SquadSessionSettings {
  const record = (input: unknown): Record<string, unknown> => input && typeof input === 'object' && !Array.isArray(input) ? input as Record<string, unknown> : {};
  const collaboration = record(record(value.collaboration_mode ?? value.collaborationMode).settings);
  const settings: SquadSessionSettings = {};
  const model = typeof value.model === 'string' && value.model.trim() ? value.model : collaboration.model;
  if (typeof model === 'string' && model.trim()) settings.model = model.trim();
  for (const effort of [collaboration.reasoning_effort, value.reasoningEffort, value.effort, value.reasoning_effort]) {
    if (effort === null || typeof effort === 'string' && effort.trim()) {
      settings.reasoningEffort = typeof effort === 'string' ? effort.trim() : null; break;
    }
  }
  return settings;
}

const subagentDirectories = new Map<string, { stamp: string; entries: fs.Dirent[] }>();
const subagentChildren = new Map<string, { entries: fs.Dirent[]; expires: number; files: Map<string, fs.Stats> }>();
const subagentFiles = new Map<string, { stamp: string; parent?: string; active?: boolean }>();
const subagentObservations = new Map<string, { parentStamp?: string; expires: number; activePath?: string; activeStamp?: string }>();
const SUBAGENT_TTL_MS = 2000;
const statStamp = (stat: fs.Stats) => `${stat.ino}:${stat.mtimeMs}:${stat.ctimeMs}:${stat.size}`;
function cacheEntry<T>(cache: Map<string, T>, key: string, value: T, limit: number) {
  cache.delete(key); cache.set(key, value);
  if (cache.size > limit) cache.delete(cache.keys().next().value!);
}
function rolloutDirEntries(dir: string): fs.Dirent[] {
  const stamp = statStamp(fs.lstatSync(dir)), cached = subagentDirectories.get(dir);
  if (cached?.stamp === stamp) return cached.entries;
  const entries = fs.readdirSync(dir, { withFileTypes: true });
  cacheEntry(subagentDirectories, dir, { stamp, entries }, 256);
  return entries;
}
function candidateRolloutDirs(rolloutPath: string): string[] {
  const ownDir = path.dirname(rolloutPath);
  const day = path.basename(ownDir), monthDir = path.dirname(ownDir), month = path.basename(monthDir), yearDir = path.dirname(monthDir), year = path.basename(yearDir), sessionsRoot = path.dirname(yearDir);
  if (!/^\d{4}$/.test(year) || !/^\d{2}$/.test(month) || !/^\d{2}$/.test(day)) return [ownDir];
  const ownStamp = `${year}-${month}-${day}`;
  const dirs: Array<{ stamp: string; dir: string }> = [];
  try {
    for (const y of rolloutDirEntries(sessionsRoot)) {
      if (!y.isDirectory() || !/^\d{4}$/.test(y.name) || y.name < year) continue;
      for (const m of rolloutDirEntries(path.join(sessionsRoot, y.name))) {
        if (!m.isDirectory() || !/^\d{2}$/.test(m.name)) continue;
        for (const d of rolloutDirEntries(path.join(sessionsRoot, y.name, m.name))) {
          if (!d.isDirectory() || !/^\d{2}$/.test(d.name)) continue;
          const stamp = `${y.name}-${m.name}-${d.name}`;
          if (stamp >= ownStamp) dirs.push({ stamp, dir: path.join(sessionsRoot, y.name, m.name, d.name) });
        }
      }
    }
  } catch { return [ownDir]; }
  dirs.sort((a, b) => b.stamp.localeCompare(a.stamp));
  const result = dirs.slice(0, 14).map(entry => entry.dir);
  if (!result.includes(ownDir)) result.push(ownDir);
  return result;
}

function latestSubagentTurnActive(fd: number, size: number): boolean {
  const chunkSize = 64 * 1024;
  const ended = new Set<string>();
  let carry = "";
  for (let end = size; end > 0;) {
    const start = Math.max(0, end - chunkSize);
    const buf = Buffer.alloc(end - start);
    const bytesRead = fs.readSync(fd, buf, 0, buf.length, start);
    if (bytesRead <= 0) break;
    const text = buf.subarray(0, bytesRead).toString("utf8") + carry;
    const lines = text.split("\n");
    carry = start > 0 ? (lines.shift() ?? "") : "";
    for (let i = lines.length - 1; i >= 0; i--) {
      const line = lines[i].trim();
      if (!line || (!line.includes('"task_') && !line.includes('"turn_aborted"'))) continue;
      let row: { type?: string; payload?: { type?: string; turn_id?: string } } | null;
      try { row = JSON.parse(line); } catch { continue; }
      if (row?.type !== "event_msg" || !row.payload?.turn_id) continue;
      if (row.payload.type === "task_complete" || row.payload.type === "turn_aborted") ended.add(row.payload.turn_id);
      else if (row.payload.type === "task_started") return !ended.has(row.payload.turn_id);
    }
    end = start;
  }
  return false;
}

function rolloutStat(file: string) {
  try { return fs.lstatSync(file, { throwIfNoEntry: false }); }
  catch { return undefined; }
}
function childRolloutStats(dir: string, now: number) {
  const entries = rolloutDirEntries(dir), cached = subagentChildren.get(dir);
  if (cached?.entries === entries && now < cached.expires) return cached.files;
  const files = new Map<string, fs.Stats>();
  for (const entry of entries) {
    if (!entry.isFile() || !entry.name.startsWith("rollout-") || !entry.name.endsWith(".jsonl")) continue;
    const file = path.join(dir, entry.name), stat = rolloutStat(file);
    if (stat?.isFile() && stat.size) files.set(file, stat);
  }
  cacheEntry(subagentChildren, dir, { entries, expires: now + SUBAGENT_TTL_MS, files }, 256);
  return files;
}
export function hasActiveNativeSubagents(rolloutPath: unknown, parentThreadId: string, stationary = false): boolean {
  if (typeof rolloutPath !== "string" || !path.isAbsolute(rolloutPath) || !uuid.test(parentThreadId)) return false;
  const key = `${parentThreadId}:${stationary}:${rolloutPath}`, now = Date.now();
  const parentStat = rolloutStat(rolloutPath);
  const parentStamp = parentStat && statStamp(parentStat);
  const cached = subagentObservations.get(key);
  const previousActive = cached?.activePath;
  const activeStat = previousActive ? rolloutStat(previousActive) : undefined;
  if (cached && cached.parentStamp === parentStamp && now < cached.expires) {
    if (!previousActive) return false;
    if (activeStat && statStamp(activeStat) === cached.activeStamp) return true;
  }
  const rememberActive = (activePath: string, activeStamp: string) => {
    cacheEntry(subagentObservations, key, { parentStamp, expires: now + SUBAGENT_TTL_MS, activePath, activeStamp }, 1024);
    return true;
  };
  for (const dir of candidateRolloutDirs(rolloutPath)) {
    let children: Map<string, fs.Stats>;
    try { children = childRolloutStats(dir, now); } catch { continue; }
    for (const [childPath, listed] of children) {
      if (childPath === rolloutPath) continue;
      let fd: number | undefined;
      try {
        const stat = childPath === previousActive ? activeStat : listed;
        if (!stat?.isFile() || !stat.size) continue;
        if (parentStat?.birthtimeMs && stat.mtimeMs < Math.min(parentStat.birthtimeMs, parentStat.mtimeMs)) continue;
        const stamp = statStamp(stat), known = subagentFiles.get(childPath);
        if (known?.stamp === stamp && known.parent !== parentThreadId) continue;
        if (known?.stamp === stamp && known.active !== undefined) {
          if (!known.active) continue;
          return rememberActive(childPath, stamp);
        }
        fd = fs.openSync(childPath, fs.constants.O_RDONLY | fs.constants.O_NOFOLLOW);
        let parent = known?.stamp === stamp ? known.parent : undefined;
        if (!parent) {
          const head = Buffer.alloc(Math.min(stat.size, 16 * 1024));
          const size = fs.readSync(fd, head, 0, head.length, 0), newline = head.indexOf(10);
          const meta = JSON.parse(head.subarray(0, newline < 0 ? size : newline).toString("utf8")) as { type?: string; payload?: { parent_thread_id?: string; thread_source?: string; source?: { subagent?: unknown } } };
          const subagent = meta?.payload?.source?.subagent as { other?: string } | string | undefined;
          if (meta?.type === "session_meta" && meta.payload?.thread_source !== "guardian_review" &&
              !(typeof subagent === "object" && subagent?.other === "guardian")) parent = meta.payload?.parent_thread_id;
        }
        const active = parent === parentThreadId ? latestSubagentTurnActive(fd, stat.size) : undefined;
        cacheEntry(subagentFiles, childPath, { stamp, parent, active }, 8192);
        if (active) return rememberActive(childPath, stamp);
      } catch { /* Ignore unreadable or concurrently rotating sibling transcripts. */ }
      finally { if (fd !== undefined) try { fs.closeSync(fd); } catch {} }
    }
  }
  // Old unchanged parents with no observed active child need only a periodic
  // recheck. A resumed parent invalidates the cache immediately via its mtime.
  const ttl = stationary && parentStat && now - parentStat.mtimeMs > 5 * 60_000 ? 60_000 : SUBAGENT_TTL_MS;
  cacheEntry(subagentObservations, key, { parentStamp, expires: now + ttl }, 1024);
  return false;
}

function workerMcpServerOverride(home?: string): Record<string, unknown> {
  const serverScript = path.resolve(import.meta.dirname, "spine/mcp-server.mjs");
  const candidates = [
    typeof home === "string" && path.isAbsolute(home) ? path.join(home, ".mycodex", "squad-worker-client.json") : undefined,
    process.env.CCODEX_GATEWAY_CONNECTION,
  ];
  for (const connection of candidates) {
    if (typeof connection !== "string" || !path.isAbsolute(connection)) continue;
    try {
      if (fs.statSync(connection).isFile() && fs.statSync(serverScript).isFile()) {
        return { command: process.execPath, args: [serverScript, connection, "--worker"], startup_timeout_sec: 15, tool_timeout_sec: 60 };
      }
    } catch { /* Try next candidate or disable mycodex MCP on worker threads. */ }
  }
  return { command: "", enabled: false };
}

/** Squad's explicit commands share transport with native host reads, without
 * depending on WorkItem or granting the P3 automatic dispatcher authority. */
export function createSquadNativeHandler({ request, ownsThread, runExclusive, home }: {
  request(method: string, params: Record<string, unknown>): Promise<unknown>;
  ownsThread(id: string): unknown;
  runExclusive<T>(id: string, action: () => Promise<T>): Promise<T>;
  home?: string;
}) {
  const receipts = new Map<string, { fingerprint: string; receipt: SquadNativeReceipt }>();
  const strippedThreads = new Set<string>();
  const thread = (value: unknown, ref: HostThreadRef, observeContext = false): SquadNativeThread => {
    const t = object(value);
    if (typeof t.id !== "string" || !/^[a-f0-9]{8}(?:-[a-f0-9]{4}){3}-[a-f0-9]{12}$/.test(t.id) || ownsThread(t.id) || typeof t.cwd !== "string") throw new Error("Invalid native Squad thread.");
    const observed = { ...sessionSettings(t), ...(observeContext ? readRolloutContext(t.path, payload => {
      const settings = sessionSettings(payload);
      return Object.keys(settings).length ? settings : undefined;
    }) : {}) };
    return { id: t.id, title: String(t.name || t.preview || t.id).slice(0, 300), cwd: t.cwd,
      model: observed.model ?? null, ...(observed.reasoningEffort !== undefined ? { reasoningEffort: observed.reasoningEffort } : {}), status: t.status ?? { type: "idle" }, archived: t.archived === true, hostRef: { ...ref, threadId: t.id } };
  };
  const readTarget = async (ref: HostThreadRef) => {
    const response = object(await request("thread/read", { threadId: ref.threadId, includeTurns: false }));
    const target = object(response.thread);
    if (target.id !== ref.threadId || ownsThread(ref.threadId)) throw new Error("Native returned another thread.");
    return target;
  };
  const observeThread = (rawThread: Record<string, unknown>, ref: HostThreadRef) => {
    const target = thread(rawThread, ref, true);
    const type = typeof target.status === "object" && target.status ? object(target.status).type : target.status;
    if (hasActiveNativeSubagents(rawThread.path, target.id, ["idle", "completed", "notLoaded"].includes(String(type)))) target.activeSubagents = true;
    return target;
  };
  return async (ref: HostThreadRef, raw: unknown): Promise<unknown> => {
    const p = object(raw), operation = p.operation;
    const allowed = operation === "create" ? ["operation", "requestId", "cwd", "model", "reasoningEffort", "anchorThreadId", "approvalPolicy", "sandbox", "trusted", "stripSquadTools"] : operation === "send" ? ["operation", "requestId", "message", "cwd", "stripSquadTools", "readOnly"]
      : operation === "receipt" ? ["operation", "requestId"] : operation === "list" ? ["operation", "cursor"] : operation === "turn" ? ["operation", "turnId", "includeText"] : ["operation"];
    if (Object.keys(p).some(key => !allowed.includes(key)) || !["list", "models", "read", "create", "send", "receipt", "turn"].includes(String(operation))) throw new Error("Invalid Squad native command.");
    if (operation === "list") {
      if (p.cursor != null && typeof p.cursor !== "string") throw new Error("Invalid native cursor.");
      const page = object(await request("thread/list", { archived: false, limit: 100, cursor: p.cursor ?? null }));
      if (!Array.isArray(page.data)) throw new Error("Invalid native session page.");
      return { threads: page.data.filter(t => t && typeof t.id === "string" && !ownsThread(t.id)).map(t => thread(t, ref)), nextCursor: page.nextCursor ?? null };
    }
    if (operation === "models") {
      const page = object(await request("model/list", {}));
      if (!Array.isArray(page.data)) throw new Error("Invalid native models.");
      return { models: page.data.filter(m => typeof m.id === "string" && nativeModel(m.id)).map(m => ({ id: m.id, label: m.displayName || m.id, efforts: (m.supportedReasoningEfforts ?? []).map((e: { reasoningEffort: string }) => e.reasoningEffort) })) };
    }
    if (operation === "read") return { thread: observeThread(await readTarget(ref), ref) };
    if (operation === "turn") {
      if (p.includeText !== undefined && typeof p.includeText !== "boolean") throw new Error("Invalid turn text flag.");
      if (typeof p.turnId !== "string" || !p.turnId.length || p.turnId.length > 128) throw new Error("Invalid native turn identity.");
      const cursors = new Set<string>(); let cursor: string | null = null;
      let turn;
      for (let pageIndex = 0; pageIndex < 5; pageIndex++) {
        const page = object(await request("thread/turns/list", { threadId: ref.threadId, limit: 100, itemsView: p.includeText ? "full" : "notLoaded", sortDirection: "desc", cursor }));
        if (!Array.isArray(page.data)) throw new Error("Invalid native turn page.");
        turn = page.data.find(turn => turn?.id === p.turnId);
        if (turn) break;
        if (page.nextCursor == null) break;
        if (typeof page.nextCursor !== "string" || cursors.has(page.nextCursor)) throw new Error("Invalid native turn pagination.");
        cursor = page.nextCursor; cursors.add(cursor);
      }
      const target = await readTarget(ref);
      // Headless peers may only supply status. Keep their turn API usable
      // while full peers return the same observation used for a Squad read.
      const observed = typeof target.cwd === "string" ? { thread: observeThread(target, ref) } : {};
      if (!turn) return { status: "unknown", ...observed };
      const status = typeof target.status === "object" && target.status ? object(target.status) : { type: target.status };
      const waiting = ["waitingOnApproval", "waitingOnUserInput"].find(flag => status.type === flag || Array.isArray(status.activeFlags) && status.activeFlags.includes(flag));
      return { status: ["inProgress", "active", "running"].includes(turn.status) ? waiting ?? turn.status : turn.status, ...observed, threadStatus: target.status,
        ...(typeof turn.error?.message === "string" ? { error: { message: turn.error.message.slice(0, 4000) } } : {}),
        ...(p.includeText ? { text: (turn.items ?? []).filter((i: Record<string, unknown>) => i.type === "agentMessage" && typeof i.text === "string").map((i: Record<string, unknown>) => i.text).at(-1)?.slice(0, 3900) ?? "" } : {}) };
    }
    if (typeof p.requestId !== "string" || !/^[a-f0-9]{8}(?:-[a-f0-9]{4}){3}-[a-f0-9]{12}$/.test(p.requestId)) throw new Error("Squad mutation requires a request UUID.");
    if (operation === "receipt") return receipts.get(p.requestId)?.receipt ?? { state: "not_found" };
    if (typeof p.cwd !== "string" || !path.isAbsolute(p.cwd) || p.cwd.length > 4096 ||
        p.reasoningEffort !== undefined && (typeof p.reasoningEffort !== "string" || !/^[a-z][a-z0-9_-]{0,59}$/.test(p.reasoningEffort)) ||
        p.model !== undefined && (typeof p.model !== "string" || !nativeModel(p.model)) ||
        p.anchorThreadId !== undefined && (typeof p.anchorThreadId !== "string" || !uuid.test(p.anchorThreadId) || Boolean(ownsThread(p.anchorThreadId))) ||
        operation === "send" && (typeof p.message !== "string" || !p.message.trim() || Buffer.byteLength(p.message) > 24576)) throw new Error("Invalid Squad native mutation.");
    if (p.approvalPolicy !== undefined && !["untrusted", "on-request", "never"].includes(String(p.approvalPolicy)) ||
        p.sandbox !== undefined && !["read-only", "workspace-write", "danger-full-access"].includes(String(p.sandbox)) ||
        p.trusted !== undefined && typeof p.trusted !== "boolean" ||
        p.stripSquadTools !== undefined && typeof p.stripSquadTools !== "boolean" ||
        p.readOnly !== undefined && typeof p.readOnly !== "boolean") throw new Error("Invalid Squad permissions.");
    const fingerprint = createHash("sha256").update(JSON.stringify([ref, p])).digest("hex"), previous = receipts.get(p.requestId);
    if (previous && previous.fingerprint !== fingerprint && previous.receipt.state !== "not_sent") throw new Error("Request ID belongs to another Squad action.");
    if (previous && previous.receipt.state !== "not_sent") return previous.receipt;
    if (!previous && receipts.size >= 512) return { state: "not_sent", reason: "receipt_capacity" };
    const entry = { fingerprint, receipt: { state: "pending" } as SquadNativeReceipt }; receipts.set(p.requestId, entry);
    let sent = false;
    try {
      if (operation === "create") {
        let inherited: Permissions = {};
        if (typeof p.anchorThreadId === "string") {
          try {
            const anchorRead = object(await request("thread/read", { threadId: p.anchorThreadId, includeTurns: false }));
            inherited = readRolloutPermissions(object(anchorRead.thread).path);
          } catch { /* Anchor read is advisory for inheriting non-escalating permissions. */ }
        }
        const config: Record<string, unknown> = { ...inherited.config,
          "shell_environment_policy.set": { PATH: [path.dirname(process.execPath), process.env.PATH].filter(Boolean).join(path.delimiter) },
          ...(p.reasoningEffort ? { model_reasoning_effort: p.reasoningEffort } : {}),
          ...(p.trusted !== undefined ? { [`projects.${JSON.stringify(p.cwd)}.trust_level`]: p.trusted ? "trusted" : "untrusted" } : {}),
          ...(p.stripSquadTools ? { mcp_servers: { mycodex: workerMcpServerOverride(home) } } : {}) };
        if (p.sandbox !== undefined && p.sandbox !== inherited.sandbox) for (const key of Object.keys(config)) if (key.startsWith("sandbox_workspace_write.")) delete config[key];
        sent = true;
        const response = object(await request("thread/start", { cwd: p.cwd,
          ...(inherited.approvalPolicy ? { approvalPolicy: inherited.approvalPolicy } : {}), ...(inherited.sandbox ? { sandbox: inherited.sandbox } : {}),
          ...(p.approvalPolicy ? { approvalPolicy: p.approvalPolicy } : {}), ...(p.sandbox ? { sandbox: p.sandbox } : {}),
          ...(p.model ? { model: p.model } : {}), config }));
        const created = thread(response.thread, ref);
        if (p.stripSquadTools) strippedThreads.add(created.id);
        entry.receipt = { state: "accepted", result: { thread: created } };
      } else await runExclusive(ref.threadId, async () => {
        const before = object(await request("thread/read", { threadId: ref.threadId, includeTurns: false }));
        const t = object(before.thread), status = typeof t.status === "string" ? t.status : object(t.status).type;
        if (t.id !== ref.threadId || ownsThread(ref.threadId) || t.archived === true || status === "active") throw new Error("Native chat is busy, archived or changed.");
        if (typeof t.cwd !== "string" || fs.realpathSync(t.cwd) !== fs.realpathSync(p.cwd as string)) throw new Error("Native workspace changed.");
        const stripMcp = p.stripSquadTools === true || strippedThreads.has(ref.threadId);
        const needsStripResume = p.stripSquadTools === true && !strippedThreads.has(ref.threadId);
        // Resume through the router so saved Codex + Copilot/Gemini provider,
        // model, effort and permission settings remain owned by that session.
        const loaded = object(await request("thread/loaded/list", {}));
        if (!Array.isArray(loaded.data) || !loaded.data.includes(ref.threadId) || needsStripResume) {
          await request("thread/resume", { threadId: ref.threadId, ...(stripMcp ? { config: { mcp_servers: { mycodex: workerMcpServerOverride(home) } } } : {}) });
        }
        if (stripMcp) strippedThreads.add(ref.threadId);
        sent = true;
        const response = object(await request("turn/start", { threadId: ref.threadId, input: [{ type: "text", text: p.message }], clientUserMessageId: p.requestId,
          ...(p.readOnly ? { sandboxPolicy: { type: "readOnly" } } : {}) }));
        const turn = object(response.turn); if (typeof turn.id !== "string") throw new Error("Native acceptance is unknown.");
        entry.receipt = { state: "accepted", result: { turnId: turn.id } };
      });
    } catch (cause) { entry.receipt = { state: sent ? "unknown" : "not_sent", reason: sent ? "native_outcome_unknown" : cause instanceof Error ? cause.message : "precondition_failed" }; }
    return entry.receipt;
  };
}

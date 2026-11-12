import path from "node:path";
import { HistoryError, HistoryManager } from "../tools/history/manager.mjs";
import { codexBackend } from "../tools/history/backends.mjs";
import { protectCliBackend } from "./cli-session-ownership.mjs";
import { desktopSnapshot, desktopStateRoot } from "./desktop-runtime.mjs";
import { createSessionApi } from "./session-management-api.mjs";

const MAX_SELECTION = 500;

/** Metadata snapshots only serve checkboxes. Preview/apply keep their live checks. */
export class DesktopSessionReader {
  constructor({ home, core, backendFactory, now = Date.now, cacheLifetimeMs = 30000 } = {}) {
    this.home = home;
    this.now = now;
    this.cacheLifetimeMs = cacheLifetimeMs;
    this.factory = backendFactory || (async () => {
      const root = path.resolve(import.meta.dirname, "..");
      const runtime = core ? null : desktopSnapshot(root, {
        stateRoot: desktopStateRoot({ root, home }),
      });
      const selected = core || path.join(runtime.resources,
        process.platform === "win32" ? "codex.exe" : "codex");
      return protectCliBackend(await codexBackend({
        home, core: selected, nativeWriterLocks: true, databaseOnly: true,
      }), home);
    });
    this.initializing = null;
    this.backend = null;
    this.snapshot = null;
    this.refreshing = null;
    this.generation = 0;
    this.closed = false;
  }

  async manager() {
    if (this.closed) throw new HistoryError("interface_closing", "Desktop history reading is closing.");
    if (!this.initializing) {
      this.initializing = Promise.resolve().then(this.factory).then(backend => {
        this.backend = backend;
        return new HistoryManager({ ccodex: backend });
      }).catch(error => { this.initializing = null; throw error; });
    }
    return this.initializing;
  }

  async readSnapshot(fresh) {
    if (this.closed) throw new HistoryError("interface_closing", "Desktop history reading is closing.");
    if (this.refreshing) return this.refreshing;
    if (!fresh && this.snapshot && this.now() - this.snapshot.readAt < this.cacheLifetimeMs) {
      return this.snapshot.rows;
    }
    const generation = this.generation;
    this.refreshing = (async () => {
      const manager = await this.manager();
      const rows = await manager.sessions("ccodex");
      if (!this.closed && generation === this.generation) {
        this.snapshot = { rows, readAt: this.now() };
      }
      return rows;
    })().finally(() => { this.refreshing = null; });
    return this.refreshing;
  }

  async list({ query = "", cwd = "", archived, cursor = 0, limit = 50 } = {}) {
    if (typeof query !== "string" || typeof cwd !== "string" ||
        (archived !== undefined && typeof archived !== "boolean")) {
      throw new HistoryError("invalid_filter", "Use text and boolean Desktop history filters.");
    }
    if (!Number.isSafeInteger(cursor) || cursor < 0 || !Number.isSafeInteger(limit) ||
        limit < 1 || limit > 200) {
      throw new HistoryError("invalid_page", "Use a page size from 1 to 200.");
    }
    // The existing Desktop controller requests 200 only for cross-page selection.
    // Return its complete bounded selection in one reply, not another global scan
    // for each offset. Normal list/refresh/navigation always take a fresh snapshot.
    const selecting = limit === 200;
    const lowerQuery = query.toLowerCase(), lowerCwd = cwd.toLowerCase();
    const rows = (await this.readSnapshot(!selecting)).filter(row =>
      (!query || `${row.title} ${row.id} ${row.cwd}`.toLowerCase().includes(lowerQuery)) &&
      (!cwd || row.cwd.toLowerCase() === lowerCwd) &&
      (archived === undefined || row.archived === archived));
    const end = selecting && rows.length <= MAX_SELECTION ? rows.length : cursor + limit;
    return {
      schemaVersion: 1, total: rows.length,
      sessions: rows.slice(cursor, end).map(row => ({ ...row, operations: [...row.operations] })),
      nextCursor: end < rows.length ? end : null,
    };
  }

  invalidate() {
    this.generation++;
    this.snapshot = null;
  }

  async close() {
    this.closed = true;
    if (this.refreshing) await this.refreshing.catch(() => {});
    if (this.initializing) await this.initializing.catch(() => {});
    await this.backend?.close?.();
    this.snapshot = null;
  }
}

export function createDesktopSessionApi({ home, port, core, reader = new DesktopSessionReader({ home, core }),
  api = createSessionApi({ home, port }) } = {}) {
  const request = async (operation, args = {}) => {
    if (operation === "list") return reader.list(args);
    const result = await api(operation, args);
    if (operation === "apply" || (operation === "progress" && result.done)) reader.invalidate();
    return result;
  };
  request.close = () => reader.close();
  return request;
}

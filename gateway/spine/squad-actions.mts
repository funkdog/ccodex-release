import path from "node:path";
import fs from "node:fs";
import { createHash } from "node:crypto";
import { readJson, writeJson } from "./io.mjs";
import { privateDirectory } from "./storage.mjs";

export const notSent = (message: string) => Object.assign(new Error(message), { notSent: true });
/** Durable action identity prevents an unknown native acceptance or create
 * from being replayed after a gateway restart. Native receipts can reconcile
 * it on the original runtime; runtime replacement never authorizes a retry. */
export async function squadAction<T>(home: string, id: string, payload: unknown, run: () => Promise<T>, recover?: (context?: unknown) => Promise<T>, recoveryContext?: unknown): Promise<T> {
  if (!/^[a-f0-9]{8}(?:-[a-f0-9]{4}){3}-[a-f0-9]{12}$/.test(id)) throw new Error("Squad action requires a request UUID.");
  const directory = privateDirectory(path.join(home, ".mycodex", "squad-actions"));
  const file = path.join(directory, id + ".json"), fingerprint = createHash("sha256").update(JSON.stringify(payload)).digest("hex");
  const action = payload as { operation: string; id: string; workerId?: string; shortName?: string };
  const scope = path.join(directory, "scope-" + createHash("sha256").update(JSON.stringify([action.operation, action.id, action.workerId ?? action.shortName ?? ""])).digest("hex") + ".json");
  if (fs.existsSync(scope)) {
    const previous = readJson(scope, undefined, { privateFile: true }) as { requestId: string };
    if (!/^[a-f0-9-]{36}$/.test(previous.requestId)) throw new Error("Invalid Squad action scope.");
    if (previous.requestId !== id) {
      const state = readJson(path.join(directory, previous.requestId + ".json"), undefined, { privateFile: true }) as { state: string };
      if (!["accepted", "not_sent"].includes(state.state)) throw new Error(`Squad action ${previous.requestId} must be reconciled before another action on this target. No duplicate was sent.`);
    }
  }
  const old = fs.existsSync(file) ? readJson(file, undefined, { privateFile: true }) as { fingerprint: string; state: string; result: T; recoveryContext?: unknown } : null;
  if (old && old.fingerprint !== fingerprint) throw new Error("Request ID belongs to another Squad action.");
  if (old?.state === "accepted") return old.result;
  const context = old?.recoveryContext ?? recoveryContext;
  const write = (state: string, result?: T) => writeJson(file, { fingerprint, state, ...(context === undefined ? {} : { recoveryContext: context }), ...(result === undefined ? {} : { result }) });
  if (old && old.state !== "not_sent") {
    if (recover) {
      try { const result = await recover(old.recoveryContext); write("accepted", result); return result; } catch { /* Preserve uncertainty. */ }
    }
    throw new Error(`Squad action ${id} has an unknown outcome. Reconcile its original runtime before retrying; no duplicate was sent.`);
  }
  write("pending");
  writeJson(scope, { requestId: id });
  try { const result = await run(); write("accepted", result); return result; }
  catch (cause) { write((cause as { notSent?: boolean }).notSent ? "not_sent" : "unknown"); throw cause; }
}

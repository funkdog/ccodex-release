import fs from "node:fs";
import path from "node:path";
import { randomUUID } from "node:crypto";
import { readProcessIdentity, sameProcessLifetime } from "./desktop-process.mjs";

type Identity = { pid: number; platform: string; executable: string; lifetime: string };
type Receipt = { identity: Identity; sourceGeneration: string; helperIdentity?: Identity | null };
export type UiHealthState = "pending" | "ready" | "retrying" | "unavailable";
export interface UiComponentHealth { nativeSessions: string; workbench: string }
interface Health { schemaVersion: 1; sourceGeneration: string; app: Identity; helper: Identity;
  state: UiHealthState; updatedAt: string; since: string; components?: UiComponentHealth }
const states = new Set(["pending", "ready", "retrying", "unavailable"]);

/** A helper reports only its own binding state, never backend availability.
 * Separate from the launch receipt: an old helper cannot overwrite a new launch. */
export function createUiHealthPublisher(receiptFile: string, receipt: Receipt,
  helper = readProcessIdentity(process.pid) as Identity | null) {
  const file = path.join(path.dirname(receiptFile), "current-host-ui-status.json");
  let previous: UiHealthState | null = null, since = new Date().toISOString();
  return (state: UiHealthState, components?: UiComponentHealth) => {
    if (!helper) return;
    const owner = JSON.parse(fs.readFileSync(receiptFile, "utf8")) as Receipt;
    if (owner.sourceGeneration !== receipt.sourceGeneration || !sameProcessLifetime(owner.identity, receipt.identity)) return;
    const directory = fs.lstatSync(path.dirname(file));
    if (!directory.isDirectory() || directory.isSymbolicLink() || directory.uid !== process.getuid!() || (directory.mode & 0o077))
      throw new Error("UI health requires an owned private directory.");
    if (fs.existsSync(file)) {
      const stat = fs.lstatSync(file);
      if (!stat.isFile() || stat.isSymbolicLink() || stat.uid !== process.getuid!() || (stat.mode & 0o077))
        throw new Error("Invalid UI health file.");
    }
    if (state !== previous) { since = new Date().toISOString(); previous = state; }
    const health: Health = { schemaVersion: 1, sourceGeneration: receipt.sourceGeneration,
      app: receipt.identity, helper, state, updatedAt: new Date().toISOString(), since, ...(components ? { components } : {}) };
    const pending = file + "." + randomUUID() + ".pending";
    fs.writeFileSync(pending, JSON.stringify(health) + "\n", { flag: "wx", mode: 0o600 });
    try { fs.renameSync(pending, file); } finally { fs.rmSync(pending, { force: true }); }
  };
}

/** Status is evidence about the matching running lifetime. A living process,
 * old log line or stale heartbeat must never turn the badge green. */
export function resolveUiHealth(receipt: Receipt, value: unknown, now = Date.now()) {
  const unknown = { uiState: "unavailable", uiReason: "unreported" };
  if (!value || typeof value !== "object" || Array.isArray(value)) return unknown;
  const health = value as Partial<Health>;
  if (health.schemaVersion !== 1 || health.sourceGeneration !== receipt.sourceGeneration ||
      !health.app || !health.helper || !sameProcessLifetime(health.app, receipt.identity) ||
      !receipt.helperIdentity || !sameProcessLifetime(health.helper, receipt.helperIdentity) ||
      !states.has(health.state ?? "") || typeof health.updatedAt !== "string") return unknown;
  const age = now - Date.parse(health.updatedAt);
  if (!Number.isFinite(age) || age < -5000 || age > 45000) return { uiState: "unavailable", uiReason: "stale" };
  if (health.state === "pending" && (!health.since || !Number.isFinite(Date.parse(health.since)) ||
      now - Date.parse(health.since) > 45000)) return { uiState: "unavailable", uiReason: "initialization-timeout" };
  return { uiState: health.state === "ready" ? "ready" : health.state === "pending" ? "starting" : "unavailable",
    uiReason: health.state };
}

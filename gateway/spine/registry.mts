import fs from "node:fs";
import path from "node:path";
import type { Capability, SpineContext, SpineStatus, ModuleHealth } from "./contracts.mjs";
import { SpilloverStore, privateDirectory } from "./storage.mjs";

export const DIY_REQUEST_BYTES = 32 * 1024, DIY_RESPONSE_BYTES = 256 * 1024;
export function boundedJson(value: unknown, maxBytes: number) {
  const visit = (item: unknown, depth: number): void => {
    if (depth > 12) throw new Error("DIY nesting exceeds limit.");
    if (item === null || typeof item === "string" || typeof item === "boolean" || typeof item === "number" && Number.isFinite(item)) return;
    if (!item || typeof item !== "object") throw new Error("DIY expects JSON values.");
    if (!Array.isArray(item) && Object.getPrototypeOf(item) !== Object.prototype) throw new Error("DIY expects a plain object.");
    for (const [key, child] of Object.entries(item)) {
      if (["__proto__", "prototype", "constructor"].includes(key)) throw new Error("Unsafe DIY key.");
      visit(child, depth + 1);
    }
  };
  // Enforce byte budget before recursion (also bounds work for wide objects).
  const encoded = JSON.stringify(value);
  if (encoded === undefined || Buffer.byteLength(encoded) > maxBytes) throw new Error("DIY payload exceeds limit.");
  visit(value, 0);
  return encoded;
}
type Handler = (params: Record<string, unknown>, context: SpineContext) => unknown | Promise<unknown>;
export interface SpineRegistrar { register(method: string, capability: Capability, handle: Handler): void }
export class SpineRegistry {
  readonly logs: SpilloverStore;
  readonly startedAt = new Date().toISOString();
  private methods = new Map<string, { capability: Capability; handle: Handler }>();
  private tasks = new Set<Promise<unknown>>();
  private closing = false;
  private modules: Record<string, ModuleHealth> = {};
  private installing = new Set<string>();
  private activities = new Set<symbol>();
  private onActivity: () => void;
  get activeTasks() { return this.tasks.size; }
  get backgroundActivities() { return this.activities.size; }
  constructor(home: string, { onActivity = () => {} }: { onActivity?: () => void } = {}) {
    this.onActivity = onActivity;
    const directory = privateDirectory(path.join(home, "gateway", "spine"));
    const file = path.join(directory, "schema.json");
    if (!fs.existsSync(file)) fs.writeFileSync(file, JSON.stringify({ schemaVersion: 1 }), { flag: "wx", mode: 0o600 });
    const stat = fs.lstatSync(file);
    if (!stat.isFile() || stat.isSymbolicLink() || stat.size > 1024 || (process.platform !== "win32" && (stat.mode & 0o077)) || (process.getuid && stat.uid !== process.getuid()) || JSON.parse(fs.readFileSync(file, "utf8")).schemaVersion !== 1) throw new Error("Incompatible Spine schema.");
    this.logs = new SpilloverStore(home);
    this.register("diy/spine/status", "status:read", params => {
      if (Object.keys(params).length) throw new Error("Status takes no parameters.");
      const result: SpineStatus = { schemaVersion: 1, startedAt: this.startedAt, methods: [...this.methods.keys()], capabilities: [...new Set([...this.methods.values()].map(entry => entry.capability))], activeTasks: this.activeTasks, backgroundActivities: this.backgroundActivities, modules: structuredClone(this.modules) };
      return result;
    });
    this.register("diy/logs/read", "logs:read", async params => {
      try { return await this.logs.read(params); }
      catch (cause) {
        if (cause instanceof Error && (cause as NodeJS.ErrnoException).code) throw new Error("Log is unavailable, incomplete or inaccessible.");
        throw cause;
      }
    });
  }
  track<T>(work: () => T | Promise<T>): Promise<T> {
    if (this.closing) return Promise.reject(new Error("Spine is closing; new work was rejected."));
    const promise = Promise.resolve().then(work); this.tasks.add(promise); this.onActivity();
    return promise.finally(() => { this.tasks.delete(promise); this.onActivity(); });
  }
  /** A scheduler retains activity without manufacturing a never-ending task.
   * Shutdown does not wait for leases; their owner must stop its timers first. */
  retainActivity() {
    if (this.closing) throw new Error("Spine is closing.");
    const id = Symbol(); this.activities.add(id); this.onActivity();
    return () => { if (this.activities.delete(id)) this.onActivity(); };
  }
  async close() { this.closing = true; this.activities.clear(); while (this.tasks.size) await Promise.allSettled([...this.tasks]); }
  /** Publish a module's methods only after loading, configuration and storage
   * initialization all succeed. Failed modules cannot leave partial methods. */
  async installModule<T>(name: string, install: (scope: SpineRegistrar) => Promise<T> | T): Promise<T | undefined> {
    if (!/^[a-z][a-z0-9_-]*$/.test(name) || Object.hasOwn(this.modules, name) || this.installing.has(name) || this.closing) throw new Error("Invalid Spine module installation.");
    this.installing.add(name);
    const methods = new Map<string, { capability: Capability; handle: Handler }>();
    try {
      const result = await install({ register: (method, capability, handle) => {
        if (!/^diy\/[a-z][a-z0-9_-]*\/[a-z][a-z0-9_-]*$/.test(method) || methods.has(method) || this.methods.has(method)) throw new Error("Invalid or duplicate DIY method.");
        methods.set(method, { capability, handle });
      } });
      if (this.closing) throw new Error("Spine is closing.");
      for (const method of methods.keys()) if (this.methods.has(method)) throw new Error("Duplicate DIY method installed concurrently.");
      for (const [method, handler] of methods) this.methods.set(method, handler);
      this.modules[name] = { state: "ready" };
      return result;
    } catch {
      // Exception text may include configured commands, credentials or user
      // paths. Keep the public health record bounded and independent of it.
      this.modules[name] = { state: "unavailable", reason: "Module load, configuration or data initialization failed; existing data was preserved." };
      return undefined;
    } finally { this.installing.delete(name); }
  }
  register(method: string, capability: Capability, handle: Handler) {
    if (!/^diy\/[a-z][a-z0-9_-]*\/[a-z][a-z0-9_-]*$/.test(method) || this.methods.has(method)) throw new Error("Invalid or duplicate DIY method.");
    this.methods.set(method, { capability, handle });
  }
  async dispatch(method: string, params: unknown, context: SpineContext) {
    if (this.closing) throw new Error("Spine is closing.");
    if (!context.authenticated || !context.initialized) throw new Error("DIY requires an initialized authenticated connection.");
    if (context.signal?.aborted) throw new Error("DIY request cancelled.");
    const entry = this.methods.get(method);
    if (!entry || !context.capabilities.has(entry.capability)) throw new Error("DIY method unavailable or permission denied.");
    boundedJson(params, DIY_REQUEST_BYTES);
    if (!params || typeof params !== "object" || Array.isArray(params)) throw new Error("Invalid DIY parameters.");
    const result = method === "diy/spine/status" ? await entry.handle(params as Record<string, unknown>, context) : await this.track(() => entry.handle(params as Record<string, unknown>, context));
    if (context.signal?.aborted) throw new Error("DIY request cancelled.");
    boundedJson(result, DIY_RESPONSE_BYTES);
    return result;
  }
}

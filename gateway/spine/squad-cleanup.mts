import fs from "node:fs";
import path from "node:path";
import { parseHostRef, type HostThreadRef } from "./host-thread-contracts.mjs";
import { readJson, writeJson } from "./io.mjs";

export interface SquadCleanupJob {
  squadId: string; workerId: string; dispatchId?: string; ref: HostThreadRef; turnId?: string;
}
/** Durable retirement records, not execution tasks. Observe the original turn
 * without cancelling it; retain a job while its runtime cannot confirm an end. */
export class SquadCleanup {
  private file: string;
  private jobs = new Map<string, SquadCleanupJob>();
  private settled: (job: SquadCleanupJob) => Promise<boolean>;
  private clean: (job: SquadCleanupJob) => Promise<void>;
  private timer?: ReturnType<typeof setInterval>;
  private running?: Promise<void>;
  private closed = false;
  constructor(home: string, settled: (job: SquadCleanupJob) => Promise<boolean>, clean: (job: SquadCleanupJob) => Promise<void>) {
    this.file = path.join(home, ".mycodex", "squad-cleanups.json"); this.settled = settled; this.clean = clean;
  }
  private key(job: SquadCleanupJob) { return `${job.squadId}:${job.workerId}:${job.dispatchId ?? "legacy"}`; }
  start() {
    if (fs.existsSync(this.file)) {
      const jobs = readJson(this.file, undefined, { privateFile: true });
      if (!Array.isArray(jobs)) throw new Error("Invalid Squad cleanup records.");
      for (const job of jobs as SquadCleanupJob[]) {
        if (!job || !/^sq-[a-f0-9]{8}$/.test(job.squadId) || parseHostRef(job.ref).threadId !== job.workerId ||
            job.dispatchId !== undefined && !/^[a-f0-9]{8}(?:-[a-f0-9]{4}){3}-[a-f0-9]{12}$/.test(job.dispatchId) ||
            job.turnId !== undefined && (typeof job.turnId !== "string" || !job.turnId.length || job.turnId.length > 128)) throw new Error("Invalid Squad cleanup job.");
        this.jobs.set(this.key(job), job);
      }
    }
    this.watch();
  }
  add(job: SquadCleanupJob) { this.jobs.set(this.key(job), structuredClone(job)); this.save(); this.watch(); }
  async deleted(ref: HostThreadRef) {
    for (const [key, job] of this.jobs) if (job.workerId === ref.threadId && job.ref.hostId === ref.hostId && job.ref.accountId === ref.accountId) {
      await this.clean(job); this.jobs.delete(key); this.save();
    }
    if (!this.jobs.size) { clearInterval(this.timer); this.timer = undefined; }
  }
  private save() { writeJson(this.file, [...this.jobs.values()]); }
  private watch() {
    if (this.closed || !this.jobs.size || this.timer) return;
    this.timer = setInterval(() => { void this.poll(); }, 500); this.timer.unref();
  }
  private poll() {
    if (this.closed || this.running) return this.running;
    this.running = (async () => {
      for (const [key, job] of this.jobs) {
        if (this.closed) break;
        try {
          if (!await this.settled(job)) continue;
          await this.clean(job); this.jobs.delete(key); this.save();
        } catch { /* Offline runtime or failed cleanup: keep the durable job. */ }
      }
      if (!this.jobs.size) { clearInterval(this.timer); this.timer = undefined; }
    })().finally(() => { this.running = undefined; });
    return this.running;
  }
  async close() { this.closed = true; clearInterval(this.timer); await this.running; }
}

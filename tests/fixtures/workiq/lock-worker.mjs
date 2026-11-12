import fs from "node:fs";
import path from "node:path";
import { setTimeout as delay } from "node:timers/promises";
import { acquireCacheLock } from "../../../bridge/workiq/cache.mjs";

const [mode, file] = process.argv.slice(2);
if (!file || !path.isAbsolute(file) || !["exit", "hold", "contend"].includes(mode)) throw new Error("Isolated fixture arguments required.");
const unlock = await acquireCacheLock(file, { timeoutMs: 20_000 });
if (mode === "exit") {
  process.stdout.write(`${process.pid}\n`);
  process.exit(0); // Verifies synchronous normal-exit release, not token I/O.
}
if (mode === "hold") {
  process.stdout.write(`${process.pid}\n`);
  process.stdin.resume();
  process.stdin.once("end", () => unlock());
} else {
  const marker = `${file}.critical`;
  const log = `${file}.events`;
  const markerFd = fs.openSync(marker, "wx");
  fs.closeSync(markerFd);
  fs.appendFileSync(log, JSON.stringify({ event: "enter", pid: process.pid }) + "\n");
  await delay(200);
  fs.appendFileSync(log, JSON.stringify({ event: "leave", pid: process.pid }) + "\n");
  fs.unlinkSync(marker);
  unlock();
  process.stdout.write(`${process.pid}\n`);
}

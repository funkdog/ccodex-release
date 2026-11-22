import fs from "node:fs";
import path from "node:path";
import http from "node:http";
import { createHash, randomUUID } from "node:crypto";
import { spawn } from "node:child_process";
import { pathToFileURL } from "node:url";
import { ModelSources } from "./model-sources.mjs";
import { createModelSourcesHandler } from "./model-sources-http.mjs";
import { readProcessIdentity, sameProcessLifetime } from "./desktop-process.mjs";

const product = "mycodex-model-sources";
const fingerprint = home => createHash("sha256").update(fs.realpathSync(home)).digest("hex");

/** A busy inference bridge must not prevent opening local settings. This
 * temporary loopback view reuses the same store and UI, without inference,
 * catalogue writes or stopping the existing bridge. It expires when idle. */
export async function launchModelSources(home, bridgePort) {
  try {
    const response = await fetch(`http://127.0.0.1:${bridgePort}/sources`, { redirect: "error", signal: AbortSignal.timeout(1500) });
    if (response.ok && response.headers.get("x-frame-options") === "DENY") return `http://127.0.0.1:${bridgePort}/sources`;
  } catch { /* The ordinary inference bridge may not expose the new view yet. */ }
  const file = path.join(home, "model-sources-ui.json"), hash = fingerprint(home), stat = fs.lstatSync(file, { throwIfNoEntry: false });
  if (stat) {
    if (!stat.isFile() || stat.isSymbolicLink() || stat.size > 16384 || typeof process.getuid === "function" && (stat.uid !== process.getuid() || stat.mode & 0o077)) throw new Error("Invalid private source-manager receipt.");
    const receipt = JSON.parse(fs.readFileSync(file, "utf8"));
    if (receipt.product !== product || receipt.homeHash !== hash) throw new Error("Source settings receipt belongs to another installation; it was preserved.");
    if (receipt.product === product && receipt.homeHash === hash && Number.isInteger(receipt.port) && receipt.port > 1023 && receipt.port < 65536 && sameProcessLifetime(receipt.identity, readProcessIdentity(receipt.identity?.pid))) {
      try { const health = await (await fetch(`http://127.0.0.1:${receipt.port}/sources/health`, { redirect: "error", signal: AbortSignal.timeout(1500) })).json();
        if (health.product === product && health.homeHash === hash && health.pid === receipt.identity.pid) return `http://127.0.0.1:${receipt.port}/sources`;
      } catch { /* A stopped temporary view can be recreated. */ }
    }
  }
  const child = spawn(process.execPath, [path.join(import.meta.dirname, "model-sources-launch.mjs"), "--serve", home], { detached: true, stdio: ["ignore", "ignore", "ignore", "ipc"] });
  const port = await new Promise((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error("Local source settings did not become ready.")), 10000);
    child.once("error", error => { clearTimeout(timer); reject(error); });
    child.once("exit", () => { clearTimeout(timer); reject(new Error("Local source settings exited during startup.")); });
    child.once("message", value => { clearTimeout(timer); value?.ready && Number.isInteger(value.port) ? resolve(value.port) : reject(new Error("Invalid source settings startup receipt.")); });
  });
  child.disconnect(); child.unref(); return `http://127.0.0.1:${port}/sources`;
}

async function serve(home) {
  const sources = new ModelSources(home); sources.read();
  const homeHash = fingerprint(home); let handler, idle;
  const file = path.join(home, "model-sources-ui.json");
  const marker = randomUUID(); let closed = false;
  const close = () => { if (closed) return; closed = true; clearTimeout(idle); server.close(); server.closeIdleConnections(); try { if (JSON.parse(fs.readFileSync(file, "utf8")).marker === marker) fs.unlinkSync(file); } catch {} };
  const server = http.createServer(async (req, res) => {
    clearTimeout(idle); idle = setTimeout(close, 20 * 60 * 1000);
    if (req.url === "/sources/health") { res.setHeader("content-type", "application/json"); res.end(JSON.stringify({ product, homeHash, pid: process.pid })); return; }
    try { if (!await handler(req, res)) { res.writeHead(404); res.end(); } }
    catch { res.writeHead(500); res.end("Local source settings are unavailable."); }
  });
  await new Promise(resolve => server.listen(0, "127.0.0.1", resolve));
  const port = server.address().port;
  handler = createModelSourcesHandler({ sources, port, runtimePending: true, lastRequest: () => {
    try { const file = path.join(home, "request-audit-latest.json"), stat = fs.lstatSync(file);
      if (!stat.isFile() || stat.isSymbolicLink() || stat.size > 256 * 1024) return null;
      const audit = JSON.parse(fs.readFileSync(file, "utf8"));
      const source = sources.models().find(model => model.id === audit.requestedModel)?.api_source;
      return { source: source?.label || "GitHub Copilot", model: audit.upstreamModel || audit.requestedModel || "未知" };
    } catch { return null; }
  } });
  const receipt = { product, homeHash, port, marker, identity: readProcessIdentity(process.pid) };
  const pending = `${file}.${marker}.pending`; fs.writeFileSync(pending, JSON.stringify(receipt), { flag: "wx", mode: 0o600 }); fs.renameSync(pending, file);
  process.once("SIGTERM", close); process.once("SIGINT", close);
  idle = setTimeout(close, 20 * 60 * 1000); process.send?.({ ready: true, port });
}
if (process.argv[1] && import.meta.url === pathToFileURL(path.resolve(process.argv[1])).href && process.argv[2] === "--serve")
  serve(process.argv[3]).catch(() => { process.exitCode = 1; });

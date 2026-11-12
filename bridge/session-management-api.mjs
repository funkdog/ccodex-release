import fs from "node:fs";
import path from "node:path";
import http from "node:http";
import { HistoryError } from "../tools/history/manager.mjs";

export function localSessionRequest(url, options) {
  return new Promise((resolve, reject) => {
    // Undici adds sec-fetch-mode even in Node. Use the same browser-free local
    // transport as the bridge's private control channel, not a weaker origin rule.
    const req = http.request(url, {
      method: options.method, headers: options.headers, signal: options.signal,
    }, res => {
      const chunks = [];
      let size = 0;
      res.on("data", chunk => {
        size += chunk.length;
        if (size > 8 * 1024 * 1024) req.destroy(new Error("Session metadata exceeds the bounded response size."));
        else chunks.push(chunk);
      });
      res.on("error", reject);
      res.on("end", () => resolve({
        ok: res.statusCode >= 200 && res.statusCode < 300,
        status: res.statusCode,
        json: async () => JSON.parse(Buffer.concat(chunks).toString("utf8")),
      }));
    });
    req.on("error", reject);
    req.end(options.body);
  });
}

export function createSessionApi({ home, port, request = localSessionRequest, timeoutMs = 30000 }) {
  if (!Number.isInteger(port) || port < 1024 || port > 65535) {
    throw new HistoryError("invalid_endpoint", "Session management requires the selected local bridge.");
  }
  return async (operation, args = {}) => {
    if (!["list", "preview", "apply", "progress", "reconcile"].includes(operation)) {
      throw new HistoryError("invalid_operation", "Unknown session-management endpoint.");
    }
    const read = name => {
      const file = path.join(home, name);
      const stat = fs.lstatSync(file);
      if (!stat.isFile() || stat.isSymbolicLink() || stat.size > 4096) {
        throw new HistoryError("capability_unavailable", "The local session-management capability is invalid.");
      }
      return JSON.parse(fs.readFileSync(file, "utf8"));
    };
    const control = read(`bridge-control-${port}.json`);
    const runtime = read(`bridge-${port}.json`);
    if (control.pid !== runtime.pid || control.instanceId !== runtime.runtime?.instanceId ||
        runtime.port !== port || !/^[A-Za-z0-9_-]{43}$/.test(control.token || "")) {
      throw new HistoryError("capability_unavailable", "The bridge instance changed; retry session management.");
    }
    const response = await request(`http://127.0.0.1:${port}/sessions/${operation}`, {
      method: "POST", redirect: "error", signal: AbortSignal.timeout(timeoutMs),
      headers: { "content-type": "application/json", "x-codex-copilot-control": control.token },
      body: JSON.stringify(args),
    });
    const body = await response.json();
    if (!response.ok) {
      throw new HistoryError(body.error?.code || "session_request_failed",
        body.error?.message || "The local session-management request failed.");
    }
    return body;
  };
}

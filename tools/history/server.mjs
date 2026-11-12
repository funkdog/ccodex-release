import { randomBytes, timingSafeEqual } from "node:crypto";
import fs from "node:fs";
import http from "node:http";
import path from "node:path";
import { HistoryError } from "./manager.mjs";

export async function startHistoryServer(manager, { port = 0, host = "127.0.0.1", token = randomBytes(32).toString("hex") } = {}) {
  if (host !== "127.0.0.1" || !Number.isSafeInteger(port) || port < 0 || port > 65535) {
    throw new HistoryError("invalid_listener", "History UI must use a local IPv4 loopback listener.");
  }
  if (!/^[0-9a-f]{64}$/.test(token)) throw new HistoryError("invalid_token", "A local history UI capability is required.");
  const page = fs.readFileSync(path.join(import.meta.dirname, "ui.html"), "utf8");
  const plans = new Map();
  const activeApplies = new Set();
  let closing = false;
  let endpoint;
  const json = (res, status, value) => {
    res.writeHead(status, { "content-type": "application/json; charset=utf-8",
      "cache-control": "no-store", "x-content-type-options": "nosniff" });
    res.end(JSON.stringify(value));
  };
  const authorized = req => {
    const value = req.headers.authorization;
    const expected = `Bearer ${token}`;
    return typeof value === "string" && Buffer.byteLength(value) === Buffer.byteLength(expected)
      && timingSafeEqual(Buffer.from(value), Buffer.from(expected));
  };
  const readJson = async req => {
    if (req.headers["content-type"] !== "application/json") {
      throw new HistoryError("invalid_content_type", "Use JSON for a history operation.");
    }
    let size = 0;
    const chunks = [];
    for await (const chunk of req) {
      size += chunk.length;
      if (size > 1024 * 1024) throw new HistoryError("request_too_large", "History operation payload exceeds its bounded limit.");
      chunks.push(chunk);
    }
    try { return JSON.parse(Buffer.concat(chunks).toString("utf8")); }
    catch { throw new HistoryError("invalid_json", "The history operation is not valid JSON."); }
  };
  const server = http.createServer(async (req, res) => {
    try {
      if (req.headers.host !== new URL(endpoint).host) {
        json(res, 403, { error: { code: "host_refused", message: "This is a local-only history interface." } });
        return;
      }
      if (req.headers.origin && req.headers.origin !== endpoint) {
        json(res, 403, { error: { code: "origin_refused", message: "Cross-origin history access is not allowed." } });
        return;
      }
      const url = new URL(req.url, endpoint);
      if (req.method === "GET" && url.pathname === "/") {
        res.writeHead(200, {
          "content-type": "text/html; charset=utf-8", "cache-control": "no-store",
          "content-security-policy": "default-src 'none'; script-src 'unsafe-inline'; style-src 'unsafe-inline'; connect-src 'self'; img-src 'none'; frame-ancestors 'none'; base-uri 'none'; form-action 'none'",
          "x-content-type-options": "nosniff", "referrer-policy": "no-referrer",
        });
        res.end(page);
        return;
      }
      if (!authorized(req)) {
        json(res, 401, { error: { code: "local_capability_required", message: "Open the history UI from its local CLI/Desktop launcher." } });
        return;
      }
      if (closing) throw new HistoryError("interface_closing", "This history interface is shutting down.");
      if (req.method === "GET" && url.pathname === "/api/capabilities") {
        json(res, 200, { products: Object.keys(manager.backends), selectionLimit: 500 });
        return;
      }
      if (req.method === "GET" && url.pathname === "/api/progress") {
        json(res, 200, manager.progress(url.searchParams.get("planId")));
        return;
      }
      if (req.method === "GET" && url.pathname === "/api/sessions") {
        const archived = url.searchParams.get("archived");
        if (archived !== null && !["true", "false"].includes(archived)) {
          throw new HistoryError("invalid_filter", "Archived must be true or false.");
        }
        const result = await manager.list({
          product: url.searchParams.get("product") || "all",
          query: url.searchParams.get("query") || "",
          cwd: url.searchParams.get("cwd") || "",
          before: url.searchParams.get("before") ?? undefined,
          after: url.searchParams.get("after") ?? undefined,
          cursor: Number(url.searchParams.get("cursor") || 0),
          limit: Number(url.searchParams.get("limit") || 50),
          ...(archived === null ? {} : { archived: archived === "true" }),
        });
        json(res, 200, result);
        return;
      }
      if (req.method === "POST" && url.pathname === "/api/preview") {
        for (const [id, plan] of plans) {
          if (Date.parse(plan.expiresAt) <= manager.now()) plans.delete(id);
        }
        if (plans.size >= 50) throw new HistoryError("preview_limit", "Too many outstanding previews. Wait for an older preview to expire.");
        const plan = await manager.plan(await readJson(req));
        plans.set(plan.id, plan);
        json(res, 200, plan);
        return;
      }
      if (req.method === "POST" && url.pathname === "/api/apply") {
        const { planId, confirmation } = await readJson(req);
        const plan = plans.get(planId);
        if (!plan) throw new HistoryError("preview_required", "Create a fresh operation preview before applying it.");
        manager.validatePlan(plan, confirmation);
        plans.delete(planId);
        const work = manager.apply(plan, confirmation);
        activeApplies.add(work);
        try { json(res, 200, await work); }
        finally { activeApplies.delete(work); }
        return;
      }
      json(res, 404, { error: { code: "not_found", message: "Unknown history interface route." } });
    } catch (error) {
      json(res, error instanceof HistoryError ? 400 : 500, {
        error: { code: error.code || "history_operation_failed", message: error.message },
      });
    }
  });
  await new Promise((resolve, reject) => {
    server.once("error", reject);
    server.listen(port, host, () => {
      server.off("error", reject);
      endpoint = `http://${host}:${server.address().port}`;
      resolve();
    });
  });
  return { endpoint, url: `${endpoint}/#${token}`, server,
    async close() {
      closing = true;
      await Promise.allSettled([...activeApplies]);
      server.closeAllConnections();
      await new Promise((resolve, reject) => server.close(error => error ? reject(error) : resolve()));
    } };
}

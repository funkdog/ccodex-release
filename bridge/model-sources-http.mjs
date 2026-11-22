import { randomBytes, timingSafeEqual } from "node:crypto";
import { modelSourcesPage } from "./model-sources-ui.mjs";

/** Local UI capability is separate from the stop/session control capability.
 * No CORS; exact Host/Origin checks also reject browser DNS rebinding and CSRF. */
export function createModelSourcesHandler({ sources, port, onChange = async () => {}, lastRequest = () => null, runtimePending = false }) {
  const token = randomBytes(32).toString("base64url");
  const hosts = new Set([`127.0.0.1:${port}`, `localhost:${port}`]);
  const origins = new Set([...hosts].map(host => `http://${host}`));
  const snapshot = () => ({ ...sources.snapshot(), lastRequest: lastRequest(), runtimePending });
  const json = (res, status, value) => { res.writeHead(status, { "content-type": "application/json", "cache-control": "no-store" }); res.end(JSON.stringify(value)); };
  return async (req, res) => {
    const route = req.url?.split("?", 1)[0];
    if (route !== "/sources" && !route?.startsWith("/sources/")) return false;
    if (!hosts.has(req.headers.host) || !["127.0.0.1", "::1", "::ffff:127.0.0.1"].includes(req.socket.remoteAddress)) { json(res, 403, { error: "仅允许本机访问。" }); return true; }
    if (route === "/sources" && req.method === "GET") {
      const nonce = randomBytes(18).toString("base64url");
      res.writeHead(200, { "content-type": "text/html; charset=utf-8", "cache-control": "no-store", "x-frame-options": "DENY", "referrer-policy": "no-referrer",
        "content-security-policy": `default-src 'none'; script-src 'nonce-${nonce}'; style-src 'unsafe-inline'; connect-src 'self'; frame-ancestors 'none'; form-action 'none'; base-uri 'none'` });
      res.end(modelSourcesPage(token, nonce)); return true;
    }
    const supplied = Buffer.from(String(req.headers["x-mycodex-sources"] || ""));
    if (req.method !== "POST" || supplied.length !== token.length || !timingSafeEqual(supplied, Buffer.from(token)) ||
        req.headers.origin && !origins.has(req.headers.origin)) { json(res, 403, { error: "模型来源管理请求未授权。" }); return true; }
    try {
      const chunks = []; let size = 0;
      for await (const chunk of req) { size += chunk.length; if (size > 16384) throw new Error("管理请求过大。"); chunks.push(chunk); }
      const params = JSON.parse(Buffer.concat(chunks).toString("utf8") || "{}");
      if (!params || typeof params !== "object" || Array.isArray(params)) throw new Error("管理参数无效。");
      const operation = route.slice("/sources/api/".length);
      const fields = { list: [], save: ["id", "label", "baseUrl", "apiKey", "protocol", "revision"], discover: ["id", "revision"], prefer: ["id", "model", "revision"], reveal: ["id", "revision"] }[operation];
      if (!fields || Object.keys(params).some(key => !fields.includes(key))) throw new Error("不支持的管理操作。");
      let result;
      if (operation === "list") result = snapshot();
      else if (operation === "reveal") {
        if (sources.read().revision !== params.revision) throw new Error("模型来源已更新，请先刷新。");
        result = { apiKey: sources.source(params.id).apiKey };
      } else {
        const update = operation === "save" ? sources.save(params) : operation === "discover" ? await sources.discover(params.id, params.revision) : sources.prefer(params);
        await onChange(); result = { ...update, lastRequest: lastRequest(), runtimePending };
      }
      json(res, 200, result);
    } catch (error) { json(res, 400, { error: error instanceof SyntaxError ? "管理请求须为有效 JSON。" : error.message }); }
    return true;
  };
}

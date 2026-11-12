import { createHash } from "node:crypto";

const DEFAULT_API = "https://api.githubcopilot.com";

function endpointUrl(value, { account = false } = {}) {
  let url;
  try { url = new URL(value); } catch { throw new Error("Invalid Copilot API endpoint."); }
  if (!["http:", "https:"].includes(url.protocol) || url.username || url.password ||
      url.search || url.hash || (account && (url.protocol !== "https:" || url.port ||
      !/^api(?:\.[a-z0-9-]+)*\.githubcopilot\.com$/.test(url.hostname) ||
      !["", "/"].includes(url.pathname)))) {
    throw new Error("Unsafe Copilot API endpoint.");
  }
  return url.href.replace(/\/+$/, "");
}

function abortable(promise, signal) {
  if (!signal) return promise;
  signal.throwIfAborted();
  return new Promise((resolve, reject) => {
    const cleanup = () => signal.removeEventListener("abort", aborted);
    const aborted = () => { cleanup(); reject(signal.reason); };
    signal.addEventListener("abort", aborted, { once: true });
    promise.then(value => { cleanup(); resolve(value); }, error => { cleanup(); reject(error); });
  });
}

export class CopilotApiResolver {
  constructor({
    apiBase, githubApiBase = "https://api.github.com",
    request = (...args) => fetch(...args), now = Date.now, ttlMs = 300000,
  } = {}) {
    this.override = apiBase ? endpointUrl(apiBase) : null;
    this.githubApiBase = githubApiBase.replace(/\/+$/, "");
    this.request = request;
    this.now = now;
    this.ttlMs = ttlMs;
    this.cache = new Map();
    this.pending = new Map();
  }

  key(token) {
    return createHash("sha256").update(token).digest("hex");
  }

  describe(token) {
    if (this.override) return { api: this.override, source: "override" };
    const record = this.cache.get(this.key(token));
    return record ? { api: record.api, source: record.source } : null;
  }

  async resolve(token, { signal, force = false } = {}) {
    signal?.throwIfAborted();
    if (this.override) return this.override;
    const key = this.key(token);
    const cached = this.cache.get(key);
    if (!force && cached && cached.expiresAt > this.now()) return cached.api;
    let pending = this.pending.get(key);
    if (!pending) {
      pending = this.lookup(token, key).finally(() => this.pending.delete(key));
      this.pending.set(key, pending);
    }
    return abortable(pending, signal);
  }

  async lookup(token, key) {
    const previous = this.cache.get(key);
    let api;
    let source;
    let candidate;
    try {
      const response = await this.request(`${this.githubApiBase}/copilot_internal/user`, {
        headers: {
          authorization: `Bearer ${token}`, accept: "application/json",
          "user-agent": "codex-copilot", "x-github-api-version": "2022-11-28",
        },
        redirect: "error", signal: AbortSignal.timeout(10000),
      });
      if (!response.ok) throw new Error("Copilot account endpoint metadata is unavailable.");
      const body = await response.json();
      candidate = body?.endpoints?.api;
    } catch {
      // An account-service outage must not discard a known route or borrow
      // another credential's endpoint. Legacy accounts retain their old route.
    }
    if (candidate !== undefined && candidate !== null) {
      try { api = endpointUrl(candidate, { account: true }); }
      catch (error) { this.cache.delete(key); throw error; }
      source = "account";
    } else if (previous && ["account", "cached-account"].includes(previous.source)) {
      api = previous.api;
      source = "cached-account";
    } else {
      api = DEFAULT_API;
      source = "fallback";
    }
    this.cache.delete(key);
    this.cache.set(key, {
      api, source, expiresAt: this.now() + (source === "account" ? this.ttlMs : Math.min(this.ttlMs, 30000)),
    });
    while (this.cache.size > 8) this.cache.delete(this.cache.keys().next().value);
    return api;
  }
}

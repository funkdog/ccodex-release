import { createHash } from "node:crypto";
import { GITHUB_API_BASE, copilotHeaders } from "./auth.mjs";
import { CREDITS_RULES, normalizeCopilotCredits } from "./copilot-credits.mjs";

const MAX_ACCOUNT_BYTES = 256 * 1024;
const QUOTA_IDS = ["premium_interactions", "premium_models", "chat", "completions"];
const QUOTA_LABELS = {
  premium_interactions: "Premium requests",
  premium_models: "Premium requests",
  chat: "Chat",
  completions: "Completions",
};

function label(value, maximum = 128) {
  return typeof value === "string"
    ? value.replace(/[\x00-\x1f\x7f-\x9f]/g, "").trim().slice(0, maximum) : null;
}

function quantity(value) {
  return typeof value === "number" && Number.isFinite(value) && value >= 0 ? value : null;
}

function date(value) {
  if (typeof value !== "string" || value.length > 64) return null;
  const parsed = Date.parse(value);
  return Number.isFinite(parsed) ? new Date(parsed).toISOString() : null;
}

function publicUrl(value, hosts) {
  try {
    const url = new URL(value);
    return url.protocol === "https:" && hosts.includes(url.hostname) &&
      !url.username && !url.password && (!url.port || url.port === "443")
      ? url.href : null;
  } catch { return null; }
}

export function normalizeCopilotQuotas(body, { now = Date.now(), source = "github-user" } = {}) {
  const snapshots = [];
  const resetAt = date(body?.quota_reset_date_utc || body?.quota_reset_date);
  for (const id of QUOTA_IDS) {
    const raw = body?.quota_snapshots?.[id];
    if (!raw || typeof raw !== "object" || Array.isArray(raw)) continue;
    const entitlement = quantity(raw.entitlement);
    const remaining = quantity(raw.remaining);
    const unlimited = raw.unlimited === true || raw.entitlement === -1 || raw.entitlement === "-1";
    const creditUnits = raw.token_based_billing === true || raw.unit === "credits";
    let percentRemaining = quantity(raw.percent_remaining);
    if (percentRemaining !== null && percentRemaining > 100) percentRemaining = null;
    if (percentRemaining === null && entitlement > 0 && remaining !== null) {
      percentRemaining = Math.min(100, remaining / entitlement * 100);
    }
    if (!unlimited && remaining === null && percentRemaining === null) continue;
    snapshots.push({
      id, label: creditUnits ? "AI credits" : QUOTA_LABELS[id], unlimited,
      updatedAt: new Date(now).toISOString(),
      entitlement: unlimited ? null : entitlement,
      remaining: unlimited ? null : creditUnits ? (quantity(raw.credits_used) !== null && entitlement !== null
        ? Math.max(0, entitlement - raw.credits_used) : null) : remaining,
      percentRemaining: unlimited ? null : percentRemaining,
      unit: creditUnits ? "credits" : "requests",
      overagePermitted: typeof raw.overage_permitted === "boolean" ? raw.overage_permitted : null,
      overageCount: quantity(raw.overage_count),
      resetAt: date(raw.reset_date) || resetAt,
    });
  }
  return {
    status: snapshots.length ? "available" : "unavailable",
    source, updatedAt: new Date(now).toISOString(), resetAt, snapshots,
    reason: snapshots.length ? null : "quota_not_reported",
    credits: normalizeCopilotCredits(body, { now, source }),
  };
}

export function quotaSnapshotText(snapshot) {
  if (snapshot.unlimited) return "Unlimited";
  const parts = [];
  if (typeof snapshot.remaining === "number") {
    parts.push(typeof snapshot.entitlement === "number"
      ? `${snapshot.remaining.toLocaleString("en-US")}/${snapshot.entitlement.toLocaleString("en-US")}`
      : snapshot.remaining.toLocaleString("en-US"));
    parts[0] += ` ${snapshot.unit === "credits" ? "credits" : "requests"} remaining`;
  }
  if (typeof snapshot.percentRemaining === "number") {
    parts.push(`${snapshot.percentRemaining.toFixed(1)}% remaining`);
  }
  return parts.join(" · ") || "Unavailable";
}

/** Each bucket owns its timestamp; a fresh bucket cannot refresh its neighbors. */
export function quotaSnapshotFreshness(snapshot, { now = Date.now() } = {}) {
  const updatedAt = Date.parse(snapshot?.updatedAt);
  if (!Number.isFinite(updatedAt) || !Number.isFinite(now) ||
      updatedAt > now || now - updatedAt >= 15 * 60000) return "unavailable";
  return now - updatedAt >= 120000 ? "stale" : "available";
}

async function readAccountJson(response) {
  if (!response.ok) {
    await response.body?.cancel();
    const error = new Error("Account metadata request failed.");
    error.category = response.status === 401 || response.status === 403
      ? "authorization_denied" : response.status === 429 ? "rate_limited" : "upstream_error";
    throw error;
  }
  if (Number(response.headers.get("content-length")) > MAX_ACCOUNT_BYTES) {
    await response.body?.cancel();
    throw Object.assign(new Error("Account metadata exceeds its size bound."), { category: "invalid_schema" });
  }
  const chunks = [];
  let bytes = 0;
  for await (const chunk of response.body) {
    bytes += chunk.length;
    if (bytes > MAX_ACCOUNT_BYTES) {
      throw Object.assign(new Error("Account metadata exceeds its size bound."), { category: "invalid_schema" });
    }
    chunks.push(Buffer.from(chunk));
  }
  try {
    const value = JSON.parse(Buffer.concat(chunks).toString("utf8"));
    if (!value || typeof value !== "object" || Array.isArray(value)) throw new Error();
    return value;
  } catch {
    throw Object.assign(new Error("Account metadata is not an object."), { category: "invalid_schema" });
  }
}

function category(error) {
  return ["authorization_denied", "identity_mismatch", "rate_limited", "invalid_schema",
    "upstream_error"].includes(error?.category) ? error.category
    : ["TimeoutError", "AbortError"].includes(error?.name) ? "timeout" : "network_error";
}

function unavailable(login, reason, now) {
  return {
    profile: { login: label(login), verified: false, name: null, avatarUrl: null, url: null },
    plan: null,
    quota: { status: "unavailable", source: "github-user", updatedAt: new Date(now).toISOString(),
      resetAt: null, snapshots: [], reason },
  };
}

export async function fetchCopilotAccount({
  token, login, request = fetch, baseUrl = GITHUB_API_BASE, now = Date.now(),
}) {
  if (!token) return unavailable(login, "not_authenticated", now);
  const options = {
    // Copilot's inference API version is not a GitHub REST API version.
    headers: copilotHeaders(token, { "x-github-api-version": "2022-11-28" }),
    redirect: "error",
    signal: AbortSignal.timeout(10000),
  };
  let profile;
  try {
    const user = await readAccountJson(await request(`${baseUrl}/user`, options));
    const actualLogin = label(user.login);
    if (!actualLogin || (login && actualLogin.toLowerCase() !== login.toLowerCase())) {
      throw Object.assign(new Error("Account metadata identity mismatch."), { category: "identity_mismatch" });
    }
    profile = {
      login: actualLogin, verified: true, name: label(user.name),
      avatarUrl: publicUrl(user.avatar_url, ["avatars.githubusercontent.com"]),
      url: publicUrl(user.html_url, ["github.com"]),
    };
  } catch (error) { return unavailable(login, category(error), now); }
  try {
    const body = await readAccountJson(await request(`${baseUrl}/copilot_internal/user`, options));
    return { profile, plan: label(body.copilot_plan, 64), quota: normalizeCopilotQuotas(body, { now }) };
  } catch (error) {
    return { ...unavailable(profile.login, category(error), now), profile };
  }
}

/** Cache one exact authenticated identity, never a quota from a different token/account. */
export class CopilotAccountCache {
  constructor({ request = fetch, baseUrl = GITHUB_API_BASE, now = Date.now,
    ttlMs = CREDITS_RULES.refreshMs, staleMs = CREDITS_RULES.expireMs } = {}) {
    Object.assign(this, { request, baseUrl, now, ttlMs, staleMs });
    this.key = null;
    this.value = null;
    this.checkedAt = 0;
    this.pending = null;
    this.quotaRevision = 0;
  }

  identity({ token, login, generation }) {
    return createHash("sha256").update(JSON.stringify([token, login?.toLowerCase(), generation])).digest("hex");
  }

  async read(identity, { force = false } = {}) {
    const key = this.identity(identity);
    if (key !== this.key) {
      this.key = key;
      this.value = null;
      this.checkedAt = 0;
      this.pending = null;
      this.quotaRevision += 1;
    }
    if (!force && this.value && this.now() - this.checkedAt < this.ttlMs) return this.value;
    if (this.pending) return this.pending;
    const startedAt = this.now();
    const revision = this.quotaRevision;
    const pending = fetchCopilotAccount({
      ...identity, request: this.request, baseUrl: this.baseUrl, now: startedAt,
    }).then(value => {
      if (this.key !== key) return unavailable(identity.login, "identity_changed", this.now());
      const freshAt = Date.parse(this.value?.quota?.updatedAt);
      const transient = ["network_error", "timeout", "rate_limited", "upstream_error"]
        .includes(value.quota.reason);
      if (this.quotaRevision !== revision &&
          (value.quota.status === "available" || transient) && this.value?.quota.snapshots.length) {
        if (value.quota.status === "available") {
          const merged = new Map(value.quota.snapshots.map(snapshot => [snapshot.id, snapshot]));
          const latest = this.value.quota.snapshots.filter(snapshot =>
            Date.parse(snapshot.updatedAt) >= startedAt);
          for (const snapshot of latest) merged.set(snapshot.id, snapshot);
          const latestCredits = this.value.quota.credits;
          value = { ...value, quota: { ...value.quota,
            ...(latestCredits?.status === "available" &&
              Date.parse(latestCredits.updatedAt) >= startedAt ? { credits: latestCredits } : {}),
            ...(latest.length ? { source: "response-headers",
              updatedAt: this.value.quota.updatedAt } : {}),
            snapshots: QUOTA_IDS.flatMap(id => merged.has(id) ? [merged.get(id)] : []) } };
        } else {
          // Only the same verified identity may retain inference quota during
          // a transient metadata failure; authorization denials still clear it.
          value = { ...this.value, ...(value.profile.verified
            ? { profile: value.profile, plan: value.plan || this.value.plan } : {}),
            quota: this.value.quota };
        }
      } else if (value.quota.status === "unavailable" && transient && this.value?.quota.snapshots.length &&
          Number.isFinite(freshAt) && this.now() - freshAt < this.staleMs) {
        value = { ...this.value, quota: { ...this.value.quota,
          status: "stale", reason: value.quota.reason,
          ...(this.value.quota.credits ? { credits: { ...this.value.quota.credits,
            status: "stale", reason: value.quota.reason } } : {}) } };
      }
      this.value = value;
      this.checkedAt = startedAt;
      return value;
    }).finally(() => { if (this.pending === pending) this.pending = null; });
    this.pending = pending;
    return pending;
  }

  observeHeaders(headers, identity) {
    if (this.key !== this.identity(identity) || !this.value ||
        this.value.profile.verified !== true ||
        this.value.quota.reason === "identity_mismatch") return null;
    const snapshots = {};
    for (const id of QUOTA_IDS) {
      const raw = headers.get(`x-quota-snapshot-${id}`);
      if (!raw || raw.length > 2048) continue;
      const fields = new URLSearchParams(raw.replaceAll(";", "&"));
      const number = name => fields.has(name) && fields.get(name).trim() !== ""
        ? Number(fields.get(name)) : undefined;
      snapshots[id] = {
        entitlement: number("ent"),
        percent_remaining: number("rem"),
        overage_count: number("ov"),
        overage_permitted: fields.has("ovPerm") ? fields.get("ovPerm") === "true" : undefined,
        reset_date: fields.get("rst"),
        token_based_billing: fields.get("token_based_billing") === "true",
        unit: fields.get("unit"),
        credits_used: number("credits_used"),
      };
    }
    const quota = normalizeCopilotQuotas({ quota_snapshots: snapshots },
      { now: this.now(), source: "response-headers" });
    if (!quota.snapshots.length) return null;
    const incoming = new Map(quota.snapshots.map(snapshot => [snapshot.id, snapshot]));
    for (const old of this.value.quota.snapshots) {
      if (!incoming.has(old.id) || (old.unit === "credits" && incoming.get(old.id).unit !== "credits")) {
        incoming.set(old.id, old);
      }
    }
    // Legacy request-percentage headers do not refresh or replace AI-credit balances.
    this.value = { ...this.value, quota: { ...quota,
      credits: quota.credits.status === "available" ? quota.credits : this.value.quota.credits,
      resetAt: quota.resetAt || this.value.quota.resetAt,
      snapshots: QUOTA_IDS.flatMap(id => incoming.has(id) ? [incoming.get(id)] : []) } };
    this.quotaRevision += 1;
    return this.value;
  }
}

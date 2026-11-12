export const CREDITS_RULES = Object.freeze({
  schemaVersion: 1, refreshMs: 15000, frameMs: 80, transitionMs: 480,
  staleMs: 120000, expireMs: 900000, warningPercent: 75, dangerPercent: 90,
  label: "AI credits", unavailable: "AI credits unavailable", stale: "Last known, not live",
  colors: {
    normal: { hex: "#2da44e", rgb: [45, 164, 78], ansi: 32 },
    warning: { hex: "#bf8700", rgb: [191, 135, 0], ansi: 33 },
    danger: { hex: "#cf222e", rgb: [207, 34, 46], ansi: 31 },
    unavailable: { hex: "#6e7781", rgb: [110, 119, 129], ansi: 90 },
  },
});

export function creditsView(credits, { now = Date.now(), rules = CREDITS_RULES } = {}) {
  const checked = Date.parse(credits?.updatedAt);
  const valid = value => typeof value === "number" && Number.isFinite(value) && value >= 0;
  const usable = credits && ["available", "stale"].includes(credits.status)
    && credits.unit === "credits" && valid(credits.used)
    && Number.isFinite(checked) && checked <= now && now - checked < rules.expireMs;
  const unavailable = {
    schemaVersion: 1, status: "unavailable", unit: "credits", label: rules.label, used: null, allowance: null,
    percent: null, progress: null, percentText: "", usageText: rules.unavailable, unlimited: false,
    statusText: rules.unavailable, detailText: credits?.reason || "not_reported",
    tone: "unavailable", color: rules.colors.unavailable,
    checkedAt: Number.isFinite(checked) ? new Date(checked).toISOString() : null,
    expiresAt: null, resetAt: null,
    staleAt: null, staleSuffix: ` (${rules.stale})`, staleColor: rules.colors.unavailable,
    unavailableText: rules.unavailable,
    frameMs: rules.frameMs, transitionMs: rules.transitionMs,
  };
  if (!usable) return unavailable;
  const allowance = valid(credits.allowance) ? credits.allowance : null;
  const percent = allowance > 0 ? credits.used / allowance * 100 : null;
  const stale = credits.status === "stale" || now - checked >= rules.staleMs;
  const status = stale ? "stale" : "available";
  const count = value => value.toLocaleString("en-US", { maximumFractionDigits: 4 });
  const percentText = percent === null ? "" : percent > 0 && percent < 0.1
    ? "<0.1% used" : `${percent.toFixed(1)}% used`;
  const usageText = credits.unlimited
    ? `${count(credits.used)} / Unlimited ${rules.label}`
    : allowance !== null ? `${count(credits.used)} / ${count(allowance)} ${rules.label}`
      : `${count(credits.used)} ${rules.label} used`;
  const tone = stale ? "unavailable" : percent >= rules.dangerPercent ? "danger"
    : percent >= rules.warningPercent ? "warning" : "normal";
  const reset = Date.parse(credits.resetAt);
  const resetAt = Number.isFinite(reset) ? new Date(reset).toISOString() : null;
  return {
    ...unavailable, status, used: credits.used, allowance, percent, unlimited: credits.unlimited === true,
    progress: percent === null ? null : Math.min(1, percent / 100),
    percentText, usageText, statusText: usageText + (percentText ? ` · ${percentText}` : "")
      + (stale ? ` (${rules.stale})` : ""),
    detailText: stale ? rules.stale : resetAt ? `Resets ${resetAt.slice(0, 10)}` : "Reset not reported",
    tone, color: rules.colors[tone], resetAt,
    expiresAt: new Date(checked + rules.expireMs).toISOString(),
    staleAt: new Date(checked + rules.staleMs).toISOString(),
  };
}

export function normalizeCopilotCredits(body, { now = Date.now(), source = "github-user" } = {}) {
  const value = number => typeof number === "number" && Number.isFinite(number) && number >= 0 ? number : null;
  const date = text => typeof text === "string" && Number.isFinite(Date.parse(text))
    ? new Date(Date.parse(text)).toISOString() : null;
  const resetAt = date(body?.quota_reset_date_utc || body?.quota_reset_date);
  const buckets = ["premium_interactions", "premium_models"];
  const candidates = buckets.flatMap(id => {
    const raw = body?.quota_snapshots?.[id];
    if (!raw || typeof raw !== "object" || raw.has_quota === false
      || !(raw.token_based_billing === true || raw.unit === "credits")) return [];
    const used = value(raw.credits_used);
    if (used === null) return [];
    return [{ id, raw, used }];
  });
  const candidate = candidates.find(entry => entry.raw.unlimited !== true && value(entry.raw.entitlement) !== null)
    || candidates[0];
  if (!candidate) return {
    schemaVersion: 1, status: "unavailable", unit: "credits", used: null, allowance: null,
    updatedAt: new Date(now).toISOString(), source, reason: "credits_not_reported",
  };
  const { id, raw, used } = candidate;
  return {
    schemaVersion: 1, status: "available", unit: "credits", bucket: id,
    used, allowance: raw.unlimited === true ? null : value(raw.entitlement),
    unlimited: raw.unlimited === true, updatedAt: new Date(now).toISOString(),
    providerUpdatedAt: date(raw.timestamp_utc),
    resetAt: date(raw.reset_date) || resetAt,
    source, reason: null,
  };
}

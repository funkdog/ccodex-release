export function formatUsage(account) {
  if (account?.status !== "authenticated") {
    throw new Error("Not signed in to GitHub Copilot. Run ccodex login.");
  }
  const credits = account.credits;
  if (credits?.schemaVersion !== 1 || credits.unit !== "credits" ||
      credits.accountGeneration !== account.accountGeneration ||
      credits.status !== "available" || !Number.isFinite(credits.used)) {
    throw new Error("Live Copilot usage is unavailable" +
      (account.quota?.reason ? ` (${account.quota.reason})` : "") +
      ". Cached balances are not shown as current usage.");
  }
  const count = value => value.toLocaleString("en-US", { maximumFractionDigits: 3 });
  const allowance = credits.unlimited ? "Unlimited"
    : Number.isFinite(credits.allowance) ? count(credits.allowance) : "Not reported";
  const remaining = Number.isFinite(credits.allowance)
    ? count(Math.max(0, credits.allowance - credits.used)) : allowance;
  return [
    `GitHub Copilot usage: @${account.login || "unknown"}`,
    `Plan: ${account.plan || "Not reported"}`,
    `AI credits used: ${count(credits.used)} / ${allowance}`,
    `AI credits remaining: ${remaining}`,
    ...(Number.isFinite(credits.percent) ? [`Used: ${credits.percent.toFixed(2)}%`] : []),
    ...(account.quota?.resetAt ? [`Resets: ${account.quota.resetAt}`] : []),
    `Checked: ${credits.checkedAt}`,
    `Source: ${account.quota?.source || "GitHub Copilot account API"} (fresh API request)`,
  ].join("\n");
}

export async function runUsage(args, {
  endpoint, request = fetch, output = process.stdout,
} = {}) {
  if (args.some(arg => arg !== "--json") || args.length > 1) {
    throw new Error("Usage: ccodex usage [--json] or /usage");
  }
  const response = await request(`${endpoint}/account/usage`, {
    method: "POST",
    headers: { accept: "application/json", "cache-control": "no-cache" },
    redirect: "error",
    signal: AbortSignal.timeout(25000),
  });
  const account = await response.json();
  if (!response.ok) throw new Error(account.error || `Usage request failed: HTTP ${response.status}.`);
  const text = formatUsage(account);
  output.write(args.includes("--json")
    ? `${JSON.stringify({
      account: account.login, plan: account.plan,
      accountGeneration: account.accountGeneration, credits: account.credits,
      source: account.quota?.source, resetAt: account.quota?.resetAt,
    }, null, 2)}\n`
    : `${text}\n`);
}

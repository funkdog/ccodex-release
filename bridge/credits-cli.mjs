import { CREDITS_RULES, creditsView } from "./copilot-credits.mjs";

export function creditTerminalCapabilities(output, env = process.env) {
  const modern = output.isTTY === true && env.TERM !== "dumb"
    && Boolean(env.WT_SESSION || env.ANSICON || env.ConEmuANSI === "ON"
      || /^(?:xterm|screen|tmux|vt100|vt220|linux|rxvt)/i.test(env.TERM || "")
      || ["iTerm.app", "Apple_Terminal", "vscode", "WezTerm"].includes(env.TERM_PROGRAM));
  return { animate: modern, color: modern && !Object.hasOwn(env, "NO_COLOR"),
    unicode: modern && !Object.hasOwn(env, "NO_UNICODE") };
}

export function renderCreditLine(view, { unicode = false, progress = view.progress, width = 160 } = {}) {
  const fraction = typeof progress === "number" && Number.isFinite(progress)
    ? Math.max(0, Math.min(1, progress)) : null;
  const filled = fraction === null ? 0 : Math.round(fraction * 12);
  const gauge = unicode ? fraction === null ? "○" : ["○", "◔", "◑", "◕", "●"][Math.round(fraction * 4)]
    : "[" + "=".repeat(filled) + "-".repeat(12 - filled) + "]";
  const safe = String(view.statusText).replace(/[\x00-\x1f\x7f-\x9f]/g, "")
    .replaceAll(" · ", unicode ? " · " : " | ");
  return (gauge + " " + safe).slice(0, Math.max(20, Math.min(1000, width)));
}

export async function runCredits(args, {
  endpoint, output = process.stdout, env = process.env, request = fetch,
  signal, now = Date.now, rules = CREDITS_RULES,
} = {}) {
  const accepted = new Set(["--watch", "--json", "--ascii"]);
  if (args.some(arg => !accepted.has(arg)) || new Set(args).size !== args.length
    || (args.includes("--json") && args.includes("--watch"))) {
    throw new Error("Usage: ccodex credits [--watch] [--ascii] [--json]");
  }
  const target = new URL(endpoint);
  if (target.protocol !== "http:" || !["127.0.0.1", "[::1]"].includes(target.hostname)
    || target.username || target.password || target.pathname !== "/") {
    throw new Error("Credits must use the verified local account bridge.");
  }
  const watch = args.includes("--watch");
  const capabilities = creditTerminalCapabilities(output, env);
  const unicode = capabilities.unicode && !args.includes("--ascii");
  const controller = new AbortController();
  const abort = () => controller.abort();
  signal?.addEventListener("abort", abort, { once: true });
  if (signal?.aborted) abort();
  let lastLine = "", view = creditsView(null), nextRead = 0, from = null, changedAt = now();
  let hiddenCursor = false;
  const done = () => controller.abort();
  if (watch) { process.once("SIGINT", done); process.once("SIGTERM", done); }
  try {
    while (!controller.signal.aborted) {
      const timestamp = now();
      if (timestamp >= nextRead) {
        const response = await request(new URL("/account", target), {
          redirect: "error", signal: AbortSignal.any([controller.signal, AbortSignal.timeout(15000)]),
        });
        if (!response.ok) throw new Error(`Account credit refresh failed: HTTP ${response.status}.`);
        const account = await response.json();
        if (account.status === "authenticated" && (account.credits?.schemaVersion !== 1 || account.credits.unit !== "credits"
          || account.credits.accountGeneration !== account.accountGeneration)) {
          throw new Error("AI credit data does not match the current account generation.");
        }
        const next = account.status === "authenticated" ? account.credits : creditsView(null);
        from = view.progress;
        view = next;
        changedAt = timestamp;
        nextRead = timestamp + rules.refreshMs;
      }
      if (args.includes("--json")) { output.write(JSON.stringify(view, null, 2) + "\n"); return; }
      const phase = Math.min(1, (timestamp - changedAt) / rules.transitionMs);
      const progress = typeof from === "number" && typeof view.progress === "number"
        ? from + (view.progress - from) * (1 - (1 - phase) ** 3) : view.progress;
      const line = renderCreditLine(view, {
        unicode: watch && unicode, progress, width: (output.columns || 160) - 1,
      });
      if (watch && capabilities.animate) {
        if (!hiddenCursor) { output.write("\x1b[?25l"); hiddenCursor = true; }
        const color = capabilities.color ? `\x1b[${view.color.ansi}m` : "";
        output.write("\r\x1b[2K" + color + line + (color ? "\x1b[0m" : ""));
      } else if (line !== lastLine) output.write(line + "\n");
      lastLine = line;
      if (!watch) return;
      await new Promise(resolve => {
        const finished = () => { clearTimeout(timer); controller.signal.removeEventListener("abort", finished); resolve(); };
        const timer = setTimeout(finished, capabilities.animate ? rules.frameMs : rules.refreshMs);
        controller.signal.addEventListener("abort", finished, { once: true });
      });
    }
  } catch (error) {
    if (!controller.signal.aborted) throw error;
  } finally {
    if (hiddenCursor) output.write("\x1b[0m\x1b[?25h\n");
    process.removeListener("SIGINT", done); process.removeListener("SIGTERM", done);
    signal?.removeEventListener("abort", abort);
  }
}

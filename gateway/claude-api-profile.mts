import "../tools/typescript-runtime.mjs";
import fs from "node:fs";
import path from "node:path";
import { randomUUID } from "node:crypto";

export interface ClaudeApiProfile { schemaVersion: 1; baseUrl?: string; model?: string }
function directory(home: string, create = false) {
  if (!path.isAbsolute(home)) throw new Error("Claude API profile requires an absolute directory.");
  if (create) fs.mkdirSync(home, { recursive: true, mode: 0o700 });
  let stat;
  try { stat = fs.lstatSync(home); } catch { throw new Error("请先运行 configure-claude 配置 API key。"); }
  if (!stat.isDirectory() || stat.isSymbolicLink() || (process.platform !== "win32" && (stat.uid !== process.getuid!() || (stat.mode & 0o077))))
    throw new Error("Claude API profile must be a private owned directory.");
}
function regular(file: string, optional = false) {
  let stat;
  try { stat = fs.lstatSync(file); }
  catch (error) { if (optional && (error as NodeJS.ErrnoException).code === "ENOENT") return false; throw new Error("请先运行 configure-claude 配置 API key。"); }
  if (!stat.isFile() || stat.isSymbolicLink() || stat.size > 32768 ||
      (process.platform !== "win32" && (stat.uid !== process.getuid!() || (stat.mode & 0o077))))
    throw new Error("Claude credentials must be private owned regular files; linked files are forbidden.");
  return true;
}
export function validateClaudeApiProfile(value: unknown): ClaudeApiProfile {
  const p = value as ClaudeApiProfile;
  if (!p || typeof p !== "object" || Array.isArray(p) || p.schemaVersion !== 1 ||
      Object.keys(p).some(key => !["schemaVersion", "baseUrl", "model"].includes(key))) throw new Error("Invalid Claude API profile.");
  if (p.baseUrl !== undefined) {
    let url: URL; try { if (typeof p.baseUrl !== "string" || p.baseUrl.length > 2048) throw new Error(); url = new URL(p.baseUrl); } catch { throw new Error("Claude Base URL requires HTTPS without credentials."); }
    if (url.username || url.password || url.search || url.hash ||
        (url.protocol !== "https:" && !(url.protocol === "http:" && ["127.0.0.1", "localhost", "[::1]"].includes(url.hostname))))
      throw new Error("Claude Base URL requires HTTPS without credentials; HTTP is limited to loopback tests.");
  }
  if (p.model !== undefined && (typeof p.model !== "string" || !p.model || p.model.length > 256 || /\s/.test(p.model))) throw new Error("Invalid explicit Claude model ID.");
  return { schemaVersion: 1, ...(p.baseUrl ? { baseUrl: p.baseUrl } : {}), ...(p.model ? { model: p.model } : {}) };
}
function write(file: string, bytes: string) {
  regular(file, true);
  const pending = `${file}.${randomUUID()}.pending`, fd = fs.openSync(pending, "wx", 0o600);
  try {
    try { fs.writeFileSync(fd, bytes); fs.fsyncSync(fd); } finally { fs.closeSync(fd); }
    fs.renameSync(pending, file);
    const directory = fs.openSync(path.dirname(file), "r");
    try { fs.fsyncSync(directory); } finally { fs.closeSync(directory); }
  } finally { fs.rmSync(pending, { force: true }); }
}
export function writeClaudeApiProfile(home: string, settings: { baseUrl?: string; model?: string }, apiKey: string) {
  const profile = validateClaudeApiProfile({ schemaVersion: 1, ...settings });
  if (typeof apiKey !== "string" || !/^[\x21-\x7e]{8,16384}$/.test(apiKey) || apiKey.includes("*")) throw new Error("请输入完整 API key；不能使用遮罩文本。");
  directory(home, true);
  write(path.join(home, "credentials.json"), JSON.stringify({ ...profile, apiKey }) + "\n");
}
export function readClaudeApiProfile(home: string): { profile: ClaudeApiProfile; apiKey: string } {
  directory(home);
  regular(path.join(home, "credentials.json"));
  let profile: ClaudeApiProfile, apiKey: string;
  try { const { apiKey: key, ...settings } = JSON.parse(fs.readFileSync(path.join(home, "credentials.json"), "utf8"));
    profile = validateClaudeApiProfile(settings); apiKey = key; }
  catch { throw new Error("Invalid Claude API profile; no credentials were displayed."); }
  if (typeof apiKey !== "string" || !/^[\x21-\x7e]{8,16384}$/.test(apiKey) || apiKey.includes("*")) throw new Error("Invalid Claude API key; please configure it again.");
  return { profile, apiKey };
}
export function claudeApiEnvironment(home: string, inherited: NodeJS.ProcessEnv = process.env) {
  const { profile, apiKey } = readClaudeApiProfile(home), env = { ...inherited };
  for (const key of Object.keys(env)) if (/^(?:ANTHROPIC_|CLAUDE_CODE_USE_|CLAUDE_CODE_OAUTH_|CLAUDE_CONFIG_DIR$|CLAUDE_API_KEY$)/.test(key)) delete env[key];
  return { ...env, CLAUDE_CONFIG_DIR: home, ANTHROPIC_API_KEY: apiKey,
    ...(profile.baseUrl ? { ANTHROPIC_BASE_URL: profile.baseUrl } : {}), ...(profile.model ? { ANTHROPIC_MODEL: profile.model } : {}) };
}

/** CLI-argument settings outrank project env settings. Keep the key in a
 * private temporary file, never in --settings JSON on the process command. */
export function claudeApiOverlay(home: string, env: NodeJS.ProcessEnv) {
  directory(home);
  if (!env.ANTHROPIC_API_KEY) throw new Error("Claude API key is not configured.");
  const file = path.join(home, `.mycodex-auth-${randomUUID()}.json`);
  const auth = { ANTHROPIC_API_KEY: env.ANTHROPIC_API_KEY, ANTHROPIC_BASE_URL: env.ANTHROPIC_BASE_URL ?? "https://api.anthropic.com",
    ANTHROPIC_AUTH_TOKEN: "", CLAUDE_CODE_OAUTH_TOKEN: "", CLAUDE_CODE_USE_BEDROCK: "", CLAUDE_CODE_USE_VERTEX: "", CLAUDE_CODE_USE_FOUNDRY: "" };
  fs.writeFileSync(file, JSON.stringify({ env: auth }), { flag: "wx", mode: 0o600 });
  return { file, dispose: () => fs.rmSync(file, { force: true }) };
}

/** Read-only provider discovery. This is separate from Claude Code's bundled
 * alias/capability catalogue and never submits a Messages inference request. */
export async function claudeApiModels(env: NodeJS.ProcessEnv, fetcher: typeof fetch = fetch, signal?: AbortSignal): Promise<{ id: string; name?: string }[] | null> {
  const base = (env.ANTHROPIC_BASE_URL ?? "https://api.anthropic.com").replace(/\/$/, "");
  const result: { id: string; name?: string }[] = [], seen = new Set<string>();
  let after: string | undefined;
  for (let page = 0; page < 10; page++) {
    const url = new URL(base + "/v1/models");url.searchParams.set("limit", "100");if (after) url.searchParams.set("after_id", after);
    const deadline = AbortSignal.timeout(15000);
    const response = await fetcher(url, { headers: { "x-api-key": env.ANTHROPIC_API_KEY!, "anthropic-version": "2023-06-01" }, signal: signal ? AbortSignal.any([signal, deadline]) : deadline });
    if ([404, 405, 501].includes(response.status)) return null; // Optional on compatible gateways.
    if (!response.ok) throw new Error(`Claude API model catalogue failed (${response.status}); check the configured key and service address.`);
    const body = await response.json() as { data?: { id?: unknown; display_name?: unknown }[]; has_more?: boolean; last_id?: unknown };
    if (!Array.isArray(body.data) || body.data.length > 1000) throw new Error("Invalid Claude API model catalogue.");
    for (const row of body.data) {
      if (typeof row.id !== "string" || !row.id || row.id.length > 256 || /\s/.test(row.id)) throw new Error("Invalid Claude API model identifier.");
      if (!seen.has(row.id)) { seen.add(row.id);result.push({ id: row.id, ...(typeof row.display_name === "string" ? { name: row.display_name.slice(0, 256) } : {}) }); }
    }
    if (!body.has_more) return result;
    if (typeof body.last_id !== "string" || !seen.has(body.last_id) || body.last_id === after) throw new Error("Invalid Claude API model pagination.");
    after = body.last_id;
  }
  throw new Error("Claude API model catalogue exceeded the discovery limit.");
}

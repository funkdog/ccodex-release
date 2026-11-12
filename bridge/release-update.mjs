import { createHash, randomUUID } from "node:crypto";
import { execFileSync, spawn } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { pathToFileURL } from "node:url";

export const DEFAULT_RELEASE_REPO =
  process.env.CODEX_COPILOT_RELEASE_REPO || "nifan_microsoft/ccodex-release";
export const DEFAULT_RELEASE_REPOS = Object.freeze([
  "ai-microsoft/ccodex-release",
  "nifan_microsoft/ccodex-release",
]);
const SEMVER = /(\d+\.\d+\.\d+)/;
const MAX_METADATA_BYTES = 2 * 1024 * 1024;
const CACHE_TTL_MS = 30 * 60 * 1000;

export function currentPlatformTarget(platform = process.platform, arch = process.arch) {
  const osName = platform === "win32" ? "windows" : platform === "darwin" ? "macos" : platform === "linux" ? "linux" : null;
  const archName = arch === "arm64" ? "arm64" : arch === "x64" ? "x64" : null;
  if (!osName || !archName) throw new Error(`Unsupported release update platform: ${platform}-${arch}`);
  return `${osName}-${archName}`;
}

export const detectPlatformTarget = currentPlatformTarget;

export function parseReleaseVersion(tagOrName) {
  const match = String(tagOrName || "").match(/(?:^|v)(\d+\.\d+\.\d+)(?:$|[^0-9])/i) ||
    String(tagOrName || "").match(SEMVER);
  return match ? match[1] : null;
}

export function compareReleaseVersions(left, right) {
  const normLeft = parseReleaseVersion(left) || String(left || "");
  const normRight = parseReleaseVersion(right) || String(right || "");
  if (!/^\d+\.\d+\.\d+$/.test(normLeft) || !/^\d+\.\d+\.\d+$/.test(normRight)) {
    return 0;
  }
  const a = normLeft.split(".").map(Number);
  const b = normRight.split(".").map(Number);
  for (let i = 0; i < 3; i += 1) {
    if (a[i] !== b[i]) return a[i] < b[i] ? -1 : 1;
  }
  return 0;
}

export function installedReleaseInfo({
  root = path.resolve(import.meta.dirname, ".."),
  platform = process.platform,
  arch = process.arch,
} = {}) {
  const target = currentPlatformTarget(platform, arch);
  const releaseFile = path.join(root, "release.json");
  if (fs.existsSync(releaseFile)) {
    try {
      const meta = JSON.parse(fs.readFileSync(releaseFile, "utf8"));
      return {
        version: String(meta.packageVersion || "0.0.0").trim(),
        releaseId: meta.releaseId || null,
        desktopVersion: meta.desktopVendorVersion || meta.desktopSnapshot?.split("-")[0] || null,
        copilotVersion: meta.copilotVersion || null,
        coreVersion: meta.coreVersion || null,
        target: meta.target || target,
        isReleaseInstall: true,
      };
    } catch {
      /* fall through to VERSION */
    }
  }
  const versionFile = path.join(root, "VERSION");
  const version = fs.existsSync(versionFile)
    ? fs.readFileSync(versionFile, "utf8").trim()
    : "0.0.0";
  return {
    version,
    releaseId: null,
    desktopVersion: null,
    copilotVersion: null,
    coreVersion: null,
    target,
    isReleaseInstall: false,
  };
}

export function selectReleaseAsset(assets = [], target = currentPlatformTarget()) {
  if (!Array.isArray(assets)) return null;
  const [osName, archName] = target.split("-");
  const archPattern = archName === "arm64"
    ? (osName === "macos" ? /arm64|aarch64|universal/i : /arm64|aarch64/i)
    : (osName === "macos" ? /x64|amd64|x86_64|universal/i : /x64|amd64|x86_64/i);
  const candidates = assets.filter((asset) => {
    const name = String(asset?.name || "");
    if (!name || /\.sha256$/i.test(name) || /^SHA256SUMS/i.test(name)) return false;
    if (!archPattern.test(name)) return false;
    if (osName === "windows") return /windows|win32/i.test(name) && /\.(?:exe|zip)$/i.test(name);
    if (osName === "macos") return /macos|darwin|osx/i.test(name) && /\.(?:tar\.gz|pkg|zip)$/i.test(name);
    if (osName === "linux") return /linux/i.test(name) && /\.(?:tar\.gz|deb|rpm)$/i.test(name);
    return false;
  });
  if (!candidates.length) return null;
  candidates.sort((a, b) => {
    const score = (item) => {
      const name = String(item.name || "");
      if (osName === "windows" && /\.exe$/i.test(name)) return 0;
      if (osName !== "windows" && /\.tar\.gz$/i.test(name)) return 0;
      return 1;
    };
    return score(a) - score(b);
  });
  const chosen = candidates[0];
  const digest = typeof chosen.digest === "string" && /^sha256:[a-f0-9]{64}$/i.test(chosen.digest)
    ? chosen.digest.slice(7).toLowerCase()
    : null;
  return {
    id: chosen.id ?? null,
    name: chosen.name,
    size: Number(chosen.size) || 0,
    sha256: digest,
    apiUrl: chosen.url || null,
    downloadUrl: chosen.browser_download_url || null,
  };
}

export const selectPlatformAsset = selectReleaseAsset;

function resolveReleaseAuthTokens({ home, root } = {}) {
  const tokens = [];
  const add = (val) => {
    const trimmed = typeof val === "string" ? val.trim() : "";
    if (trimmed && !tokens.includes(trimmed)) tokens.push(trimmed);
  };
  for (const key of ["CODEX_COPILOT_RELEASE_TOKEN", "CODEX_COPILOT_GITHUB_TOKEN"]) {
    add(process.env[key]);
  }
  if (process.platform === "win32" && root) {
    const script = path.join(root, "bridge", "credman.ps1");
    if (fs.existsSync(script)) {
      try {
        const out = execFileSync(
          "powershell.exe",
          ["-NoProfile", "-NonInteractive", "-ExecutionPolicy", "Bypass", "-File", script],
          { encoding: "utf8", timeout: 10000, windowsHide: true },
        );
        const parsed = JSON.parse(out.trim() || "[]");
        const list = Array.isArray(parsed) ? parsed : [parsed];
        const preferred = list.filter((item) =>
          item?.target === "LegacyGeneric:target=git:https://github.com" ||
          String(item?.target || "").includes("nifan_microsoft"));
        for (const item of [...preferred, ...list]) add(item?.secret);
      } catch {
        /* ignore credman failure */
      }
    }
  }
  if (home) {
    try {
      const saved = JSON.parse(fs.readFileSync(path.join(home, "github-auth.json"), "utf8"));
      add(saved?.oauth_token);
    } catch {
      /* ignore missing auth file */
    }
  }
  for (const key of ["GH_TOKEN", "GITHUB_TOKEN"]) {
    add(process.env[key]);
  }
  return tokens;
}

function resolveReleaseAuthToken(options = {}) {
  return resolveReleaseAuthTokens(options)[0] || null;
}

async function fetchJsonBounded(url, { headers = {}, request = fetch, timeoutMs = 15000 } = {}) {
  const response = await request(url, {
    headers: {
      accept: "application/vnd.github+json",
      "user-agent": "CodexCopilot-release-update",
      ...headers,
    },
    redirect: "follow",
    signal: AbortSignal.timeout(timeoutMs),
  });
  if (!response.ok) {
    const err = new Error(`Release metadata request returned HTTP ${response.status}.`);
    err.status = response.status;
    throw err;
  }
  const text = await response.text();
  if (Buffer.byteLength(text) > MAX_METADATA_BYTES) {
    throw new Error("Release metadata exceeded size limit.");
  }
  return JSON.parse(text);
}

export async function fetchLatestRepositoryRelease({
  repo = DEFAULT_RELEASE_REPO,
  apiUrl = process.env.CODEX_COPILOT_RELEASE_API_URL || null,
  root = path.resolve(import.meta.dirname, ".."),
  home = process.env.CODEX_COPILOT_HOME || path.join(os.homedir(), ".codex-copilot"),
  platform = process.platform,
  arch = process.arch,
  token = undefined,
  request = fetch,
} = {}) {
  const installed = installedReleaseInfo({ root, platform, arch });
  const repoCandidates = !apiUrl && request === fetch && !process.env.CODEX_COPILOT_RELEASE_REPO && repo === DEFAULT_RELEASE_REPO
    ? DEFAULT_RELEASE_REPOS
    : [repo];
  const candidates = token !== undefined
    ? [token]
    : request !== fetch
      ? [null]
      : [...resolveReleaseAuthTokens({ home, root }), null];
  let release;
  let resolvedRepo = repo;
  let authToken = null;
  let lastError = null;
  outer: for (const candidateRepo of repoCandidates) {
    const endpoint = apiUrl || `https://api.github.com/repos/${candidateRepo}/releases/latest`;
    for (const candidate of candidates) {
      try {
        release = await fetchJsonBounded(endpoint, {
          request,
          headers: candidate ? { authorization: `token ${candidate}` } : {},
        });
        resolvedRepo = candidateRepo;
        authToken = candidate;
        lastError = null;
        break outer;
      } catch (error) {
        lastError = error;
        if (error.status !== 401 && error.status !== 403 && error.status !== 404) {
          throw error;
        }
      }
    }
  }
  if (!release) throw lastError || new Error("Unable to fetch repository release metadata.");
  repo = resolvedRepo;
  const latestVersion = parseReleaseVersion(release.tag_name) || parseReleaseVersion(release.name);
  if (!latestVersion || release.draft === true) {
    throw new Error("Repository release metadata does not contain a published version.");
  }
  const asset = selectReleaseAsset(release.assets || [], installed.target);
  const sumsAsset = (release.assets || []).find((a) => /^SHA256SUMS/i.test(a?.name || ""));
  if (asset && !asset.sha256 && sumsAsset) {
    try {
      const sumsUrl = sumsAsset.url || sumsAsset.browser_download_url;
      if (sumsUrl) {
        const res = await request(sumsUrl, {
          headers: {
            accept: sumsAsset.url ? "application/octet-stream" : "text/plain",
            "user-agent": "CodexCopilot-release-update",
            ...(authToken ? { authorization: `token ${authToken}` } : {}),
          },
          redirect: "follow",
          signal: AbortSignal.timeout(10000),
        });
        if (res.ok) {
          const text = await res.text();
          for (const line of text.split(/\r?\n/)) {
            const m = line.trim().match(/^([a-f0-9]{64})\s+\*?(.+)$/i);
            if (m && m[2].trim() === asset.name) {
              asset.sha256 = m[1].toLowerCase();
              break;
            }
          }
        }
      }
    } catch {
      /* best effort SHA256SUMS lookup */
    }
  }
  const comparison = compareReleaseVersions(latestVersion, installed.version);
  const updateAvailable = comparison > 0;
  const cliCommand = fs.existsSync(path.join(root, ".ccodex-dev-install.json"))
    ? "ccodex-dev release-update"
    : "ccodex release-update";
  return {
    schemaVersion: 1,
    checkedAt: new Date().toISOString(),
    repository: repo,
    target: installed.target,
    currentVersion: installed.version,
    currentReleaseId: installed.releaseId,
    latestVersion,
    tagName: release.tag_name || `v${latestVersion}`,
    releaseName: release.name || release.tag_name || `v${latestVersion}`,
    publishedAt: release.published_at || null,
    htmlUrl: release.html_url || `https://github.com/${repo}/releases`,
    notesSummary: String(release.body || "").slice(0, 2000),
    updateAvailable,
    asset,
    installCommand: cliCommand,
  };
}

function updateStateDir(home) {
  const dir = path.join(home, "release-updates");
  fs.mkdirSync(dir, { recursive: true, mode: 0o700 });
  return dir;
}

function readCachedState(home) {
  try {
    const file = path.join(updateStateDir(home), "latest-release.json");
    if (!fs.existsSync(file)) return null;
    return JSON.parse(fs.readFileSync(file, "utf8"));
  } catch {
    return null;
  }
}

function writeCachedState(home, state) {
  const dir = updateStateDir(home);
  const file = path.join(dir, "latest-release.json");
  const temp = `${file}.${randomUUID()}.tmp`;
  fs.writeFileSync(temp, `${JSON.stringify(state, null, 2)}\n`, { mode: 0o600 });
  try {
    fs.renameSync(temp, file);
  } finally {
    if (fs.existsSync(temp)) fs.rmSync(temp, { force: true });
  }
}

export async function checkAndCacheReleaseUpdate(options = {}) {
  const home = options.home || process.env.CODEX_COPILOT_HOME || path.join(os.homedir(), ".codex-copilot");
  const state = await fetchLatestRepositoryRelease({ ...options, home });
  writeCachedState(home, state);
  return state;
}

export function getCachedReleaseUpdate({
  root = path.resolve(import.meta.dirname, ".."),
  home = process.env.CODEX_COPILOT_HOME || path.join(os.homedir(), ".codex-copilot"),
  platform = process.platform,
  arch = process.arch,
  now = Date.now,
  spawnRefresh = true,
} = {}) {
  const installed = installedReleaseInfo({ root, platform, arch });
  const cached = readCachedState(home);
  const checkedAt = Date.parse(cached?.checkedAt || "");
  const fresh = cached?.schemaVersion === 1 &&
    Number.isFinite(checkedAt) &&
    now() - checkedAt < CACHE_TTL_MS;
  if (!fresh && spawnRefresh) {
    try {
      const child = spawn(
        process.execPath,
        [path.join(root, "bridge", "release-update.mjs"), "refresh", home],
        { cwd: root, env: { ...process.env, CODEX_COPILOT_HOME: home }, stdio: "ignore", detached: true, windowsHide: true },
      );
      child.on("error", () => {});
      child.unref();
    } catch {
      /* background check never blocks */
    }
  }
  if (!cached || cached.schemaVersion !== 1 || !cached.latestVersion) {
    return {
      schemaVersion: 1,
      status: "unchecked",
      currentVersion: installed.version,
      latestVersion: null,
      updateAvailable: false,
      target: installed.target,
      installCommand: "ccodex release-update",
    };
  }
  const updateAvailable = compareReleaseVersions(cached.latestVersion, installed.version) > 0;
  return {
    ...cached,
    status: "checked",
    currentVersion: installed.version,
    updateAvailable,
  };
}

export function showReleaseUpdateNotice({
  root = path.resolve(import.meta.dirname, ".."),
  home = process.env.CODEX_COPILOT_HOME || path.join(os.homedir(), ".codex-copilot"),
  output = (text) => process.stderr.write(`${text}\n`),
  now = Date.now,
  spawnRefresh = true,
} = {}) {
  const state = getCachedReleaseUpdate({ root, home, now, spawnRefresh });
  if (!state.updateAvailable) return { shown: false, state };
  const cmd = state.installCommand || "ccodex release-update";
  const banner = [
    `\x1b[36m╭─ 🔔 发现 Ccodex Release 新版本 v${state.latestVersion} (当前 v${state.currentVersion}) ──────────────────────╮\x1b[0m`,
    `\x1b[36m│\x1b[0m 运行 \x1b[1;32m${cmd}\x1b[0m 一键下载校验并安装新版本（保留登录与历史会话） \x1b[36m│\x1b[0m`,
    `\x1b[36m│\x1b[0m 或运行 \x1b[33m${cmd} --check\x1b[0m 查看版本详情与更新说明                \x1b[36m│\x1b[0m`,
    `\x1b[36m╰──────────────────────────────────────────────────────────────────────────────╯\x1b[0m`,
  ].join("\n");
  output(banner);
  return { shown: true, latestVersion: state.latestVersion, currentVersion: state.currentVersion };
}

async function sha256File(file) {
  const hash = createHash("sha256");
  for await (const chunk of fs.createReadStream(file)) hash.update(chunk);
  return hash.digest("hex").toLowerCase();
}

export async function installRepositoryReleaseUpdate({
  root = path.resolve(import.meta.dirname, ".."),
  home = process.env.CODEX_COPILOT_HOME || path.join(os.homedir(), ".codex-copilot"),
  platform = process.platform,
  arch = process.arch,
  token = undefined,
  request = fetch,
  launchInstaller = null,
  onProgress = () => {},
} = {}) {
  const state = await checkAndCacheReleaseUpdate({ root, home, platform, arch, token, request });
  if (!state.updateAvailable && !process.env.CODEX_COPILOT_FORCE_RELEASE_UPDATE) {
    return {
      status: "up-to-date",
      currentVersion: state.currentVersion,
      latestVersion: state.latestVersion,
      message: `Current installation v${state.currentVersion} is already up to date.`,
    };
  }
  if (!state.asset || (!state.asset.apiUrl && !state.asset.downloadUrl)) {
    throw new Error(`No release package found for target ${state.target} in ${state.tagName}.`);
  }
  if (!state.asset.sha256) {
    throw new Error(`Release asset ${state.asset.name} lacks a SHA256 digest; refusing unverified installation.`);
  }
  const authToken = token === undefined ? resolveReleaseAuthToken({ home, root }) : token;
  const staging = fs.mkdtempSync(path.join(os.tmpdir(), "ccodex-release-update-"));
  const destination = path.join(staging, path.basename(state.asset.name));
  try {
    onProgress({ stage: "downloading", asset: state.asset.name, latestVersion: state.latestVersion });
    const downloadUrl = state.asset.apiUrl || state.asset.downloadUrl;
    const headers = {
      "user-agent": "CodexCopilot-release-update",
      accept: state.asset.apiUrl ? "application/octet-stream" : "*/*",
      ...(authToken ? { authorization: `token ${authToken}` } : {}),
    };
    const response = await request(downloadUrl, {
      headers,
      redirect: "follow",
      signal: AbortSignal.timeout(30 * 60 * 1000),
    });
    if (!response.ok) {
      throw new Error(`Failed to download ${state.asset.name}: HTTP ${response.status}`);
    }
    const fileStream = fs.createWriteStream(destination, { mode: 0o700 });
    for await (const chunk of response.body) {
      if (!fileStream.write(chunk)) {
        await new Promise((resolve) => fileStream.once("drain", resolve));
      }
    }
    fileStream.end();
    await new Promise((resolve, reject) => {
      fileStream.once("finish", resolve);
      fileStream.once("error", reject);
    });
    onProgress({ stage: "verifying", asset: state.asset.name });
    const actualSha256 = await sha256File(destination);
    if (actualSha256 !== state.asset.sha256.toLowerCase()) {
      throw new Error(`SHA256 mismatch for ${state.asset.name}: expected ${state.asset.sha256}, got ${actualSha256}`);
    }
    onProgress({ stage: "installing", asset: state.asset.name, sha256: actualSha256 });
    if (typeof launchInstaller === "function") {
      return await launchInstaller({ file: destination, staging, state, sha256: actualSha256 });
    }
    if (platform === "win32" && /\.exe$/i.test(destination)) {
      const child = spawn(destination, [], {
        cwd: staging,
        detached: true,
        stdio: "ignore",
        windowsHide: false,
      });
      child.unref();
      return {
        status: "launched",
        currentVersion: state.currentVersion,
        latestVersion: state.latestVersion,
        installer: destination,
        sha256: actualSha256,
        pid: child.pid,
      };
    }
    if (/\.tar\.gz$/i.test(destination)) {
      const extractDir = path.join(staging, "extracted");
      fs.mkdirSync(extractDir, { recursive: true });
      execFileSync("tar", ["-xzf", destination, "-C", extractDir], { stdio: "ignore" });
      const entries = fs.readdirSync(extractDir, { withFileTypes: true }).filter((e) => e.isDirectory());
      const payloadRoot = entries.length === 1 ? path.join(extractDir, entries[0].name) : extractDir;
      const installScript = path.join(payloadRoot, "install.sh");
      if (fs.existsSync(installScript)) {
        const child = spawn("bash", [installScript, "--configure-only"], {
          cwd: payloadRoot,
          detached: true,
          stdio: "ignore",
        });
        child.unref();
        return {
          status: "launched",
          currentVersion: state.currentVersion,
          latestVersion: state.latestVersion,
          installer: installScript,
          sha256: actualSha256,
          pid: child.pid,
        };
      }
    }
    return {
      status: "downloaded",
      currentVersion: state.currentVersion,
      latestVersion: state.latestVersion,
      installer: destination,
      sha256: actualSha256,
    };
  } catch (error) {
    fs.rmSync(staging, { recursive: true, force: true });
    throw error;
  }
}

/**
 * Pure-ASCII renderer patch that displays a hot-update notification toast in
 * Desktop when a new repository release is detected, with one-click install.
 */
export function buildDesktopReleaseNoticePatch() {
  return `(() => {
    const previous = globalThis.__codexCopilotReleaseNoticeV1;
    if (previous) return 'active';
    if (!document.documentElement) return 'waiting';
    const pending = new Map();
    let pollTimer = null;
    let dismissedVersion = null;
    let disposed = false;
    const toast = document.createElement('aside');
    toast.id = 'codex-copilot-release-update-toast';
    toast.setAttribute('role', 'status');
    toast.setAttribute('aria-live', 'polite');
    toast.hidden = true;
    const style = document.createElement('style');
    style.id = 'codex-copilot-release-update-style';
    style.textContent = \`
      #codex-copilot-release-update-toast {
        position: fixed; z-index: 2147483645; bottom: 20px; right: 20px;
        width: min(380px, calc(100vw - 40px)); box-sizing: border-box;
        padding: 14px 16px; border-radius: 12px;
        border: 1px solid var(--border-light, #4b5563);
        background: var(--main-surface-primary, #1f242d);
        color: var(--text-primary, #f3f4f6);
        box-shadow: 0 12px 32px rgba(0,0,0,.35); font: inherit;
      }
      #codex-copilot-release-update-toast[hidden] { display: none; }
      #codex-copilot-release-update-toast .cc-rel-title {
        font-weight: 600; font-size: 0.92rem; margin: 0 0 6px;
        display: flex; align-items: center; justify-content: space-between; gap: 8px;
      }
      #codex-copilot-release-update-toast .cc-rel-desc {
        font-size: 0.82rem; opacity: .88; margin: 4px 0; overflow-wrap: anywhere;
      }
      #codex-copilot-release-update-toast .cc-rel-cmd {
        font-family: ui-monospace, SFMono-Regular, Menlo, Consolas, monospace;
        font-size: 0.78rem; padding: 4px 8px; border-radius: 6px;
        background: var(--main-surface-secondary, #2b313d); margin: 6px 0;
      }
      #codex-copilot-release-update-toast .cc-rel-actions {
        display: flex; flex-wrap: wrap; gap: 8px; margin-top: 10px;
      }
      #codex-copilot-release-update-toast button {
        font: inherit; font-size: 0.8rem; color: inherit;
        border: 1px solid var(--border-light, #4b5563);
        border-radius: 7px; padding: 5px 10px; cursor: pointer;
        background: var(--main-surface-secondary, #2d333f);
      }
      #codex-copilot-release-update-toast button.cc-rel-primary {
        background: #2563eb; border-color: #3b82f6; color: #fff; font-weight: 500;
      }
      #codex-copilot-release-update-toast button:disabled { opacity: .5; cursor: default; }
    \`;
    document.head.appendChild(style);
    document.body.appendChild(toast);
    const create = (tag, cls, text) => {
      const el = document.createElement(tag);
      if (cls) el.className = cls;
      if (text !== undefined) el.textContent = text;
      return el;
    };
    const onResponse = event => {
      const detail = event.detail || {};
      const waiter = pending.get(detail.id);
      if (!waiter) return;
      pending.delete(detail.id);
      clearTimeout(waiter.timer);
      if (detail.ok) waiter.resolve(detail.body);
      else waiter.reject(new Error(detail.body?.error || 'Release update request failed.'));
    };
    globalThis.addEventListener('codex-copilot-release-update-response', onResponse);
    globalThis.addEventListener('codex-copilot-account-response', onResponse);
    const request = operation => new Promise((resolve, reject) => {
      const direct = globalThis.__codexCopilotReleaseUpdateRequest;
      const account = globalThis.__codexCopilotAccountRequest;
      if (disposed || (typeof direct !== 'function' && typeof account !== 'function')) {
        reject(new Error('Release updater binding is unavailable.'));
        return;
      }
      const id = crypto.randomUUID();
      const timer = setTimeout(() => {
        pending.delete(id);
        reject(new Error('Release update request timed out.'));
      }, 60000);
      pending.set(id, { resolve, reject, timer });
      if (typeof direct === 'function') {
        direct(JSON.stringify({ id, operation }));
      } else {
        account(JSON.stringify({ id, action: 'release-update-request', operation }));
      }
    });
    const render = (state, statusText = null, busy = false) => {
      if (disposed) return;
      if (!state?.updateAvailable || dismissedVersion === state.latestVersion) {
        toast.hidden = true;
        return;
      }
      toast.hidden = false;
      toast.replaceChildren();
      const zh = /^zh(?:-|$)/i.test(document.documentElement?.lang || '');
      toast.appendChild(create('div', 'cc-rel-title',
        zh ? ('\\u53d1\\u73b0 Ccodex \\u65b0\\u7248\\u672c v' + state.latestVersion)
           : ('New Ccodex Release v' + state.latestVersion)));
      toast.appendChild(create('div', 'cc-rel-desc',
        zh ? ('\\u5f53\\u524d\\u7248\\u672c v' + state.currentVersion + ' \\u00b7 \\u53ef\\u4e00\\u952e\\u4e0b\\u8f7d\\u6821\\u9a8c\\u5e76\\u5b89\\u88c5\\u66f4\\u65b0')
           : ('Current v' + state.currentVersion + ' \\u00b7 Verified one-click upgrade available')));
      const cmd = state.installCommand || 'ccodex release-update';
      toast.appendChild(create('div', 'cc-rel-cmd', cmd));
      if (statusText) toast.appendChild(create('div', 'cc-rel-desc', statusText));
      const actions = create('div', 'cc-rel-actions');
      const installBtn = create('button', 'cc-rel-primary',
        zh ? '\\u7acb\\u5373\\u4e00\\u952e\\u66f4\\u65b0' : 'Install Update');
      installBtn.type = 'button';
      installBtn.disabled = busy;
      installBtn.addEventListener('click', async () => {
        render(state, zh ? '\\u6b63\\u5728\\u4e0b\\u8f7d\\u5e76\\u6821\\u9a8c SHA256...' : 'Downloading and verifying SHA256...', true);
        try {
          const res = await request('install');
          render(state, zh
            ? ('\\u5df2\\u542f\\u52a8\\u5b89\\u88c5\\u5668 (' + (res.status || 'ok') + ')\\uff0c\\u53ef\\u5728\\u7a7a\\u95f2\\u65f6\\u91cd\\u542f Desktop')
            : ('Installer started (' + (res.status || 'ok') + '). Restart Desktop when ready.'), false);
        } catch (err) {
          render(state, err.message, false);
        }
      });
      const copyBtn = create('button', '', zh ? '\\u590d\\u5236\\u547d\\u4ee4' : 'Copy Command');
      copyBtn.type = 'button';
      copyBtn.addEventListener('click', () => {
        navigator.clipboard?.writeText(cmd);
        render(state, zh ? '\\u5df2\\u590d\\u5236: ' + cmd : 'Copied: ' + cmd, busy);
      });
      const dismissBtn = create('button', '', zh ? '\\u7a0d\\u540e\\u63d0\\u9192' : 'Dismiss');
      dismissBtn.type = 'button';
      dismissBtn.addEventListener('click', () => {
        dismissedVersion = state.latestVersion;
        toast.hidden = true;
      });
      actions.append(installBtn, copyBtn, dismissBtn);
      toast.appendChild(actions);
    };
    const poll = async (op = 'status') => {
      if (disposed) return;
      try {
        const state = await request(op);
        render(state);
      } catch {
        /* non-intrusive background poll */
      }
    };
    queueMicrotask(() => poll('status'));
    pollTimer = setInterval(() => poll('status'), 10 * 60 * 1000);
    globalThis.__codexCopilotReleaseNoticeV1 = {
      revision: 1,
      checkNow: () => poll('check'),
      inspect: () => ({ installed: true, hidden: toast.hidden, dismissedVersion }),
      dispose: () => {
        disposed = true;
        if (pollTimer) clearInterval(pollTimer);
        pollTimer = null;
        toast.remove();
        style.remove();
        globalThis.removeEventListener('codex-copilot-release-update-response', onResponse);
        globalThis.removeEventListener('codex-copilot-account-response', onResponse);
        for (const waiter of pending.values()) {
          clearTimeout(waiter.timer);
          waiter.reject(new Error('Release notice disposed.'));
        }
        pending.clear();
        delete globalThis.__codexCopilotReleaseNoticeV1;
      },
    };
    return 'active';
  })()`;
}

export async function releaseUpdateCliCommand({
  args = process.argv.slice(2),
  root = path.resolve(import.meta.dirname, ".."),
  home = process.env.CODEX_COPILOT_HOME || path.join(os.homedir(), ".codex-copilot"),
  output = (text) => process.stdout.write(`${text}\n`),
} = {}) {
  const sub = args[0] === "release-update" ? args.slice(1) : args;
  const jsonMode = sub.includes("--json");
  const checkOnly = sub.includes("--check") || sub.includes("check") || sub.includes("status");
  if (checkOnly) {
    const state = await checkAndCacheReleaseUpdate({ root, home });
    if (jsonMode) {
      output(JSON.stringify(state, null, 2));
    } else if (state.updateAvailable) {
      output([
        `🔔 发现新版本: v${state.latestVersion} (当前版本: v${state.currentVersion})`,
        `发布标签    : ${state.tagName}`,
        `适用平台包  : ${state.asset ? `${state.asset.name} (${Math.round(state.asset.size / 1024 / 1024)} MiB)` : "未找到当前平台安装包"}`,
        `SHA256      : ${state.asset?.sha256 || "待校验"}`,
        `发布页面    : ${state.htmlUrl}`,
        `一键安装命令: ${state.installCommand}`,
      ].join("\n"));
    } else {
      output(`当前已是最新版本 v${state.currentVersion} (最新 Release: v${state.latestVersion})。`);
    }
    return 0;
  }
  const result = await installRepositoryReleaseUpdate({
    root,
    home,
    onProgress(progress) {
      if (!jsonMode) {
        output(`[release-update] ${progress.stage}: ${progress.asset || ""}`);
      }
    },
  });
  if (jsonMode) {
    output(JSON.stringify(result, null, 2));
  } else if (result.status === "up-to-date") {
    output(result.message);
  } else {
    output(`✅ 已下载并验证 SHA256 (${result.sha256})，启动安装程序 (${result.status}): ${result.installer}`);
  }
  return 0;
}

const evaluating = process.execArgv.some((value) => ["-e", "--eval", "-p", "--print"].includes(value));
if (!evaluating && process.argv[1] && import.meta.url === pathToFileURL(path.resolve(process.argv[1])).href) {
  try {
    if (process.argv[2] === "refresh" && process.argv[3]) {
      await checkAndCacheReleaseUpdate({ home: process.argv[3] });
    } else if (process.argv[2] === "notice") {
      showReleaseUpdateNotice();
    } else {
      process.exitCode = await releaseUpdateCliCommand({ args: process.argv.slice(2) });
    }
  } catch (error) {
    if (process.argv[2] !== "refresh" && process.argv[2] !== "notice") {
      console.error(`release-update: ${error.message}`);
      process.exitCode = 1;
    }
  }
}

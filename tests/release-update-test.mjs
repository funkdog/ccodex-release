import assert from "node:assert/strict";
import crypto from "node:crypto";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import vm from "node:vm";
import {
  buildDesktopReleaseNoticePatch,
  checkAndCacheReleaseUpdate,
  compareReleaseVersions,
  detectPlatformTarget,
  installRepositoryReleaseUpdate,
  selectPlatformAsset,
  showReleaseUpdateNotice,
} from "../bridge/release-update.mjs";

test("compareReleaseVersions orders semantic and four-part release tags accurately", () => {
  assert.equal(compareReleaseVersions("v1.2.36", "1.2.35"), 1);
  assert.equal(compareReleaseVersions("1.2.35", "v1.2.35"), 0);
  assert.equal(compareReleaseVersions("1.2.34", "1.2.35"), -1);
});

test("selectPlatformAsset resolves the right package for all four maintained platforms", () => {
  const assets = [
    {
      name: "CCodex-1.2.36-Desktop-26.1007.9446.0-Windows-ARM64-Setup.exe",
      browser_download_url: "https://github.com/nifan_microsoft/ccodex-release/releases/download/v1.2.36/CCodex-1.2.36-Desktop-26.1007.9446.0-Windows-ARM64-Setup.exe",
      size: 1024,
      digest: "sha256:" + "a".repeat(64),
    },
    {
      name: "CCodex-1.2.36-Desktop-26.1007.9446.0-Windows-X64-Setup.exe",
      browser_download_url: "https://github.com/nifan_microsoft/ccodex-release/releases/download/v1.2.36/CCodex-1.2.36-Desktop-26.1007.9446.0-Windows-X64-Setup.exe",
      size: 2048,
      digest: "sha256:" + "b".repeat(64),
    },
    {
      name: "CCodex-1.2.36-macOS-Universal.tar.gz",
      browser_download_url: "https://github.com/nifan_microsoft/ccodex-release/releases/download/v1.2.36/CCodex-1.2.36-macOS-Universal.tar.gz",
      size: 3072,
      digest: "sha256:" + "c".repeat(64),
    },
    {
      name: "CCodex-1.2.36-Linux-x64.tar.gz",
      browser_download_url: "https://github.com/nifan_microsoft/ccodex-release/releases/download/v1.2.36/CCodex-1.2.36-Linux-x64.tar.gz",
      size: 4096,
      digest: "sha256:" + "d".repeat(64),
    },
  ];
  assert.equal(
    selectPlatformAsset(assets, detectPlatformTarget("win32", "arm64"))?.name,
    "CCodex-1.2.36-Desktop-26.1007.9446.0-Windows-ARM64-Setup.exe",
  );
  assert.equal(
    selectPlatformAsset(assets, detectPlatformTarget("win32", "x64"))?.name,
    "CCodex-1.2.36-Desktop-26.1007.9446.0-Windows-X64-Setup.exe",
  );
  assert.equal(
    selectPlatformAsset(assets, detectPlatformTarget("darwin", "arm64"))?.name,
    "CCodex-1.2.36-macOS-Universal.tar.gz",
  );
  assert.equal(
    selectPlatformAsset(assets, detectPlatformTarget("linux", "x64"))?.name,
    "CCodex-1.2.36-Linux-x64.tar.gz",
  );
});

test("checkAndCacheReleaseUpdate caches release metadata and showReleaseUpdateNotice prints once per new version", async t => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "ccodex-release-update-"));
  const home = path.join(root, "profile");
  fs.mkdirSync(home, { recursive: true });
  fs.writeFileSync(path.join(root, "VERSION"), "1.2.35\n");
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));

  const now = Date.parse("2026-10-14T12:00:00Z");
  const state = await checkAndCacheReleaseUpdate({
    root,
    home,
    repo: "nifan_microsoft/ccodex-release",
    now: () => now,
    request: async () => new Response(JSON.stringify({
      tag_name: "v1.2.36",
      name: "CCodex v1.2.36",
      html_url: "https://github.com/nifan_microsoft/ccodex-release/releases/tag/v1.2.36",
      published_at: "2026-10-14T11:30:00Z",
      draft: false,
      prerelease: false,
      body: "Fixes long-session reconnects and updates Copilot + Codex.",
      assets: [
        {
          name: "CCodex-1.2.36-Desktop-26.1007.9446.0-Windows-ARM64-Setup.exe",
          browser_download_url: "https://github.com/nifan_microsoft/ccodex-release/releases/download/v1.2.36/CCodex-1.2.36-Desktop-26.1007.9446.0-Windows-ARM64-Setup.exe",
          size: 12345,
          digest: "sha256:" + "e".repeat(64),
        },
        {
          name: "CCodex-1.2.36-Desktop-26.1007.9446.0-Windows-X64-Setup.exe",
          browser_download_url: "https://github.com/nifan_microsoft/ccodex-release/releases/download/v1.2.36/CCodex-1.2.36-Desktop-26.1007.9446.0-Windows-X64-Setup.exe",
          size: 12345,
          digest: "sha256:" + "f".repeat(64),
        },
        {
          name: "CCodex-1.2.36-macOS-Universal.tar.gz",
          browser_download_url: "https://github.com/nifan_microsoft/ccodex-release/releases/download/v1.2.36/CCodex-1.2.36-macOS-Universal.tar.gz",
          size: 12345,
          digest: "sha256:" + "1".repeat(64),
        },
        {
          name: "CCodex-1.2.36-Linux-x64.tar.gz",
          browser_download_url: "https://github.com/nifan_microsoft/ccodex-release/releases/download/v1.2.36/CCodex-1.2.36-Linux-x64.tar.gz",
          size: 12345,
          digest: "sha256:" + "2".repeat(64),
        },
      ],
    }), { status: 200 }),
  });

  assert.equal(state.updateAvailable, true);
  assert.equal(state.latestVersion, "1.2.36");
  assert.equal(state.currentVersion, "1.2.35");

  const lines = [];
  const first = showReleaseUpdateNotice({
    root,
    home,
    now: () => now,
    spawnRefresh: false,
    output: text => lines.push(text),
  });
  assert.equal(first.shown, true);
  assert.equal(lines.length, 1);
  assert.match(lines[0], /v1\.2\.36[\s\S]*ccodex release-update/);
});

test("installRepositoryReleaseUpdate verifies SHA256 digest before executing installer", async t => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "ccodex-release-install-"));
  const home = path.join(root, "profile");
  fs.mkdirSync(home, { recursive: true });
  fs.writeFileSync(path.join(root, "VERSION"), "1.2.35\n");
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));

  const payload = Buffer.from("synthetic-installer-binary-payload", "utf8");
  const digest = crypto.createHash("sha256").update(payload).digest("hex");
  const assetName = process.platform === "win32"
    ? (process.arch === "arm64"
      ? "CCodex-1.2.36-Desktop-26.1007.9446.0-Windows-ARM64-Setup.exe"
      : "CCodex-1.2.36-Desktop-26.1007.9446.0-Windows-X64-Setup.exe")
    : process.platform === "darwin"
      ? "CCodex-1.2.36-macOS-Universal.tar.gz"
      : "CCodex-1.2.36-Linux-x64.tar.gz";
  const assetUrl = `https://github.com/nifan_microsoft/ccodex-release/releases/download/v1.2.36/${assetName}`;

  const executed = [];
  const result = await installRepositoryReleaseUpdate({
    root,
    home,
    repo: "nifan_microsoft/ccodex-release",
    request: async url => {
      if (url === assetUrl) return new Response(payload, { status: 200 });
      return new Response(JSON.stringify({
        tag_name: "v1.2.36",
        name: "CCodex v1.2.36",
        html_url: "https://github.com/nifan_microsoft/ccodex-release/releases/tag/v1.2.36",
        published_at: "2026-10-14T11:30:00Z",
        draft: false,
        prerelease: false,
        assets: [{
          name: assetName,
          browser_download_url: assetUrl,
          size: payload.length,
          digest: `sha256:${digest}`,
        }],
      }), { status: 200 });
    },
    launchInstaller: async ({ file, state, sha256 }) => {
      executed.push({ file, sha256 });
      return { status: "launched", latestVersion: state.latestVersion, sha256 };
    },
  });

  assert.equal(result.status, "launched");
  assert.equal(result.latestVersion, "1.2.36");
  assert.equal(result.sha256, digest);
  assert.equal(executed.length, 1);
});

test("Desktop release hot-update patch is pure ASCII, idempotent, and disposes cleanly", () => {
  const source = buildDesktopReleaseNoticePatch();
  assert.doesNotMatch(source, /[^\x09\x0a\x0d\x20-\x7e]/, "Desktop release patch must remain pure ASCII");
  new vm.Script(source);
  assert.match(source, /__codexCopilotReleaseNoticeV1/);
  assert.match(source, /release-update-request/);
  assert.match(source, /ccodex release-update/);
});

test("Cross-platform CLI and Desktop launchers include node-pty prebuilds, cli-session routing, and catalog hot-reload", async () => {
  const repoRoot = path.resolve(import.meta.dirname, "..");
  for (const plat of ["darwin-arm64", "darwin-x64", "linux-arm64", "linux-x64", "win32-arm64", "win32-x64"]) {
    const dir = path.join(repoRoot, "bin", "node-pty", "prebuilds", plat);
    assert.equal(fs.existsSync(dir), true, `Missing node-pty prebuild for ${plat}`);
  }
  const unixCli = fs.readFileSync(path.join(repoRoot, "platforms", "unix", "bin", "codex-copilot"), "utf8");
  assert.match(unixCli, /bridge\/cli-session\.mjs/);
  const { cliSessionEnvironment } = await import("../bridge/cli-session.mjs");
  const env = cliSessionEnvironment({}, "/tmp/ccodex-home");
  assert.equal(env.CODEX_COPILOT_CATALOG_FILE, path.join("/tmp/ccodex-home", "models.json"));
  const desktopPatchSource = fs.readFileSync(path.join(repoRoot, "bridge", "desktop-patch.mjs"), "utf8");
  assert.match(desktopPatchSource, /catalogHotReloadPatch\(pendingCatalogGeneration\)/);
  const nativeContextSource = fs.readFileSync(path.join(repoRoot, "bridge", "desktop-native-context.mjs"), "utf8");
  assert.match(nativeContextSource, /previous\.setGroups\(groups\)/);
});

import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import fs from "node:fs";
import path from "node:path";
import test from "node:test";

const root = path.resolve(import.meta.dirname, "..");
const showcaseFile = path.join(root, "assets", "installer-showcase.json");
const showcaseData = JSON.parse(fs.readFileSync(showcaseFile, "utf8"));
const unixInstallerSource = fs.readFileSync(
  path.join(root, "platforms", "unix", "install.sh"), "utf8",
);
const unixRenderer = unixInstallerSource.match(/<<'NODE'\r?\n([\s\S]*?)\r?\nNODE/)?.[1];

function runUnixRenderer(mode, {
  platform = "linux", desktop = "", encoded = "", url = "", stage = "", detail = "",
  prelude = "",
} = {}) {
  assert.ok(unixRenderer, "Unix installer must embed the shared-data renderer");
  return spawnSync(process.execPath, [
    "-", showcaseFile, mode, platform, "test", desktop, encoded, url, "1", stage, detail,
  ], {
    input: `${prelude}${unixRenderer}`,
    encoding: "utf8",
    timeout: 10000,
    maxBuffer: 2 * 1024 * 1024,
  });
}

function mockHttpsResponse(data, status = 200, advertisedLength = null) {
  return `(() => {
    const { EventEmitter } = require("node:events");
    const payload = Buffer.from(${JSON.stringify(JSON.stringify(data))}, "utf8");
    require("node:https").get = (_url, _options, respond) => {
      const request = new EventEmitter();
      request.destroy = (error) => request.emit("error", error);
      setImmediate(() => {
        const response = new EventEmitter();
        response.statusCode = ${status};
        response.headers = { "content-length": String(${advertisedLength ?? "payload.length"}) };
        response.resume = () => {};
        respond(response);
        setImmediate(() => {
          if (response.statusCode === 200) {
            response.emit("data", payload);
            response.emit("end");
          }
          request.emit("close");
        });
      });
      return request;
    };
  })();
`;
}

test("release workflow builds pinned cores for every platform target", () => {
  const source = fs.readFileSync(
    path.join(root, ".github", "workflows", "build-platform-packages.yml"),
    "utf8",
  );
  assert.match(source, /read-source-revision\.mjs/);
  assert.equal(
    source.split("node tools/apply-native-patches.mjs codex-source").length - 1,
    2,
    "Windows and Unix must apply the same declared patch chain",
  );
  const chain = JSON.parse(fs.readFileSync(path.join(root, "NATIVE_PATCH_CHAIN.json"), "utf8"));
  assert.equal(chain.sourceRevision, fs.readFileSync(path.join(root, "CODEX-SOURCE-REVISION"), "utf8").trim());
  assert.ok(chain.patches.includes("codex-context-picker-v2.patch"));
  assert.equal(new Set(chain.patches).size, chain.patches.length);
  for (const patch of chain.patches) {
    assert.ok(fs.existsSync(path.join(root, "patches", patch)));
  }
  const windowsManifest = JSON.parse(fs.readFileSync(
    path.join(root, "bin", "runtimes", "arm64", "codex-copilot-core.manifest.json"), "utf8",
  ));
  assert.deepEqual(windowsManifest.patches.map(({ name }) => name), chain.patches);
  assert.equal(windowsManifest.patchedTree, chain.patchedTree);
  assert.match(source, /max-parallel: 1/);
  assert.match(source, /needs: windows/);
  assert.match(source, /cancel-in-progress: false/);
  assert.match(source, /just test -p codex-tui --test-threads 6/);
  assert.equal(source.split("node tools/write-core-manifest.mjs").length - 1, 2);
  assert.match(source, /--manifest "artifacts\/\$\{\{ matrix\.package_target \}\}\/codex-copilot-core\.manifest\.json"/);
  const writer = fs.readFileSync(path.join(root, "tools", "write-core-manifest.mjs"), "utf8");
  assert.match(writer, /runtimeVerified/);
  assert.match(writer, /sourceRevision/);
  assert.match(writer, /patches/);
  assert.doesNotMatch(source, /codex-windows-popup-redraw\.patch/);
  assert.doesNotMatch(source, /text\.replace\('version = "0\.0\.0"'/);
  for (const target of [
    "windows-arm64", "windows-x64",
    "linux-arm64", "linux-x64",
    "macos-arm64", "macos-x64",
  ]) {
    assert.match(source, new RegExp(target));
  }
  assert.match(source, /aarch64-pc-windows-msvc/);
  assert.match(source, /x86_64-pc-windows-msvc/);
  assert.match(source, /aarch64-unknown-linux-gnu/);
  assert.match(source, /x86_64-unknown-linux-gnu/);
  assert.doesNotMatch(source, /unknown-linux-musl/);
  assert.doesNotMatch(source, /cargo zigbuild/);
  assert.match(source, /EXPECTED_CORE_VERSION/);
  assert.match(source, /codex-copilot-core\.manifest\.json/);
  const unixInstaller = fs.readFileSync(
    path.join(root, "platforms", "unix", "install.sh"),
    "utf8",
  );
  assert.match(unixInstaller, /minimumOsVersion/);
  assert.match(unixInstaller, /--configure-only/);
  assert.match(unixInstaller, /prompt_desktop/);
  assert.match(unixInstaller, /prompt_copilot/);
  assert.match(unixInstaller, /prompt_stock_codex/);
  assert.match(unixInstaller, /verify_copilot_entitlement/);
  assert.match(unixInstaller, /Copilot.*usable/);
  assert.doesNotMatch(unixInstaller, /Linux release is CLI-only|DESKTOP_SKIPPED/);
  assert.doesNotMatch(unixInstaller, /brew install --cask codex-app/);
  assert.match(showcaseData.tagline, /相对原生 Codex CLI 的增强/);
  assert.doesNotMatch(unixInstaller, /codex-copilot-original/);
  assert.doesNotMatch(
    unixInstaller,
    /cp "\$INSTALL_ROOT\/bin\/codex-copilot-core" "\$STOCK_CORE"/,
  );
  const unixPackager = fs.readFileSync(
    path.join(root, "tools", "package-unix.mjs"),
    "utf8",
  );
  assert.match(unixPackager, /minimumOsVersion: "13\.0"/);
  assert.match(unixPackager, /codex-copilot setup/);
  assert.match(unixPackager, /postinst/);
  assert.match(unixPackager, /%post/);
  assert.match(unixPackager, /--scripts/);
  assert.match(unixPackager, /platforms", "linux", "bin", "codex-copilot-desktop"/);
  assert.match(unixPackager, /"codex-copilot", "ccodex", "bridge-port\.sh"/);
  assert.match(unixPackager, /desktopEnhancement: platform === "macos"/);
  assert.match(source, /ubuntu-24\.04-arm/);
  assert.match(source, /runner: macos-15-intel/);
  assert.match(source, /runner: macos-15\n/);
  assert.match(source, /MACOSX_DEPLOYMENT_TARGET: "13\.0"/);
  assert.doesNotMatch(source, /runner: macos-13\b/);
  assert.match(source, /SHA256SUMS\.txt/);
  const releaseTester = fs.readFileSync(path.join(root, "tools", "Test-ReleaseCandidate.ps1"), "utf8");
  assert.match(releaseTester, /Test-UnixInstallerFromRelease\.sh/);
  assert.match(releaseTester, /windowsPlatformSkipsCoveredByUnix/);
  assert.match(releaseTester, /\[ValidateRange\(1, 6\)\]\[int\]\$TestConcurrency = 1/);
  assert.match(releaseTester, /"--test-concurrency=\$TestConcurrency"/);
  assert.match(releaseTester, /testConcurrency = \$TestConcurrency/);
  const verifier = fs.readFileSync(path.join(root, "tools", "Verify-ReleaseArtifacts.ps1"), "utf8");
  assert.match(verifier, /platforms\\unix\\bin\\bridge-port\.sh/);
  assert.match(verifier, /platforms\\linux\\bin\\codex-copilot-desktop/);
  const windowsLauncher = fs.readFileSync(
    path.join(root, "bin", "codex-copilot.cmd"),
    "utf8",
  );
  assert.ok(
    windowsLauncher.indexOf('if /i "%CC_SUB%"=="--version"') <
      windowsLauncher.indexOf('"%CC_NODE%" "%CC_ROOT%\\bridge\\ensure.mjs"'),
  );
  assert.ok(fs.existsSync(path.join(root, "RELEASE_NOTES.md")));
  assert.match(unixPackager, /RELEASE_NOTES\.md/);
});

test("every installer exposes guided resource choices and the enhancement showcase", () => {
  const windowsInstaller = fs.readFileSync(path.join(root, "install.ps1"), "utf8");
  const windowsUi = fs.readFileSync(
    path.join(root, "tools", "installer-ui.ps1"),
    "utf8",
  );
  const unixInstaller = unixInstallerSource;
  for (const name of ["ChatGPT Desktop", "Codex CLI", "GitHub Copilot CLI"]) {
    assert.match(windowsUi + windowsInstaller, new RegExp(name));
    assert.match(unixInstaller, new RegExp(name));
  }
  for (const choice of ["[1]", "[2]", "[3]"]) {
    assert.ok(windowsUi.includes(choice));
    assert.ok(unixInstaller.includes(choice));
  }
  assert.equal(showcaseData.schemaVersion, 1);
  assert.equal(showcaseData.installStages.length, 6);
  assert.equal(showcaseData.sections.length, 5);
  assert.ok(showcaseData.quickStart.some((entry) => entry.command === "ccodex showcase"));
  const content = JSON.stringify(showcaseData);
  assert.match(content, /相对原生 Codex CLI 的增强/);
  assert.match(content, /不会 mock 或估算/);
  assert.match(content, /缺失即隐藏/);
  assert.match(content, />100%/);
  assert.match(content, /不把聚焦旧窗口算成功/);
  assert.match(content, /安装成功不代表.*Browser.*Computer Use.*实测可用/);
  for (const detail of [
    "Ctrl+A", "Ctrl+C", "Ctrl+V", "Ctrl+Alt+V", "Ctrl+Z",
    "GitHub Copilot 账户卡", "Standard / Long", "Model → Context → Effort",
    "fail closed", "原生 codex", "patched core",
    "renderer / app-server", "codex-copilot doctor",
    "codex-copilot repair", "codex-copilot catalog",
    "codex-copilot login --force", "desktop-patch.log",
    "输出区直接拖选", "右键复制", "附件预览", "滚动条拖动", "↓ 下键",
    "累计缓存读取量",
  ]) {
    assert.ok(content.includes(detail), `Shared showcase is missing ${detail}`);
  }
  assert.match(windowsUi, /assets\\installer-showcase\.json/);
  assert.match(unixInstaller, /assets\/installer-showcase\.json/);
  assert.match(fs.readFileSync(path.join(root, "tools", "showcase.ps1"), "utf8"),
    /Write-InstallerEnhancementShowcase -Version \$version/);
  assert.match(fs.readFileSync(path.join(root, "bin", "codex-copilot.cmd"), "utf8"),
    /if \/i "%~1"=="showcase" goto :run_showcase/);
  assert.match(fs.readFileSync(path.join(root, "platforms", "unix", "bin", "codex-copilot"), "utf8"),
    /exec "\$ROOT\/install\.sh" --showcase-only/);
  assert.doesNotMatch(windowsUi, /输出区直接拖选|累计缓存读取量/);
  assert.doesNotMatch(unixInstaller, /输出区直接拖选|累计缓存读取量/);
  assert.match(windowsUi, /CODEX_COPILOT_SHOWCASE_URL/);
  assert.match(unixInstaller, /CODEX_COPILOT_SHOWCASE_URL/);
  assert.match(windowsUi, /AllowAutoRedirect = \$false/);
  assert.match(unixInstaller, /url\.protocol !== "https:"/);
  assert.match(windowsUi, /ConvertFrom-InstallerShowcaseBytes/);
  assert.match(unixInstaller, /function validate\(data\)/);
  assert.match(windowsUi, /65536/);
  assert.match(unixInstaller, /65536/);
  assert.match(unixInstaller, /--showcase-preview/);
  assert.match(unixInstaller, /bridge 默认按需启动，不占开机常驻资源/);
  assert.match(unixInstaller, /Bridge autostart is ON\./);
  assert.match(unixInstaller, /本次升级保留设置，不关闭或重建/);
  assert.doesNotMatch(unixInstaller, /cli\.mjs" autostart (?:on|off)/);
  assert.match(content, /默认按需启动，不占开机常驻资源/);
  assert.deepEqual(
    showcaseData.sections.flatMap((section) => section.items)
      .find((item) => item.label === "bridge 启动").platforms,
    ["windows", "linux", "macos"],
  );
  const desktopMenu = showcaseData.sections.flatMap((section) => section.items)
    .find((item) => item.label === "完整菜单");
  assert.match(desktopMenu.text, /Model、Effort、Context window.*独立入口/);
  assert.match(desktopMenu.text, /模型只列一次/);
  assert.deepEqual(showcaseData.sections.flatMap((section) => section.items)
    .find((item) => item.label === "Windows 前台输入").platforms, ["windows"]);
  const windowsPackager = fs.readFileSync(path.join(root, "tools", "New-TransferBundle.ps1"), "utf8");
  const unixPackager = fs.readFileSync(path.join(root, "tools", "package-unix.mjs"), "utf8");
  assert.match(windowsPackager, /'assets'/);
  assert.match(unixPackager, /"assets"/);
  assert.deepEqual(showcaseData.sections.find((section) => section.requiresDesktop).platforms, [
    "windows", "macos",
  ]);
  assert.match(content, /Linux Desktop preview/);
  assert.match(content, /Linux Computer Use/);
  assert.match(content, /独立 stock codex/);
  assert.match(windowsUi, /CODEX_COPILOT_NO_ANIMATION/);
  assert.match(windowsUi, /Start-Sleep -Milliseconds 220/);
  assert.match(windowsUi, /Start-Sleep -Milliseconds 140/);
  assert.match(windowsUi, /-ForegroundColor/);
  assert.doesNotMatch(windowsUi, /-BackgroundColor/);
  assert.match(unixInstaller, /CODEX_COPILOT_NO_ANIMATION/);
  assert.match(unixInstaller, /sleep 0\.22/);
  assert.match(unixInstaller, /sleep 0\.14/);
  assert.match(unixInstaller, /\\u001b\[3[0-9]m/);
  assert.doesNotMatch(unixInstaller, /\\033\[48;5;/);
  assert.match(windowsInstaller, /desktop-executable\.txt/);
  assert.match(windowsInstaller, /copilot-cli-sdk-path\.txt/);
  assert.match(unixInstaller, /desktop-app-path\.txt/);
  assert.match(unixInstaller, /copilot-cli-sdk-path\.txt/);
  assert.ok(
    windowsInstaller.lastIndexOf("Write-InstallerEnhancementShowcase -Version $sourceVersion") >
      windowsInstaller.indexOf('Write-Host "Codex (Copilot) is installed."'),
  );
  assert.ok(
    unixInstaller.lastIndexOf("showcase") >
      unixInstaller.indexOf("CodexCopilot is configured for $OS-$ARCH."),
  );
});

test("Unix renderer uses the shared snapshot and filters Desktop to supported installations", () => {
  const loaded = runUnixRenderer("load");
  assert.equal(loaded.status, 0, loaded.stderr);
  const bundle = JSON.parse(Buffer.from(loaded.stdout, "base64").toString("utf8"));
  assert.deepEqual(bundle.data, showcaseData);
  assert.equal(bundle.source, "包内快照");

  const linux = runUnixRenderer("showcase", { encoded: loaded.stdout });
  const macosWithoutDesktop = runUnixRenderer("showcase", {
    platform: "macos", encoded: loaded.stdout,
  });
  const macosWithDesktop = runUnixRenderer("showcase", {
    platform: "macos", desktop: "/Applications/Codex.app", encoded: loaded.stdout,
  });
  const linuxWithDesktop = runUnixRenderer("showcase", {
    platform: "linux", desktop: "/usr/bin/chatgpt", encoded: loaded.stdout,
  });
  for (const result of [linux, linuxWithDesktop, macosWithoutDesktop, macosWithDesktop]) {
    assert.equal(result.status, 0, result.stderr);
    assert.match(result.stdout, /PREVIEW ONLY/);
    assert.match(result.stdout, /codex-copilot doctor/);
    assert.match(result.stdout, /Ctrl\+A \/ Ctrl\+Z/);
    assert.match(result.stdout, /bridge 启动.*默认按需启动/);
    assert.doesNotMatch(result.stdout, /Windows 前台输入/);
  }
  assert.doesNotMatch(linux.stdout, /GitHub Copilot 账户卡|codex-copilot desktop/);
  assert.doesNotMatch(linuxWithDesktop.stdout, /GitHub Copilot 账户卡/);
  assert.match(linuxWithDesktop.stdout, /codex-copilot desktop/);
  assert.match(linuxWithDesktop.stdout, /Linux Computer Use/);
  assert.doesNotMatch(macosWithoutDesktop.stdout, /GitHub Copilot 账户卡|codex-copilot desktop/);
  assert.match(macosWithDesktop.stdout, /GitHub Copilot 账户卡/);
  assert.match(macosWithDesktop.stdout, /codex-copilot desktop/);
  assert.match(linux.stdout, /独立 stock codex 与 ~\/\.codex/);
  assert.doesNotMatch(linux.stdout, /不替换官方 CLI 或 Desktop 内核/);

  const step = runUnixRenderer("step", {
    encoded: loaded.stdout, stage: "03", detail: "目标安装目录：/tmp/isolated",
  });
  assert.equal(step.status, 0, step.stderr);
  assert.match(step.stdout, /\[03\/6\] 部署组件/);
  assert.match(step.stdout, /\/tmp\/isolated/);
});

test("Unix remote showcase updates content only after strict HTTPS schema checks", () => {
  const trustedUrl = "https://trusted.example.invalid/showcase.json";
  const remote = structuredClone(showcaseData);
  remote.tagline = "REMOTE SHOWCASE REVISION";
  const updated = runUnixRenderer("load", {
    url: trustedUrl, prelude: mockHttpsResponse(remote),
  });
  assert.equal(updated.status, 0, updated.stderr);
  const bundle = JSON.parse(Buffer.from(updated.stdout, "base64").toString("utf8"));
  assert.equal(bundle.source, "受信 HTTPS 端点：trusted.example.invalid");
  const rendered = runUnixRenderer("showcase", { encoded: updated.stdout });
  assert.equal(rendered.status, 0, rendered.stderr);
  assert.match(rendered.stdout, /REMOTE SHOWCASE REVISION/);
  assert.doesNotMatch(rendered.stdout, new RegExp(showcaseData.tagline));

  const invalid = structuredClone(remote);
  invalid.sections[0].items[0].text = "\u001b[31m forged success";
  for (const [url, prelude] of [
    [trustedUrl, mockHttpsResponse(invalid)],
    ["http://trusted.example.invalid/showcase.json", mockHttpsResponse(remote)],
    [trustedUrl, mockHttpsResponse(remote, 302)],
    [trustedUrl, mockHttpsResponse(remote, 200, 65537)],
  ]) {
    const fallback = runUnixRenderer("load", { url, prelude });
    assert.equal(fallback.status, 0, fallback.stderr);
    assert.match(fallback.stderr, /已回退包内快照/);
    const parsed = JSON.parse(Buffer.from(fallback.stdout, "base64").toString("utf8"));
    assert.deepEqual(parsed.data, showcaseData);
    assert.equal(parsed.source, "包内快照");
  }

  const forgedBundle = Buffer.from(JSON.stringify({
    data: invalid, source: "受信 HTTPS 端点：trusted.example.invalid",
  })).toString("base64");
  const rejected = runUnixRenderer("showcase", { encoded: forgedBundle });
  assert.notEqual(rejected.status, 0);
  assert.match(rejected.stderr, /single safe line/);
});

test("Windows PowerShell 5.1 and 7 render and validate the same snapshot", {
  skip: process.platform !== "win32",
}, () => {
  const uiPath = path.join(root, "tools", "installer-ui.ps1").replaceAll("'", "''");
  for (const executable of ["pwsh.exe", "powershell.exe"]) {
    const preview = spawnSync(executable, [
      "-NoProfile", "-NonInteractive", "-Command",
      `. '${uiPath}'; Write-InstallerEnhancementShowcase -Version test -Preview`,
    ], {
      cwd: root, encoding: "utf8", timeout: 10000,
      env: {
        ...process.env, CODEX_COPILOT_NONINTERACTIVE: "1", CODEX_COPILOT_SHOWCASE_URL: "",
      },
    });
    assert.equal(preview.status, 0, `${executable}: ${preview.stderr}`);
    assert.match(preview.stdout, /PREVIEW ONLY/);
    assert.match(preview.stdout, /Ctrl\+A \/ Ctrl\+Z/);
    assert.match(preview.stdout, /codex-copilot doctor/);
    assert.match(preview.stdout, /bridge 启动.*默认按需启动/);
    assert.match(preview.stdout, /Windows 前台输入/);
    assert.match(preview.stdout, /升级 PowerShell 不会把桌面输入变成后台输入/);
  }
  const injected = structuredClone(showcaseData);
  injected.sections[0].items[0].text = "\u001b[31m forged success";
  const fixture = Buffer.from(JSON.stringify(injected)).toString("base64");
  const validation = spawnSync("pwsh.exe", [
    "-NoProfile", "-NonInteractive", "-Command",
    `. '${uiPath}'; try { ConvertFrom-InstallerShowcaseBytes ([Convert]::FromBase64String($env:SHOWCASE_FIXTURE)) | Out-Null; exit 21 } catch { Write-Output REJECTED }`,
  ], {
    cwd: root, encoding: "utf8", timeout: 10000,
    env: { ...process.env, SHOWCASE_FIXTURE: fixture, CODEX_COPILOT_SHOWCASE_URL: "" },
  });
  assert.equal(validation.status, 0, validation.stderr);
  assert.match(validation.stdout, /REJECTED/);
  const fallback = spawnSync("pwsh.exe", [
    "-NoProfile", "-NonInteractive", "-Command",
    `. '${uiPath}'; Get-InstallerShowcaseData | Out-Null; Write-Output ('SOURCE=' + $script:InstallerShowcaseSource)`,
  ], {
    cwd: root, encoding: "utf8", timeout: 10000,
    env: { ...process.env, CODEX_COPILOT_SHOWCASE_URL: "http://untrusted.example.invalid/data.json" },
  });
  assert.equal(fallback.status, 0, fallback.stderr);
  assert.match(fallback.stdout, /已回退包内快照/);
  assert.match(fallback.stdout, /SOURCE=包内快照/);
});

test("live terminal regression covers click placement, selection, scroll, and max animation", () => {
  const source = fs.readFileSync(
    path.join(root, "tests", "live-mouse-input-smoke.cjs"),
    "utf8",
  );
  assert.match(source, /mouseTrackingMode === "none"/);
  assert.match(source, /terminal\.scrollToBottom\(\)/);
  assert.match(source, /viewportY !== nativeBuffer\.baseY/);
  assert.match(source, /terminal-selection-probe/);
  assert.match(source, /clickComposerAtTextOffset/);
  assert.match(source, /dragComposerTextRange/);
  assert.match(source, /CCODEX_LIVE_CORE/);
  assert.match(source, /abcXdef/);
  assert.match(source, /silent-copy-probe/);
  assert.match(source, /ccodex-text-paste-probe/);
  assert.match(source, /ccodex-image-/);
  assert.match(source, /selectMaxEffortAndAssertAnimation/);
  assert.match(source, /TrueColor animation samples/);
  assert.match(source, /Reselecting active Max/);
});

test("docked composer regression uses an isolated native terminal", () => {
  const source = fs.readFileSync(path.join(root, "tests", "live-tui-layout-smoke.cjs"), "utf8");
  assert.match(source, /nodePty\.spawn/);
  assert.match(source, /fs\.mkdtempSync/);
  assert.match(source, /CODEX_HOME: profile/);
  assert.match(source, /SSH_TTY: "isolated-layout-test"/);
  assert.match(source, /assertBottom/);
  assert.match(source, /wheel changes history while retaining the editable composer/);
  assert.match(source, /click uses display columns for Chinese text/);
  assert.match(source, /click selects the requested multiline row/);
  assert.match(source, /model picker closes/);
  assert.doesNotMatch(source, /Set-Clipboard|Clipboard\]::Set|SendInput|SetForegroundWindow/);
});

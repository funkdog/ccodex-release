[CmdletBinding()]
param(
    [string]$SourceRoot
)

$ErrorActionPreference = 'Stop'
if (-not $SourceRoot) { $SourceRoot = Split-Path -Parent $PSScriptRoot }
$testRoot = Join-Path ([System.IO.Path]::GetTempPath()) ("codex-copilot-smoke-" + [guid]::NewGuid().ToString('N'))
$installRoot = Join-Path $testRoot 'install'
$profileHome = Join-Path $testRoot 'profile'
$stockHome = Join-Path $testRoot 'stock'
$bundlePath = Join-Path $testRoot 'transfer.zip'
$expandedBundle = Join-Path $testRoot 'expanded'
$x64BundlePath = Join-Path $testRoot 'transfer-x64.zip'
$expandedX64Bundle = Join-Path $testRoot 'expanded-x64'
$port = 22991

function Assert-True([bool]$Condition, [string]$Message) {
    if (-not $Condition) { throw $Message }
}

function Get-PeMachine([string]$Path) {
    $bytes = [System.IO.File]::ReadAllBytes($Path)
    $peOffset = [BitConverter]::ToUInt32($bytes, 0x3c)
    return [BitConverter]::ToUInt16($bytes, $peOffset + 4)
}

try {
    New-Item -ItemType Directory -Path $stockHome -Force | Out-Null
    @'
approval_policy = "on-request"
hide_agent_reasoning = false
model_context_window = 999999
model_auto_compact_token_limit = 888888

[windows]
sandbox = "unelevated"

[desktop]
ambient-suggestions-enabled = false
'@ | Set-Content -LiteralPath (Join-Path $stockHome 'config.toml') -Encoding UTF8

    $installArgs = @{
        InstallRoot = $installRoot
        CodexCopilotHome = $profileHome
        SourceCodexHome = $stockHome
        BridgePort = $port
        AuthMode = 'saved'
        SkipLogin = $true
        SkipSkill = $true
        NoPath = $true
        NoShortcuts = $true
        NoStart = $true
        NoPrerequisiteInstall = $true
        UseBundledCodexRuntime = $true
    }

    & (Join-Path $SourceRoot 'install.ps1') @installArgs

    $configPath = Join-Path $profileHome 'config.toml'
    Assert-True (Test-Path -LiteralPath $configPath) 'Generated config.toml is missing.'
    $config = Get-Content -LiteralPath $configPath -Raw
    Assert-True ($config -match 'model_provider\s*=\s*"github-copilot"') 'Generated config has the wrong provider.'
    Assert-True ($config -match '(?m)^model_catalog_json\s*=\s*".*models-desktop\.json"') 'Desktop must load its explicit context presets.'
    Assert-True ($config -match '\[model_providers\.github-copilot\.auth\]') 'Generated config is missing command auth.'
    Assert-True ($config -match "127\.0\.0\.1:$port") 'Generated config has the wrong bridge port.'
    Assert-True ($config -match 'ambient-suggestions-enabled\s*=\s*false') 'Destination stock preferences were not inherited.'
    Assert-True ($config -match '(?m)^model_context_window\s*=\s*999999') 'The native context-window preference was lost.'
    Assert-True ($config -match '(?m)^model_auto_compact_token_limit\s*=\s*888888') 'The native compaction preference was lost.'
    Assert-True ($config -match '(?m)^check_for_update_on_startup\s*=\s*false') 'Pinned CodexCopilot profile must suppress stock core update prompts.'
    Assert-True ($config -match '(?m)^status_line\s*=.*context-used.*cache-hit') 'Generated TUI config is missing context/cache status fields.'
    Assert-True (Test-Path -LiteralPath (Join-Path $installRoot 'skills\codex-copilot-manager\SKILL.md')) 'Bundled skill is missing.'
    $corePointer = Join-Path $installRoot 'bin\core-current.txt'
    Assert-True (Test-Path -LiteralPath $corePointer) 'Versioned Codex core pointer is missing.'
    $selectedCore = (Get-Content -LiteralPath $corePointer -Raw).Trim()
    Assert-True (Test-Path -LiteralPath $selectedCore) 'Versioned Codex core is missing.'
    Assert-True ((Get-PeMachine $selectedCore) -eq 0xAA64) 'ARM64 smoke install selected the wrong Codex core.'
    Assert-True ((Get-PeMachine (Join-Path $installRoot 'bin\runtimes\arm64\codex-copilot-core.exe')) -eq 0xAA64) 'Bundled ARM64 Codex core has the wrong architecture.'
    Assert-True ((Get-PeMachine (Join-Path $installRoot 'bin\runtimes\x64\codex-copilot-core.exe')) -eq 0x8664) 'Bundled x64 Codex core has the wrong architecture.'
    foreach ($arch in @('arm64', 'x64')) {
        $manifestPath = Join-Path $installRoot "bin\runtimes\$arch\codex-copilot-core.manifest.json"
        Assert-True (Test-Path -LiteralPath $manifestPath) "Core build manifest is missing for $arch."
        $manifest = Get-Content -LiteralPath $manifestPath -Raw | ConvertFrom-Json
        $corePath = Join-Path $installRoot "bin\runtimes\$arch\codex-copilot-core.exe"
        Assert-True ($manifest.packageVersion -eq (Get-Content -LiteralPath (Join-Path $installRoot 'VERSION') -Raw).Trim()) "Core build manifest version mismatch for $arch."
        Assert-True ($manifest.sha256 -eq (Get-FileHash -LiteralPath $corePath -Algorithm SHA256).Hash) "Core build manifest hash mismatch for $arch."
    }
    Assert-True (Test-Path -LiteralPath (Join-Path $installRoot 'bin\codex-code-mode-host.exe')) 'Code Mode host is missing.'
    Assert-True (Test-Path -LiteralPath (Join-Path $installRoot 'patches\codex-context-picker.patch')) 'Canonical Codex core patch is missing.'
    Assert-True (Test-Path -LiteralPath (Join-Path $installRoot 'patches\codex-clipboard-terminal-selection-animation.patch')) 'Clipboard/selection/animation patch is missing.'
    Assert-True (-not (Test-Path -LiteralPath (Join-Path $installRoot 'codex-core-patch.json'))) 'Bundled runtime mode should not patch the stock Codex core.'
    $desktopPatch = Get-Content -LiteralPath (Join-Path $installRoot 'bridge\desktop-patch.mjs') -Raw
    $desktopCdp = Get-Content -LiteralPath (Join-Path $installRoot 'bridge\desktop-cdp.mjs') -Raw
    Assert-True ($desktopPatch -match 'use_hidden_models:\s*false') 'Desktop model picker should not use the eight-model remote allowlist.'
    Assert-True ($desktopPatch -match 'data-codex-copilot-context-option-row') 'Desktop Context labels should use non-destructive CSS markers.'
    Assert-True ($desktopPatch -notmatch 'characterData:\s*true') 'Desktop Context observer must not loop on text mutations.'
    Assert-True ($desktopPatch -notmatch 'itemLeaves\[[^\]]+\]\.textContent\s*=') 'Desktop Context patch must not replace React text nodes.'
    Assert-True ($desktopPatch -match 'catalog-generation\.json') 'Desktop helper is missing catalog generation monitoring.'
    Assert-True ($desktopPatch -match 'location\.reload\(\)') 'Desktop helper is missing safe catalog reload.'
    Assert-True ($desktopPatch -match 'Runtime\.addBinding') 'Desktop account bridge binding is missing.'
    Assert-True ($desktopPatch -match 'connection\.evaluate\(buildAccountUiPatch\(\)\)') 'Desktop account card is not attached to the native profile button.'
    Assert-True ($desktopPatch -match 'readAccountGeneration') 'Desktop helper is not monitoring shared account generations.'
    Assert-True ($desktopPatch -match 'SELECTION_GENERATION_FILE') 'Desktop helper is not monitoring shared selection generations.'
    Assert-True ($desktopPatch -match 'catalogReloadPatch') 'Desktop helper is missing safe model-state reload.'
    Assert-True ($desktopPatch -match 'await reloadPage\(' -and $desktopCdp -match 'Page\.reload') 'Desktop account refresh is not forcing a real renderer reload.'
    Assert-True ($desktopCdp -match 'ignoreCache:\s*true') 'Desktop account refresh does not bypass the renderer model cache.'
    Assert-True ($desktopPatch -match 'Runtime\.executionContextsCleared') 'Desktop helper does not reattach after renderer reload.'
    Assert-True ($desktopPatch -match 'renderer context changed; reattaching') 'Desktop helper does not probe and reattach after SPA reload.'
    Assert-True (Test-Path -LiteralPath (Join-Path $installRoot 'bridge\desktop-actions.mjs')) 'Desktop system-browser helper is missing.'
    Assert-True (Test-Path -LiteralPath (Join-Path $installRoot 'bridge\desktop-profile.mjs')) 'Desktop context profile synchronizer is missing.'
    Assert-True (Test-Path -LiteralPath (Join-Path $installRoot 'bridge\account-store.mjs')) 'Shared account generation store is missing.'
    $bridgeServer = Get-Content -LiteralPath (Join-Path $installRoot 'bridge\server.mjs') -Raw
    Assert-True ($bridgeServer -match '/account/switch') 'Bridge is missing the Desktop account switch API.'
    Assert-True ($bridgeServer -match 'persist:\s*false') 'Bridge device flow persists credentials before validation.'
    Assert-True ($bridgeServer -match 'publishAccountSnapshot') 'Bridge is not publishing shared account state.'
    $publicSwitch = [regex]::Match(
        $bridgeServer,
        '(?ms)^\s*function publicAccountSwitch\(session\) \{.*?^\s*\}'
    ).Value
    Assert-True ($publicSwitch -and $publicSwitch -notmatch 'oauth_token|access_token') 'Desktop account API must not expose OAuth tokens.'
    $ccodexLauncher = Get-Content -LiteralPath (Join-Path $installRoot 'bin\ccodex.cmd') -Raw
    Assert-True ($ccodexLauncher -match 'FORCE_COLOR=3') 'ccodex should force animation-capable terminal colors.'
    Assert-True ($ccodexLauncher -match 'set "CCODEX_USE_PROXY="') 'ccodex should explicitly disable the nested ConPTY proxy.'
    Assert-True ($ccodexLauncher -notmatch 'CCODEX_USE_PROXY=1') 'ccodex must not enable the lossy nested ConPTY proxy.'
    $coreLauncher = Get-Content -LiteralPath (Join-Path $installRoot 'bin\codex-copilot.cmd') -Raw
    Assert-True ($coreLauncher -match 'CODEX_COPILOT_CATALOG_FILE') 'CLI launcher is missing live catalog refresh configuration.'
    Assert-True ($coreLauncher -match 'model_catalog_json=%CODEX_COPILOT_CATALOG_FILE%') 'CLI must override the Desktop-only model catalog.'
    Assert-True ($coreLauncher -match 'cli-launch-overrides\.mjs') 'CLI must translate Desktop context aliases.'
    Assert-True ($coreLauncher -match 'CODEX_COPILOT_SELECTION_FILE') 'CLI launcher is missing shared selection hot reload configuration.'
    Assert-True ($coreLauncher -match 'codex-copilot-core\.next\.exe') 'CLI launcher is missing staged core upgrade support.'
    Assert-True ($coreLauncher -match 'core-current\.txt') 'CLI launcher is missing versioned core selection.'
    Assert-True ($coreLauncher -match 'ccodex-smart-paste\.cjs') 'CLI launcher is not wired to the synchronized terminal proxy.'
    Assert-True ($coreLauncher -match '"update"\s+goto :run_cli_update') 'CLI launcher is missing the independent validated enhanced update path.'
    Assert-True ($coreLauncher -match 'bridge\\cli-update\.mjs') 'CLI update does not use the provenance/compatibility validator.'
    $bridgeCli = Get-Content -LiteralPath (Join-Path $installRoot 'bridge\cli.mjs') -Raw
    Assert-True ($bridgeCli -match 'BRIDGE_ENDPOINT.*account/switch|accountRequest\(\"/account/switch\"') 'CLI account switch is not using the shared bridge state machine.'
    Assert-True ($bridgeCli -notmatch 'deviceLogin\(') 'CLI still runs an isolated device flow.'
    $installer = Get-Content -LiteralPath (Join-Path $installRoot 'install.ps1') -Raw
    Assert-True ($installer -match 'Repair-LegacyCcCodexWrapper') 'Installer is missing legacy ccodex dispatcher repair.'
    Assert-True ($installer -match 'CodexCopilot\\bin\\ccodex\.cmd') 'Installer does not replace a legacy proxy wrapper with a stable forwarding shim.'
    Assert-True ($installer -match 'Get-CodexCopilotArchitecture') 'Installer is missing destination architecture detection.'
    Assert-True ($installer -match 'bin\\runtimes\\\$runtimeArchitecture') 'Installer is not selecting an architecture-specific Codex core.'
    Assert-True (Test-Path -LiteralPath (Join-Path $installRoot 'bin\ccodex-smart-paste.cjs')) 'Synchronized terminal proxy is missing.'
    $terminalProxy = Get-Content -LiteralPath (Join-Path $installRoot 'bin\ccodex-smart-paste.cjs') -Raw
    Assert-True ($terminalProxy -notmatch '\?2026[hl]') 'Terminal proxy must preserve Codex native synchronized frames.'
    $responsivePatch = Get-Content -LiteralPath (Join-Path $installRoot 'patches\codex-responsive-tui-v4.patch') -Raw
    Assert-True ($responsivePatch -match 'TerminalPaste::ClipboardImage') 'Native core patch is missing empty bracketed-paste image routing.'
    $clipboardPatch = Get-Content -LiteralPath (Join-Path $installRoot 'patches\codex-clipboard-terminal-selection-animation.patch') -Raw
    Assert-True ($clipboardPatch -match 'PastedClipboardContent::Text') 'Native core patch is missing clipboard text fallback.'
    Assert-True ($clipboardPatch -match 'EnableMouseCapture') 'Native core patch is missing mouse click placement.'
    Assert-True ($clipboardPatch -match 'CCODEX_MOUSE_CAPTURE=0') 'Native core patch is missing the terminal-owned mouse fallback.'
    Assert-True ($clipboardPatch -match 'force_color_three_enables_truecolor_animation') 'Native core patch is missing FORCE_COLOR=3 animation coverage.'
    $desktopLauncherSource = Get-Content -LiteralPath (Join-Path $installRoot 'src\CodexCopilotDesktop.cs') -Raw
    Assert-True ($desktopLauncherSource -notmatch 'ActiveCorePath|core-current\.txt') 'Desktop must use its own registered core, not the independently pinned CLI.'
    Assert-True ($desktopLauncherSource -match 'if \(RejectRunningDesktop\(\)\) return 2' -and
        $desktopLauncherSource -notmatch 'if \(before\.Count > 0\) return true') 'Desktop launcher must not report a stale running app as a successful new activation.'
    Assert-True ($desktopLauncherSource -match 'Quit from the system tray' -and
        $desktopLauncherSource -match 'No running session was stopped') 'Desktop launcher must explain how to restart without killing an active session.'
    $nodePtyPath = Join-Path $installRoot 'bin\node-pty'
    Assert-True (Test-Path -LiteralPath (Join-Path $nodePtyPath 'lib\index.js')) 'Bundled node-pty JavaScript is missing.'
    $nodePtyUtils = Get-Content -LiteralPath (Join-Path $nodePtyPath 'lib\utils.js') -Raw
    Assert-True ($nodePtyUtils.IndexOf('prebuilds/') -lt $nodePtyUtils.IndexOf('build/Release')) 'node-pty must prefer architecture-specific prebuilds over legacy build output.'
    Assert-True (Test-Path -LiteralPath (Join-Path $nodePtyPath 'prebuilds\win32-arm64\conpty.node')) 'Bundled ARM64 node-pty native module is missing.'
    Assert-True (Test-Path -LiteralPath (Join-Path $nodePtyPath 'prebuilds\win32-x64\conpty.node')) 'Bundled x64 node-pty native module is missing.'
    Assert-True ((Get-PeMachine (Join-Path $nodePtyPath 'prebuilds\win32-arm64\conpty.node')) -eq 0xAA64) 'Bundled ARM64 node-pty has the wrong architecture.'
    Assert-True ((Get-PeMachine (Join-Path $nodePtyPath 'prebuilds\win32-x64\conpty.node')) -eq 0x8664) 'Bundled x64 node-pty has the wrong architecture.'
    & node -e "const p=require(process.argv[1]);if(typeof p.spawn!=='function')process.exit(1)" $nodePtyPath
    Assert-True ($LASTEXITCODE -eq 0) 'Bundled node-pty could not be loaded.'

    $contextTest = Join-Path $testRoot 'context-test.mjs'
    @'
import fs from "node:fs";
import path from "node:path";
import { pathToFileURL } from "node:url";

const installRoot = process.env.TEST_INSTALL_ROOT;
const profileHome = process.env.TEST_PROFILE_HOME;
process.env.CODEX_COPILOT_HOME = profileHome;

const catalogModule = await import(pathToFileURL(path.join(installRoot, "bridge", "catalog.mjs")).href);
const catalogStore = await import(pathToFileURL(path.join(installRoot, "bridge", "catalog-store.mjs")).href);
const authModule = await import(pathToFileURL(path.join(installRoot, "bridge", "auth.mjs")).href);
const requestSanitize = await import(pathToFileURL(path.join(installRoot, "bridge", "request-sanitize.mjs")).href);
const accountStore = await import(pathToFileURL(path.join(installRoot, "bridge", "account-store.mjs")).href);
const raw = [{
  id: "gpt-test",
  name: "GPT Test",
  vendor: "OpenAI",
  model_picker_enabled: true,
  supported_endpoints: ["/responses"],
  capabilities: {
    type: "chat",
    family: "gpt",
    supports: { reasoning_effort: ["low", "high"] },
    limits: {
      max_prompt_tokens: 922000,
      max_context_window_tokens: 1050000,
      max_output_tokens: 128000,
    },
  },
  codex_copilot_context: {
    default_prompt_tokens: 272000,
    long_context_prompt_tokens: 922000,
  },
}];

const generated = catalogModule.buildCatalog(raw);
if (generated.models.length !== 1) throw new Error("Expected one canonical model.");
const model = generated.models[0];
if (model.slug !== "gpt-test") throw new Error("Canonical model slug changed.");
if (model.context_window !== 272000 || model.copilot?.default_context_window_tokens !== 400000) {
  throw new Error("Default context limits are incorrect.");
}
if (model.max_context_window !== 922000 || model.copilot?.long_context_window_tokens !== 1050000) {
  throw new Error("Long-context limits are incorrect.");
}
if (model.service_tiers?.[0]?.id !== "context-long") {
  throw new Error("Context interaction metadata is missing.");
}
if (model.service_tiers[0].name !== "1.1M" || model.service_tiers[0].description !== "400K") {
  throw new Error("Context choices should use Copilot-style size-only labels.");
}

const eighteenRaw = Array.from({ length: 18 }, (_, index) => ({
  ...raw[0],
  id: `gpt-5-fixture-${String(index + 1).padStart(2, "0")}`,
  name: `GPT-5 Fixture ${index + 1}`,
}));
const eighteenCatalog = catalogModule.buildCatalog(eighteenRaw);
if (eighteenCatalog.models.length !== 18) {
  throw new Error(`Eligible model catalog was capped at ${eighteenCatalog.models.length}.`);
}
if (new Set(eighteenCatalog.models.map((entry) => entry.slug)).size !== 18) {
  throw new Error("Eligible model catalog contains duplicate slugs.");
}

const sortFixture = [
  ["claude-opus-4.8", "Anthropic", "claude-opus-4.8"],
  ["gpt-5.4", "OpenAI", "gpt-5.4"],
  ["gemini-3.1-pro-preview", "Google", "gemini-3.1-pro-preview"],
  ["gpt-5.6-sol", "OpenAI", "gpt-5.6-sol"],
  ["claude-opus-5", "Anthropic", "claude-opus-5"],
  ["gemini-3.6-flash", "Google", "gemini-3.6-flash"],
  ["grok-4.5", "xAI", "grok-4.5"],
  ["mai-code-1-flash-picker", "Microsoft", "mai-code-1-flash-picker"],
  ["gpt-5-mini", "Azure OpenAI", "gpt-5-mini"],
].map(([id, vendor, version]) => ({
  ...raw[0],
  id,
  name: id,
  vendor,
  version,
}));
const sortedSlugs = catalogModule
  .buildCatalog(sortFixture)
  .models.map((entry) => entry.slug);
const expectedSort = [
  "gpt-5.6-sol",
  "gpt-5.4",
  "gpt-5-mini",
  "claude-opus-5",
  "claude-opus-4.8",
  "gemini-3.6-flash",
  "gemini-3.1-pro-preview",
  "grok-4.5",
  "mai-code-1-flash-picker",
];
if (JSON.stringify(sortedSlugs) !== JSON.stringify(expectedSort)) {
  throw new Error(`Vendor/release ordering is incorrect: ${sortedSlugs.join(", ")}`);
}

const request = {
  store: true,
  tools: [{ type: "function", name: "top_level", description: "" }],
  input: [{
    role: "developer",
    tools: [{
      type: "function",
      function: { name: "nested", description: "  " },
    }],
  }],
};
const sanitizedRequest = requestSanitize.sanitizeResponsesBody(request);
if ("store" in sanitizedRequest) throw new Error("Unsupported Responses fields were not stripped.");
if (sanitizedRequest.tools[0].description !== "Run top_level") {
  throw new Error("Top-level empty tool description was not normalized.");
}
if (sanitizedRequest.input[0].tools[0].function.description !== "Run nested") {
  throw new Error("Nested empty tool description was not normalized.");
}
if (request.tools[0].description !== "" || request.input[0].tools[0].function.description !== "  ") {
  throw new Error("Responses request sanitization mutated the original request.");
}

const mergedModels = authModule.mergeCopilotModelLists([
  [{
    ...raw[0],
    id: "gpt-flapping",
    model_picker_enabled: false,
    supported_endpoints: ["/chat/completions"],
    capabilities: { ...raw[0].capabilities, limits: { max_context_window_tokens: 400000 } },
  }],
  [{
    ...raw[0],
    id: "gpt-flapping",
    model_picker_enabled: true,
    supported_endpoints: ["/responses"],
    capabilities: { ...raw[0].capabilities, limits: { max_context_window_tokens: 1050000 } },
  }, {
    ...raw[0],
    id: "gpt-only-in-large-sample",
  }],
]);
if (
  mergedModels.length !== 2 ||
  !mergedModels[0].model_picker_enabled ||
  !mergedModels[0].supported_endpoints.includes("/responses") ||
  mergedModels[0].capabilities.limits.max_context_window_tokens !== 1050000
) {
  throw new Error("Flapping Copilot model responses were not merged safely.");
}

const fullEntitlement = authModule.stabilizeCopilotModels(
  "flapping-account",
  eighteenRaw,
  { now: Date.parse("2026-08-07T00:00:00Z") },
);
const reducedEntitlement = authModule.stabilizeCopilotModels(
  "flapping-account",
  eighteenRaw.slice(0, 8),
  { now: Date.parse("2026-08-07T00:01:00Z") },
);
if (fullEntitlement.length !== 18 || reducedEntitlement.length !== 18) {
  throw new Error("A transient smaller /models snapshot erased cached entitlement records.");
}
const otherAccount = authModule.stabilizeCopilotModels(
  "different-account",
  eighteenRaw.slice(0, 3),
  { now: Date.parse("2026-08-07T00:01:00Z") },
);
if (otherAccount.length !== 3) {
  throw new Error("Copilot model entitlement cache leaked across GitHub accounts.");
}

const accountA = accountStore.publishAccountSnapshot({
  login: "account-a",
  source: "test",
  models: 3,
}, { forceNew: true });
const accountB = accountStore.publishAccountSnapshot({
  login: "account-b",
  source: "test",
  models: 4,
}, { forceNew: true });
const accountAAgain = accountStore.publishAccountSnapshot({
  login: "account-a",
  source: "test",
  models: 3,
}, { forceNew: true });
if (
  new Set([
    accountA.generation,
    accountB.generation,
    accountAAgain.generation,
  ]).size !== 3
) {
  throw new Error("Switching back to a previous account reused an old generation.");
}

fs.writeFileSync(path.join(profileHome, "models_cache.json"), "stale", "utf8");
  const firstPublished = catalogStore.writeCatalogSnapshot(generated);
  if (!firstPublished.changed || fs.existsSync(path.join(profileHome, "models_cache.json"))) {
    throw new Error("Initial catalog publication did not invalidate Codex's model cache.");
  }
  if (!fs.existsSync(path.join(profileHome, "models-desktop.json"))) {
    throw new Error("Desktop context presets were not published.");
  }
const firstGeneration = catalogStore.readCatalogGeneration();
fs.writeFileSync(path.join(profileHome, "models_cache.json"), "stale", "utf8");
const secondPublished = catalogStore.writeCatalogSnapshot(eighteenCatalog);
if (!secondPublished.changed || fs.existsSync(path.join(profileHome, "models_cache.json"))) {
  throw new Error("18-model catalog publication did not invalidate Codex's model cache.");
}
if (!firstGeneration || catalogStore.readCatalogGeneration() === firstGeneration) {
  throw new Error("Catalog generation did not change with the eligible model set.");
}
catalogStore.writeCatalogSnapshot(generated);
const useModel = await import(pathToFileURL(path.join(installRoot, "bridge", "use-model.mjs")).href);
  const selected = useModel.use("gpt-test", "high", "long_context");
  if (selected.model !== "gpt-test" || selected.contextTier !== "long_context") {
    throw new Error("Context-aware model selection failed.");
  }
  const config = fs.readFileSync(path.join(profileHome, "config.toml"), "utf8");
  if (!/^model\s*=\s*"gpt-test--long-context"/m.test(config)) {
    throw new Error("Desktop-compatible model preset was not persisted.");
  }
  if (/^service_tier\s*=/m.test(config)) {
    throw new Error("Desktop default still relies on a service tier without a larger window.");
}
if (/^model_(?:context_window|auto_compact_token_limit)\s*=/m.test(config)) {
  throw new Error("A global context override would mask the selected catalog variant.");
}
'@ | Set-Content -LiteralPath $contextTest -Encoding UTF8
    $env:TEST_INSTALL_ROOT = $installRoot
    $env:TEST_PROFILE_HOME = $profileHome
    & node $contextTest
    Assert-True ($LASTEXITCODE -eq 0) 'Context variant test failed.'
    & node (Join-Path $installRoot 'tests\account-api-test.mjs')
    Assert-True ($LASTEXITCODE -eq 0) 'Desktop account API test failed.'
    & node (Join-Path $installRoot 'tests\desktop-actions-test.mjs')
    Assert-True ($LASTEXITCODE -eq 0) 'Desktop system-browser action test failed.'

    # Re-run from the installed copy to exercise the self-update staging path.
    & (Join-Path $installRoot 'install.ps1') @installArgs

    & (Join-Path $installRoot 'tools\New-TransferBundle.ps1') -OutputPath $bundlePath -Target windows-arm64
    Assert-True (Test-Path -LiteralPath $bundlePath) 'Transfer bundle was not created.'

    Expand-Archive -LiteralPath $bundlePath -DestinationPath $expandedBundle
    Assert-True (Test-Path -LiteralPath (Join-Path $expandedBundle 'install.cmd')) 'Transfer bundle is missing install.cmd.'
    Assert-True (Test-Path -LiteralPath (Join-Path $expandedBundle 'install.ps1')) 'Transfer bundle is missing install.ps1.'
    Assert-True (Test-Path -LiteralPath (Join-Path $expandedBundle 'RELEASE_NOTES.md')) 'Transfer bundle is missing release notes.'
    Assert-True (Test-Path -LiteralPath (Join-Path $expandedBundle 'NATIVE_COMPATIBILITY.md')) 'Transfer bundle is missing native compatibility guidance.'
    Assert-True (Test-Path -LiteralPath (Join-Path $expandedBundle 'MIGRATION.zh-CN.md')) 'Transfer bundle is missing the Chinese migration guide.'
    Assert-True (Test-Path -LiteralPath (Join-Path $expandedBundle 'skills\codex-copilot-manager\SKILL.md')) 'Transfer bundle is missing the skill.'
    Assert-True (-not (Test-Path -LiteralPath (Join-Path $expandedBundle 'github-auth.json'))) 'Transfer bundle contains github-auth.json.'
    $transferSettings = Get-Content -LiteralPath (Join-Path $expandedBundle 'transfer-settings.json') -Raw | ConvertFrom-Json
    Assert-True ($transferSettings.containsCredentials -eq $false) 'Transfer settings claim to contain credentials.'
    Assert-True (-not [string]::IsNullOrWhiteSpace([string]$transferSettings.defaultContextTier)) 'Transfer settings did not preserve the context tier preference.'
    $armManifest = Get-Content -LiteralPath (Join-Path $expandedBundle 'platform-target.json') -Raw | ConvertFrom-Json
    Assert-True ($armManifest.target -eq 'windows-arm64') 'ARM64 bundle has the wrong target manifest.'
    $armCore = Join-Path $expandedBundle 'bin\runtimes\arm64\codex-copilot-core.exe'
    Assert-True (Test-Path -LiteralPath $armCore) 'ARM64 bundle is missing its core.'
    Assert-True (-not (Test-Path -LiteralPath (Join-Path $expandedBundle 'bin\runtimes\x64'))) 'ARM64 bundle contains the x64 core.'
    Assert-True (Test-Path -LiteralPath (Join-Path $expandedBundle 'bin\node-pty\prebuilds\win32-arm64\conpty.node')) 'ARM64 bundle is missing node-pty.'
    Assert-True (-not (Test-Path -LiteralPath (Join-Path $expandedBundle 'bin\node-pty\prebuilds\win32-x64'))) 'ARM64 bundle contains x64 node-pty.'

    & (Join-Path $installRoot 'tools\New-TransferBundle.ps1') -OutputPath $x64BundlePath -Target windows-x64
    Expand-Archive -LiteralPath $x64BundlePath -DestinationPath $expandedX64Bundle
    $x64Manifest = Get-Content -LiteralPath (Join-Path $expandedX64Bundle 'platform-target.json') -Raw | ConvertFrom-Json
    Assert-True ($x64Manifest.target -eq 'windows-x64') 'x64 bundle has the wrong target manifest.'
    $x64Core = Join-Path $expandedX64Bundle 'bin\runtimes\x64\codex-copilot-core.exe'
    Assert-True ((Get-PeMachine $x64Core) -eq 0x8664) 'x64 bundle core has the wrong architecture.'
    Assert-True (-not (Test-Path -LiteralPath (Join-Path $expandedX64Bundle 'bin\runtimes\arm64'))) 'x64 bundle contains the ARM64 core.'
    Assert-True ((Get-PeMachine (Join-Path $expandedX64Bundle 'bin\node-pty\prebuilds\win32-x64\conpty.node')) -eq 0x8664) 'x64 bundle node-pty has the wrong architecture.'
    Assert-True (-not (Test-Path -LiteralPath (Join-Path $expandedX64Bundle 'bin\node-pty\prebuilds\win32-arm64'))) 'x64 bundle contains ARM64 node-pty.'
    $armVersion = (& $armCore --version | Out-String).Trim()
    $x64Version = (& $x64Core --version | Out-String).Trim()
    Assert-True ($armVersion -match '^codex-cli \S+$') 'ARM64 bundle core cannot execute.'
    Assert-True ($x64Version -eq $armVersion) 'x64 bundle core cannot execute under Windows emulation or has a different version.'
    $mismatchRejected = $false
    try {
        & (Join-Path $expandedX64Bundle 'install.ps1') `
            -InstallRoot (Join-Path $testRoot 'wrong-arch-install') `
            -CodexCopilotHome (Join-Path $testRoot 'wrong-arch-profile') `
            -NoPrerequisiteInstall -SkipLogin -SkipSkill -NoPath -NoShortcuts -NoStart
    } catch {
        $mismatchRejected = $_.Exception.Message -match 'targets windows-x64.*windows-arm64'
    }
    Assert-True $mismatchRejected 'The x64 installer did not reject an ARM64 destination.'

    $tokenPattern = 'gh(?:o|u|p)_[A-Za-z0-9_]{20,}|github_pat_[A-Za-z0-9_]{20,}'
    foreach ($bundleRoot in @($expandedBundle, $expandedX64Bundle)) {
        foreach ($file in Get-ChildItem -LiteralPath $bundleRoot -Recurse -File) {
            if ($file.Extension -notin @('.cmd', '.cs', '.json', '.md', '.mjs', '.ps1', '.toml', '.txt')) { continue }
            Assert-True (-not ((Get-Content -LiteralPath $file.FullName -Raw) -match $tokenPattern)) "Transfer bundle contains a token-like value: $($file.FullName)"
        }
    }

    Write-Output 'CodexCopilot portable smoke test passed.'
} finally {
    if (Test-Path -LiteralPath $testRoot) {
        $testRootPrefix = [System.IO.Path]::GetFullPath($testRoot).TrimEnd(
            [System.IO.Path]::DirectorySeparatorChar,
            [System.IO.Path]::AltDirectorySeparatorChar
        ) + [System.IO.Path]::DirectorySeparatorChar
        Get-CimInstance Win32_Process -ErrorAction SilentlyContinue |
            Where-Object {
                $_.ExecutablePath -and
                [System.IO.Path]::GetFullPath($_.ExecutablePath).StartsWith(
                    $testRootPrefix,
                    [System.StringComparison]::OrdinalIgnoreCase
                )
            } |
            ForEach-Object { Stop-Process -Id $_.ProcessId -Force -ErrorAction SilentlyContinue }
        for ($attempt = 0; $attempt -lt 20; $attempt++) {
            try {
                Remove-Item -LiteralPath $testRoot -Recurse -Force
                break
            } catch {
                if ($attempt -eq 19) { throw }
                Start-Sleep -Milliseconds 200
            }
        }
    }
}

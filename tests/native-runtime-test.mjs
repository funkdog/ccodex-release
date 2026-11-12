import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { contained, discoverRuntime, reconcileNativeConfig, repairNativeProfile } from "../tools/native-runtime.mjs";
import { readSetting } from "../tools/config-document.mjs";

function fixture(t) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "ccodex-native-test-"));
  t.after(() => {
    assert.equal(path.dirname(fs.realpathSync(root)), fs.realpathSync(os.tmpdir()));
    fs.rmSync(root, { recursive: true, force: true });
  });
  const home = path.join(root, "profile");
  const runtimes = path.join(root, "runtimes");
  fs.mkdirSync(home);
  fs.mkdirSync(runtimes);
  function write(file, content = "") {
    fs.mkdirSync(path.dirname(file), { recursive: true });
    fs.writeFileSync(file, content);
    return file;
  }
  function runtime(folder, version, broken = false) {
    const dir = path.join(runtimes, folder);
    write(path.join(dir, "manifest.json"), JSON.stringify({
      platform: "windows", arch: "arm64", node_version: "24.0.0",
      runtime_archive_version: version, node_path: "bin/node.exe",
      node_modules: "bin/node_modules", node_repl_path: "bin/node_repl.exe",
    }));
    write(path.join(dir, "bin", "node.exe"));
    if (!broken) write(path.join(dir, "bin", "node_repl.exe"));
    fs.mkdirSync(path.join(dir, "bin", "node_modules"), { recursive: true });
    return path.join(dir, "bin", "node_repl.exe");
  }
  return { root, home, runtimes, write, runtime, platform: "win32", arch: "arm64", pipeExists: () => true };
}

function bundledMarketplaceSource(staged) {
  // Only a packaged release needs the Windows namespace prefix.
  return fs.existsSync(path.resolve(import.meta.dirname, "../release.json"))
    ? path.toNamespacedPath(staged) : staged;
}

test("runtime discovery uses manifest versions, not hash folder names, and rejects incomplete downloads", t => {
  const f = fixture(t);
  f.runtime("zz-old", "0.0.9/20260801");
  const next = f.runtime("aa-new", "0.0.16/20260915");
  f.runtime("new-incomplete", "0.0.17/20260922", true);
  assert.equal(discoverRuntime(f).repl, next);
  const old = f.runtime("preferred", "0.0.8/20260701");
  assert.equal(discoverRuntime({ ...f, preferred: old }).repl, old);
});

test("runtime manifest paths cannot escape the selected local runtime", t => {
  const f = fixture(t);
  assert.throws(() => contained(f.root, "../external"), /escaped/);
  assert.throws(() => contained(f.root, "C:\\external.exe"), /relative/);
  assert.throws(() => contained(f.root, "/external"), /relative/);
});

test("a directly bundled CUA runtime remains usable without global runtime discovery", t => {
  const f = fixture(t);
  const repl = f.runtime("direct", "0.0.27/pinned");
  const runtimes = path.dirname(path.dirname(repl));
  const input = `[mcp_servers.node_repl]\ncommand = ${JSON.stringify(repl)}\nargs = []\n`;
  const result = reconcileNativeConfig(input, { ...f, runtimes, surface: "cli" });
  assert.equal(result.runtime.repl, repl);
  assert.equal(readSetting(result.config, ["mcp_servers", "node_repl"], "command"), process.execPath);
  assert.equal(readSetting(result.config, ["mcp_servers", "node_repl", "env"],
    "CCODEX_NODE_REPL_NATIVE_PATH"), repl);
});

test("a missing manifest leaf cannot escape through an existing parent junction", t => {
  const f = fixture(t);
  const outside = path.join(f.root, "outside");
  fs.mkdirSync(outside);
  fs.symlinkSync(outside, path.join(f.home, "linked"), process.platform === "win32" ? "junction" : "dir");
  assert.throws(() => contained(f.home, "linked/missing/file.mjs"), /escaped/);
  assert.equal(fs.existsSync(path.join(outside, "missing")), false);
});

test("deleted runtime paths migrate while permissions, unknown services and pipe ownership remain unchanged", t => {
  const f = fixture(t);
  const repl = f.runtime("new-runtime", "0.0.16/20260915");
  const input = `approval_policy = "on-request"
[mcp_servers.node_repl]
command = ${JSON.stringify(path.join(f.runtimes, "deleted", "bin", "node_repl.exe"))}
enabled = false
env_vars = ["CODEX_WINDOWS_REGISTERED_CORE"]
[mcp_servers.node_repl.env]
SKY_CUA_NATIVE_PIPE_DIRECTORY = 'owned-pipe'
NODE_REPL_TRUSTED_SERVICES = '{"future":"keep"}'
NODE_REPL_UNTRUSTED_ENV_ALLOWLIST = "CODEX_WINDOWS_REGISTERED_CORE"
[plugins."private@custom"]
enabled = false
`;
  const result = reconcileNativeConfig(input, f);
  assert.equal(readSetting(result.config, ["mcp_servers", "node_repl"], "command"), repl);
  assert.equal(readSetting(result.config, [], "approval_policy"), "on-request");
  assert.equal(readSetting(result.config, ["mcp_servers", "node_repl"], "enabled"), false);
  assert.equal(readSetting(result.config, ["mcp_servers", "node_repl", "env"], "SKY_CUA_NATIVE_PIPE_DIRECTORY"), "owned-pipe");
  assert.equal(readSetting(result.config, ["mcp_servers", "node_repl", "env"], "NODE_REPL_TRUSTED_SERVICES"), '{"future":"keep"}');
  assert.ok(result.config.includes('env_vars = ["CODEX_WINDOWS_REGISTERED_CORE"]'));
  assert.equal(reconcileNativeConfig(result.config, f).config, result.config);
});

test("bundled marketplace uses the active profile staging directory, not a frozen app package path", t => {
  const f = fixture(t);
  const staged = path.join(f.home, ".tmp", "bundled-marketplaces", "openai-bundled");
  f.write(path.join(staged, ".agents", "plugins", "marketplace.json"), '{"name":"openai-bundled","plugins":[]}');
  const input = `[marketplaces.openai-bundled]\nsource_type = "local"\nsource = '/old/Desktop/resources/plugins/openai-bundled'\n`;
  const result = reconcileNativeConfig(input, f);
  assert.equal(readSetting(result.config, ["marketplaces", "openai-bundled"], "source"), bundledMarketplaceSource(staged));
  assert.equal(reconcileNativeConfig(result.config, f).config, result.config);
  const custom = input.replace("/old/Desktop/resources/plugins/openai-bundled", "/user/private-marketplace");
  assert.equal(reconcileNativeConfig(custom, f).config, custom);
});

test("missing browser service is recovered only from the exact local bundle version", t => {
  const f = fixture(t);
  const bundle = path.join(f.home, ".tmp", "bundled-marketplaces", "openai-bundled", "plugins", "browser");
  f.write(path.join(bundle, ".codex-plugin", "plugin.json"), '{"name":"browser","version":"future-version"}');
  f.write(path.join(bundle, "scripts", "browser-service.mjs"), "export const trusted = true;");
  f.write(path.join(bundle, "scripts", "browser-client.mjs"), "export const trusted = true;");
  const service = path.join(f.home, "plugins", "cache", "openai-bundled", "browser", "future-version", "scripts", "browser-service.mjs");
  const input = `[mcp_servers.node_repl.env]\nNODE_REPL_TRUSTED_SERVICES = ${JSON.stringify(JSON.stringify({ browser: service, sky: "@oai/sky/service", future: "untouched" }))}\n`;
  const result = reconcileNativeConfig(input, { ...f, repairFiles: true });
  assert.equal(fs.readFileSync(service, "utf8"), "export const trusted = true;");
  assert.equal(result.config, input);
  assert.equal(result.warnings.length, 0);
  const mismatch = input.replaceAll("future-version", "another-version");
  const failed = reconcileNativeConfig(mismatch, { ...f, repairFiles: true });
  assert.ok(failed.warnings.some(item => item.includes("incomplete")));
  assert.equal(fs.existsSync(service.replace("future-version", "another-version")), false);
});

test("browser recovery rejects destination junctions before copying any bundle files", t => {
  const f = fixture(t);
  const bundle = path.join(f.home, ".tmp", "bundled-marketplaces", "openai-bundled", "plugins", "browser");
  f.write(path.join(bundle, ".codex-plugin", "plugin.json"), '{"name":"browser","version":"test-version"}');
  f.write(path.join(bundle, "scripts", "browser-service.mjs"), "trusted service");
  f.write(path.join(bundle, "scripts", "browser-client.mjs"), "trusted client");
  const destination = path.join(f.home, "plugins", "cache", "openai-bundled", "browser", "test-version");
  const outside = path.join(f.root, "outside");
  fs.mkdirSync(outside);
  fs.mkdirSync(destination, { recursive: true });
  fs.symlinkSync(outside, path.join(destination, "scripts"), process.platform === "win32" ? "junction" : "dir");
  const service = path.join(destination, "scripts", "browser-service.mjs");
  const input = `[mcp_servers.node_repl.env]\nNODE_REPL_TRUSTED_SERVICES = ${JSON.stringify(JSON.stringify({ browser: service }))}\n`;
  const result = reconcileNativeConfig(input, { ...f, repairFiles: true });
  assert.match(result.warnings.join("\n"), /symlink/);
  assert.equal(result.actions.length, 0);
  assert.equal(fs.existsSync(path.join(outside, "browser-service.mjs")), false);
  assert.equal(fs.existsSync(path.join(destination, ".codex-plugin", "plugin.json")), false);
  assert.equal(result.config, input);
});

test("browser recovery reports a conflicting entry point instead of claiming success", t => {
  const f = fixture(t);
  const bundle = path.join(f.home, ".tmp", "bundled-marketplaces", "openai-bundled", "plugins", "browser");
  f.write(path.join(bundle, ".codex-plugin", "plugin.json"), '{"name":"browser","version":"test-version"}');
  f.write(path.join(bundle, "scripts", "browser-service.mjs"), "trusted service");
  f.write(path.join(bundle, "scripts", "browser-client.mjs"), "trusted client");
  const service = path.join(f.home, "plugins", "cache", "openai-bundled", "browser", "test-version", "scripts", "browser-service.mjs");
  fs.mkdirSync(service, { recursive: true });
  const input = `[mcp_servers.node_repl.env]\nNODE_REPL_TRUSTED_SERVICES = ${JSON.stringify(JSON.stringify({ browser: service }))}\n`;
  const result = reconcileNativeConfig(input, { ...f, repairFiles: true });
  assert.match(result.warnings.join("\n"), /conflicting directory/);
  assert.equal(result.actions.length, 0);
});

test("a dead native pipe is reported, not rebound to an unrelated Desktop instance", t => {
  const f = fixture(t);
  const input = "[mcp_servers.node_repl.env]\nSKY_CUA_NATIVE_PIPE_DIRECTORY = 'expired-owned-pipe'\n";
  const result = reconcileNativeConfig(input, { ...f, pipeExists: () => false });
  assert.equal(result.config, input);
  assert.match(result.warnings.join("\n"), /reload MCP/);
});

test("preflight only writes the explicitly isolated profile and is repeatable", t => {
  const f = fixture(t);
  f.write(path.join(f.home, "config.toml"), 'approval_policy = "on-request"\n');
  const first = repairNativeProfile(f);
  const second = repairNativeProfile(f);
  assert.equal(first.changed, false);
  assert.equal(second.changed, false);
  assert.equal(first.configSha256, second.configSha256);
});

test("CLI relay installation and Desktop unwrapping preserve the native launch and security settings", t => {
  const f = fixture(t);
  const repl = f.runtime("runtime", "0.0.16/current");
  const input = `[mcp_servers.node_repl]\ncommand = ${JSON.stringify(repl)}\nargs = []\nenv_vars = ["CODEX_WINDOWS_REGISTERED_CORE"]\n[mcp_servers.node_repl.env]\nSKY_CUA_NATIVE_PIPE_DIRECTORY = 'owned-pipe'\n`;
  const wrapped = reconcileNativeConfig(input, { ...f, surface: "cli" }).config;
  assert.equal(readSetting(wrapped, ["mcp_servers", "node_repl"], "command"), process.execPath);
  assert.equal(readSetting(wrapped, ["mcp_servers", "node_repl", "env"], "CCODEX_NODE_REPL_NATIVE_PATH"), repl);
  assert.equal(reconcileNativeConfig(wrapped, { ...f, surface: "cli" }).config, wrapped);
  const unwrapped = reconcileNativeConfig(wrapped, { ...f, surface: "desktop" }).config;
  assert.equal(readSetting(unwrapped, ["mcp_servers", "node_repl"], "command"), repl);
  assert.equal(readSetting(unwrapped, ["mcp_servers", "node_repl", "env"], "CCODEX_NODE_REPL_NATIVE_PATH"), undefined);
  assert.equal(readSetting(unwrapped, ["mcp_servers", "node_repl", "env"], "SKY_CUA_NATIVE_PIPE_DIRECTORY"), "owned-pipe");
  assert.ok(unwrapped.includes('env_vars = ["CODEX_WINDOWS_REGISTERED_CORE"]'));
});

test("a custom user MCP command is never replaced by automatic runtime discovery", t => {
  const f = fixture(t);
  f.runtime("runtime", "0.0.16/current");
  const input = '[mcp_servers.node_repl]\ncommand = "my-custom-mcp"\nargs = ["--custom"]\n';
  assert.equal(reconcileNativeConfig(input, { ...f, surface: "cli" }).config, input);
});

test("first Desktop launch fixes a stale managed market source before Desktop creates its staging directory", t => {
  const f = fixture(t);
  const resources = path.join(f.root, "resources");
  f.write(path.join(resources, "plugins", "openai-bundled", ".agents", "plugins", "marketplace.json"), '{"name":"openai-bundled"}');
  const input = "[marketplaces.openai-bundled]\nsource_type = 'local'\nsource = '/old/resources/plugins/openai-bundled'\n";
  const result = reconcileNativeConfig(input, { ...f, surface: "desktop", resources });
  assert.equal(readSetting(result.config, ["marketplaces", "openai-bundled"], "source"),
    bundledMarketplaceSource(path.join(f.home, ".tmp", "bundled-marketplaces", "openai-bundled")));
});

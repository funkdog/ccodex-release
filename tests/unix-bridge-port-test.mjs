import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";

const root = path.resolve(import.meta.dirname, "..");
const helper = path.join(root, "platforms", "unix", "bin", "bridge-port.sh");
const bash = process.platform === "win32"
  ? path.join(process.env.ProgramFiles || "C:\\Program Files", "Git", "bin", "bash.exe")
  : "bash";
const posixPath = (value) => process.platform === "win32"
  ? value.replace(/^([a-z]):/i, (_, drive) => `/${drive.toLowerCase()}`)
    .replaceAll("\\", "/")
  : value;
const quoted = (value) => `'${value.replaceAll("'", "'\\''")}'`;

function withProfile(run) {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), "ccodex-port-test-"));
  try {
    return run(directory);
  } finally {
    const resolved = fs.realpathSync(directory);
    assert.equal(path.dirname(resolved), fs.realpathSync(os.tmpdir()));
    assert.match(path.basename(resolved), /^ccodex-port-test-/);
    fs.rmSync(resolved, { recursive: true, force: true });
  }
}

function resolve(profile, override) {
  const env = { ...process.env };
  delete env.CODEX_COPILOT_BRIDGE_PORT;
  if (override !== undefined) env.CODEX_COPILOT_BRIDGE_PORT = override;
  return spawnSync(bash, ["-c",
    `set -e; source ${quoted(posixPath(helper))}; cc_resolve_bridge_port ${quoted(posixPath(profile))}; printf '%s' "$CODEX_COPILOT_BRIDGE_PORT"`,
  ], { env, encoding: "utf8", timeout: 20000 });
}

test("Unix bridge port defaults, verified file, CRLF, and explicit env precedence", {
  skip: process.platform === "win32" && !fs.existsSync(bash),
}, () => withProfile((profile) => {
  const portFile = path.join(profile, "bridge-port.txt");
  let result = resolve(profile);
  assert.equal(result.status, 0, result.error?.message || result.stderr);
  assert.equal(result.stdout, "22690");

  fs.writeFileSync(portFile, "34567\n");
  result = resolve(profile);
  assert.equal(result.status, 0, result.error?.message || result.stderr);
  assert.equal(result.stdout, "34567");

  fs.writeFileSync(portFile, "034567\r\n");
  result = resolve(profile);
  assert.equal(result.status, 0, result.error?.message || result.stderr);
  assert.equal(result.stdout, "34567");

  fs.writeFileSync(portFile, "bad file\n");
  result = resolve(profile, "45678");
  assert.equal(result.status, 0, result.error?.message || result.stderr);
  assert.equal(result.stdout, "45678");
}));

test("Unix bridge port rejects unsafe values and does not silently fall back", {
  skip: process.platform === "win32" && !fs.existsSync(bash),
}, () => withProfile((profile) => {
  const portFile = path.join(profile, "bridge-port.txt");
  for (const value of [
    "", "0", "1023", "65536", "2e4", " 22690", "+22690",
    "22690\n1", "22690\n\n", "22690\r", "２２６９０",
  ]) {
    fs.writeFileSync(portFile, value);
    const result = resolve(profile);
    assert.notEqual(result.status, 0, `Invalid port was accepted: ${JSON.stringify(value)}`);
    assert.match(result.stderr, /Invalid .*bridge port|Invalid bridge port file/);
  }
  fs.writeFileSync(portFile, Buffer.from([50, 50, 54, 57, 48, 0]));
  assert.notEqual(resolve(profile).status, 0, "NUL byte in the port file was accepted");
  fs.writeFileSync(portFile, "22690\n");
  for (const value of ["", "abc", "22.690", "65536"]) {
    const result = resolve(profile, value);
    assert.notEqual(result.status, 0, `Invalid environment override was accepted: ${value}`);
  }
}));

test("Unix bridge port file cannot be a symlink", {
  skip: process.platform === "win32",
}, () => withProfile((profile) => {
  const target = path.join(profile, "real-port.txt");
  fs.writeFileSync(target, "34567\n");
  fs.symlinkSync(target, path.join(profile, "bridge-port.txt"));
  const result = resolve(profile);
  assert.notEqual(result.status, 0);
  assert.match(result.stderr, /expected a regular file/);
}));

test("Linux Desktop launcher passes the selected port to only the stock app", {
  skip: process.platform === "win32" && !fs.existsSync(bash),
}, () => withProfile((profile) => {
  const appDir = path.join(profile, "app");
  fs.mkdirSync(appDir);
  const app = path.join(appDir, "chatgpt");
  fs.writeFileSync(app, '#!/usr/bin/env bash\nprintf "%s|%s|%s" "$CODEX_COPILOT_BRIDGE_PORT" "${CODEX_HOME:-unset}" "${CODEX_COPILOT_HOME:-unset}"\n',
    { mode: 0o755 });
  fs.writeFileSync(path.join(profile, "bridge-port.txt"), "45555\n");
  const launcher = path.join(root, "platforms", "linux", "bin", "codex-copilot-desktop");
  const env = { ...process.env, CODEX_COPILOT_HOME: posixPath(profile),
    CODEX_COPILOT_DESKTOP_APP: posixPath(app), CODEX_HOME: "native-profile" };
  delete env.CODEX_COPILOT_BRIDGE_PORT;
  const result = spawnSync(bash, [posixPath(launcher)], {
    env, encoding: "utf8", timeout: 20000,
  });
  assert.equal(result.status, 0, result.error?.message || result.stderr);
  assert.equal(result.stdout, "45555|native-profile|unset");
  assert.match(result.stderr, /Computer Use is not yet supported on Linux/);
}));

test("Unix CLI and both Desktop launchers resolve the port before bridge/app startup", () => {
  const launcher = fs.readFileSync(path.join(root, "platforms", "unix", "bin", "codex-copilot"), "utf8");
  const macos = fs.readFileSync(path.join(root, "platforms", "macos", "bin", "codex-copilot-desktop"), "utf8");
  const linux = fs.readFileSync(path.join(root, "platforms", "linux", "bin", "codex-copilot-desktop"), "utf8");
  const installer = fs.readFileSync(path.join(root, "platforms", "unix", "install.sh"), "utf8");
  const packager = fs.readFileSync(path.join(root, "tools", "package-unix.mjs"), "utf8");
  for (const [name, source, next] of [
    ["CLI", launcher, '"$ROOT/install.sh" --configure-only'],
    ["macOS Desktop", macos, '"$NODE" "$ROOT/bridge/ensure.mjs"'],
    ["Linux Desktop", linux, 'exec "$APP" "$@"'],
    ["installer", installer, 'verify_copilot_entitlement ||'],
  ]) {
    const resolved = source.indexOf("cc_resolve_bridge_port");
    assert.ok(resolved >= 0 && resolved < source.lastIndexOf(next),
      `${name} did not resolve the bridge port before startup`);
  }
  assert.match(macos, /while \[\[ -L "\$SCRIPT_PATH" \]\]/);
  assert.match(linux, /while \[\[ -L "\$SCRIPT_PATH" \]\]/);
  assert.match(packager, /"bridge-port\.sh"/);
  assert.match(installer, /"bin\/bridge-port\.sh"/);
});

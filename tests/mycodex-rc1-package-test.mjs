import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { execFileSync, spawn } from "node:child_process";
import { once } from "node:events";
import { setTimeout as delay } from "node:timers/promises";
import { pathToFileURL } from "node:url";
import test from "node:test";
import { candidateName, candidateVersion, receiptName, sourceBinding, verifyPayload } from "../tools/package-adapters.mjs";
import { sha256 } from "../tools/typescript-state.mjs";

const archive = process.env.MYCODEX_RC1_ARCHIVE;
const read = file => JSON.parse(fs.readFileSync(file, "utf8"));
const load = (root, relative) => import(pathToFileURL(path.join(root, relative)).href);
const tarEnv = { ...process.env, COPYFILE_DISABLE: "1" };
const terminal = `
import errno, os, pty, select, signal, sys

pid, master = pty.fork()
if pid == 0:
    os.execv(sys.argv[1], sys.argv[1:])

def cancel(signum, frame):
    try:
        os.kill(pid, signal.SIGKILL)
    except ProcessLookupError:
        pass

signal.signal(signal.SIGTERM, cancel)
inputs = [master, 0]
while master in inputs:
    for fd in select.select(inputs, [], [])[0]:
        try:
            data = os.read(fd, 65536)
        except OSError as error:
            if fd != master or error.errno != errno.EIO:
                raise
            data = b""
        if data:
            os.write(1 if fd == master else master, data)
        else:
            inputs.remove(fd)
sys.exit(os.waitstatus_to_exitcode(os.waitpid(pid, 0)[1]))
`;

test("candidate source binding includes the gateway, launcher and SDK lock without release history or private state", () => {
  const binding = sourceBinding();
  assert.match(binding.payloadSourceDigest, /^[a-f0-9]{64}$/);
  for (const file of ["gateway/server.mts", "gateway/spine/squad-service.mts", "bridge/desktop-current-host-contract.mjs",
    "tools/configure-adapters.mjs", "release/adapters-sdk/package-lock.json", "docs/CODEX-COPILOT-SETUP.zh-CN.md"]) {
    assert.match(binding.sourceFiles[file] ?? "", /^[a-f0-9]{64}$/, file);
  }
  assert.ok(Object.keys(binding.sourceFiles).every(file =>
    !file.includes("node_modules") && !/^(?:\.mycodex|tests|runtime|dist)\/|^release\/RC.*-SOURCE\.json$/.test(file)));
});

async function defaultInstall(root, env) {
  const child = spawn("/usr/bin/python3", ["-c", terminal, path.join(root, "Install.command")],
    { cwd: root, env, stdio: ["pipe", "pipe", "pipe"] });
  let output = "", diagnostics = "", answered = 0;
  child.stdout.on("data", data => {
    output += data;
    if (!answered && output.includes("官方应用完整路径")) { answered++; child.stdin.write("\n"); }
    if (answered === 1 && output.includes("选择 [1]")) { answered++; child.stdin.write("\n"); }
  });
  child.stderr.on("data", data => { diagnostics += data; });
  const timeout = setTimeout(() => child.kill("SIGTERM"), 15000);
  try { assert.deepEqual(await once(child, "close"), [0, null], output + diagnostics); }
  finally { clearTimeout(timeout); }
  assert.equal(answered, 2, output);
  assert.match(output, /Squad Studio 默认启用/);
}

async function waitForGatewayExit(pid, inspect) {
  for (let idx = 0; idx < 60; idx++) {
    try { if (!inspect(pid)) return; } catch { /* A process may exit between ps and lsof. */ }
    await delay(50);
  }
  assert.fail("Owned gateway did not exit.");
}

function connectNativeShim(shim, { env, cwd, RpcPeer, readMessages, writeMessage }) {
  const child = spawn(shim, ["app-server"], { env, cwd, stdio: ["pipe", "pipe", "pipe"] });
  let diagnostics = "";
  child.stderr.on("data", data => { diagnostics = (diagnostics + data).slice(-3000); });
  const peer = new RpcPeer(message => writeMessage(child.stdin, message));
  const stop = readMessages(child.stdout, message => peer.receive(message), error => peer.close(error));
  child.stdin.on("error", error => peer.close(error));
  child.on("error", error => peer.close(error));
  const exited = new Promise(resolve => child.once("close", (code, signal) => {
    stop(); peer.close(new Error(`Native shim exited (${code ?? signal}): ${diagnostics}`)); resolve(code);
  }));
  return { peer, async dispose() {
    child.stdin.end();
    const terminate = setTimeout(() => child.kill("SIGTERM"), 2000);
    const kill = setTimeout(() => child.kill("SIGKILL"), 7000);
    try { assert.equal(await exited, 0, diagnostics); }
    finally { clearTimeout(terminate); clearTimeout(kill); }
  } };
}

test("extracted RC.1 writes the default configuration and connects native Codex and Squad MCP in an isolated profile",
  { skip: !archive, timeout: 45000 }, async t => {
    const scratch = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), "mycodex-rc1-qa-")));
    let socket, native, config, inspect, sameLifetime;
    t.after(async () => {
      try {
        try { await native?.dispose(); }
        finally {
          socket?.destroy();
          if (config?.identity) {
            if (sameLifetime(config.identity, inspect(config.identity.pid))) process.kill(config.identity.pid, "SIGTERM");
            await waitForGatewayExit(config.identity.pid, inspect);
          }
          if (config && fs.existsSync(path.dirname(config.endpoint))) fs.rmdirSync(path.dirname(config.endpoint));
        }
      } finally { fs.rmSync(scratch, { recursive: true, force: true }); }
    });
    const receipt = read(path.join(path.dirname(archive), receiptName));
    const hash = sha256(fs.readFileSync(archive));
    assert.equal(hash, receipt.archive.sha256);
    assert.equal(fs.statSync(archive).size, receipt.archive.bytes);
    assert.equal(fs.readFileSync(`${archive}.sha256`, "utf8"), `${hash}  ${path.basename(archive)}\n`);
    const ownership = execFileSync("/usr/bin/tar", ["-tvzf", archive], { env: tarEnv, encoding: "utf8" }).trim().split("\n");
    assert.ok(ownership.every(line => /^[-d]\S+\s+\d+\s+root\s+wheel\s/.test(line)), "Archive owners must be generic.");
    execFileSync("/usr/bin/tar", ["-xzf", archive, "-C", scratch], { env: tarEnv });
    assert.deepEqual(fs.readdirSync(scratch), [candidateName]);
    const root = path.join(scratch, candidateName);
    const manifest = verifyPayload(root);
    assert.equal(fs.readFileSync(path.join(root, "VERSION"), "utf8").trim(), candidateVersion);
    assert.equal(manifest.sourceRevision, receipt.sourceRevision);
    assert.equal(manifest.sourceRevision, execFileSync("git", ["rev-parse", "HEAD"], { encoding: "utf8" }).trim());
    assert.equal(manifest.payloadSourceDigest, receipt.payloadSourceDigest);
    assert.equal(manifest.payloadDigest, receipt.payloadDigest);
    assert.equal(Object.keys(manifest.files).length, receipt.archive.payloadFiles);
    assert.equal(sha256(fs.readFileSync(path.join(root, "MYCODEX-MANIFEST.json"))), receipt.manifestSha256);
    assert.equal(sha256(fs.readFileSync(new URL(`../${receipt.sourceRecord}`, import.meta.url))), receipt.sourceRecordSha256);
    assert.match(fs.readFileSync(path.join(root, "CODEX-COPILOT-SETUP.zh-CN.md"), "utf8"), /spine: \{ mcp: true, eventTap: true \}/);

    const home = path.join(scratch, "home");
    fs.mkdirSync(home, { mode: 0o700 });
    const env = { HOME: home, TMPDIR: os.tmpdir(), PATH: [path.dirname(process.execPath), "/usr/bin", "/bin", "/usr/sbin"].join(":") };
    await defaultInstall(root, env);
    const configFile = path.join(home, ".mycodex", "desktop-candidate", "config.json");
    assert.equal(fs.statSync(configFile).mode & 0o777, 0o600);
    assert.equal(fs.statSync(path.dirname(configFile)).mode & 0o777, 0o700);
    const instance = read(configFile).instances[0];
    assert.equal(instance.host, "current");
    assert.deepEqual(instance.gateway, { spine: { mcp: true, eventTap: true }, defaultEngine: null, engines: [] });
    const diagnose = JSON.parse(execFileSync(path.join(root, "Diagnose.command"), [], { env, cwd: root, encoding: "utf8", timeout: 15000 }));
    assert.equal(diagnose.ready, true);
    assert.equal(diagnose.applicationVersion, "26.1117.41037");
    assert.equal(diagnose.uiCompatible, true);
    assert.deepEqual(diagnose.spine, instance.gateway.spine);
    assert.deepEqual(diagnose.checks, []);

    const prepared = JSON.parse(execFileSync(process.execPath, ["bridge/desktop-launch.mjs", "--config", configFile, "--prepare-only"],
      { env, cwd: root, encoding: "utf8", timeout: 15000 }));
    assert.equal(prepared.launchPerformed, false);
    assert.equal(prepared.phase, "prepared");
    config = read(prepared.connectionFile);
    assert.equal(config.identity, undefined);
    assert.equal(fs.existsSync(config.endpoint), false);
    const { resolveDesktopMode } = await load(root, "bridge/desktop-mode.mjs");
    const { appServerGatewayBackend } = await load(root, "bridge/desktop-backends/app-server-gateway.mjs");
    const { RpcPeer } = await load(root, "gateway/rpc-peer.mjs");
    const { connectGateway, readMessages, writeMessage } = await load(root, "gateway/ipc.mjs");
    ({ readProcessIdentity: inspect, sameProcessLifetime: sameLifetime } = await load(root, "bridge/desktop-process.mjs"));
    const selection = resolveDesktopMode({ arguments: ["--config", configFile], inherited: env });
    const backend = appServerGatewayBackend({ root, selection, home: selection.home, nativeCli: config.nativeCli });
    try { await backend.prepare({ inherited: env, runtime: { manifest: { applicationVersion: diagnose.applicationVersion } } }); }
    finally { config = read(prepared.connectionFile); }

    assert.equal((await backend.check()).connectionFile, prepared.connectionFile);
    assert.equal(config.defaultEngine, null);
    assert.deepEqual(config.spine, instance.gateway.spine);
    const peer = new RpcPeer(message => writeMessage(socket, message));
    socket = await connectGateway(config, message => peer.receive(message));
    socket.on("close", () => peer.close());
    const clientInfo = { name: "mycodex_rc1_fixture", version: "0.2.0" };
    await peer.request("initialize", { clientInfo }, { timeoutMs: 5000 });
    peer.notify({ method: "initialized" });
    assert.deepEqual((await peer.request("model/list", {})).data, []);
    assert.deepEqual((await peer.request("diy/squad/list", {})).squads, []);
    assert.deepEqual((await peer.request("config/read", {})).config.model_provider, null);

    const codexHome = path.join(home, ".codex");
    fs.mkdirSync(codexHome, { mode: 0o700 });
    fs.writeFileSync(path.join(codexHome, "config.toml"), "check_for_update_on_startup = false\n[analytics]\nenabled = false\n");
    native = connectNativeShim(prepared.shim, { env: { ...env, CODEX_HOME: codexHome }, cwd: home, RpcPeer, readMessages, writeMessage });
    await native.peer.request("initialize", { clientInfo, capabilities: { experimentalApi: true } }, { timeoutMs: 8000 });
    native.peer.notify({ method: "initialized" });
    assert.ok((await native.peer.request("model/list", { limit: 30 }, { timeoutMs: 5000 })).data.length > 0,
      "The empty external gateway must preserve the native model catalog.");
    const mcp = (await native.peer.request("mcpServerStatus/list", {}, { timeoutMs: 10000 })).data.find(server => server.name === "mycodex");
    assert.ok(mcp?.tools["mycodex.squad_init"]);
    assert.ok(mcp.tools["mycodex.squad_dispatch"]);
    assert.ok(mcp.tools["mycodex.show_squad_card"]);

    await native.dispose();
    native = undefined;
    assert.equal(await backend.retireIdle(), true);
    await waitForGatewayExit(config.identity.pid, inspect);
    assert.equal(fs.existsSync(config.endpoint), false);
  });

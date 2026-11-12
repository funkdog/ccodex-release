import assert from "node:assert/strict";
import { execFileSync, spawn } from "node:child_process";
import fs from "node:fs";
import http from "node:http";
import net from "node:net";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { syntheticCopilotMetadata } from "./fixtures/copilot-sdk-metadata.mjs";

const root = path.resolve(import.meta.dirname, "..");
const pause = (ms) => new Promise((resolve) => setTimeout(resolve, ms));
const listen = (server) => new Promise((resolve, reject) => {
  server.once("error", reject);
  server.listen(0, "127.0.0.1", () => {
    server.off("error", reject);
    resolve(server.address().port);
  });
});
const freePort = async () => {
  const server = net.createServer();
  const port = await listen(server);
  await new Promise((resolve) => server.close(resolve));
  return port;
};
async function exit(child) {
  if (child.exitCode !== null || child.signalCode !== null) return;
  let timer;
  try {
    await Promise.race([
      new Promise(resolve => child.once("exit", resolve)),
      new Promise((_, reject) => {
        timer = setTimeout(() => reject(new Error(
          `Owned test bridge PID ${child.pid} did not exit after its explicit stop.`,
        )), 30000);
      }),
    ]);
  } finally {
    clearTimeout(timer);
  }
}

async function health(port, pid) {
  const deadline = Date.now() + 12000;
  while (Date.now() < deadline) {
    try {
      const response = await fetch(`http://127.0.0.1:${port}/health`, {
        signal: AbortSignal.timeout(1500),
      });
      if (response.ok) {
        const value = await response.json();
        if (value.pid === pid) return value;
      }
    } catch { /* isolated bridge is starting */ }
    await pause(100);
  }
  throw new Error(`Isolated bridge PID ${pid} did not become healthy.`);
}

function control(port, home, { fromProfile = false } = {}) {
  return new Promise((resolve, reject) => {
    const env = {
      ...process.env,
      CODEX_COPILOT_HOME: home,
      CODEX_COPILOT_BRIDGE_HOST: "127.0.0.1",
      CODEX_COPILOT_BRIDGE_PORT: String(port),
    };
    if (fromProfile) delete env.CODEX_COPILOT_BRIDGE_PORT;
    const child = spawn(process.execPath, [path.join(root, "bridge", "control.mjs"), "stop"], {
      windowsHide: true, stdio: ["ignore", "pipe", "pipe"],
      env,
    });
    let stdout = "";
    let stderr = "";
    child.stdout.on("data", (chunk) => { stdout += chunk; });
    child.stderr.on("data", (chunk) => { stderr += chunk; });
    const timer = setTimeout(() => {
      child.kill();
      reject(new Error("Isolated control command timed out."));
    // A verified legacy stop performs several bounded Windows identity probes.
    // Its test budget must not kill it before those existing checks can finish.
    }, 70000);
    child.once("error", (error) => { clearTimeout(timer); reject(error); });
    child.once("close", (code) => {
      clearTimeout(timer);
      resolve({ code, stdout, stderr });
    });
  });
}

async function stopWhenIdle(port, home, options = {}) {
  let result;
  const deadline = Date.now() + 30000;
  while (Date.now() < deadline) {
    result = await control(port, home, options);
    if (result.code === 0) return result;
    if (!/is busy/.test(result.stderr)) return result;
    await pause(250);
  }
  return result;
}

async function stopVerifiedLegacy(port, home, child, { legacyFile, legacyBytes } = {}) {
  let result;
  for (let attempt = 0; attempt < 16; attempt += 1) {
    result = await control(port, home);
    if (result.code === 0 ||
      !/control endpoint absence could not be verified|bridge health became unavailable|PID\/process identity could not be verified|process identity could not be reverified/
        .test(result.stderr)) return result;
    // The controller failed closed. A fresh observation must establish the
    // same idle bridge and unchanged record before another stop attempt.
    assert.equal(child.exitCode, null);
    assert.equal(child.signalCode, null);
    const status = await health(port, child.pid);
    assert.equal(status.bridge, "codex-copilot");
    assert.equal(status.endpoint, `http://127.0.0.1:${port}`);
    assert.equal(status.activeRequests, 0);
    if (legacyFile) {
      if (legacyBytes === undefined) assert.equal(fs.existsSync(legacyFile), false);
      else assert.equal(fs.readFileSync(legacyFile, "utf8"), legacyBytes);
    }
    console.log(`Legacy control attempt ${attempt + 1} failed closed; the same owned idle bridge and record were reverified.`);
    await pause(500);
  }
  return result;
}

function isolatedCopilotSdk(home) {
  // A packaged runtime correctly takes precedence over SDK injection. Keep this
  // control-plane fixture independent of real SDK authentication and discovery.
  fs.writeFileSync(path.join(home, "copilot-cli-models.json"), JSON.stringify({
    fetched_at: new Date().toISOString(),
    models: [{ id: "gpt-test", default_prompt_tokens: 272000, long_context_prompt_tokens: null }],
  }));
  return syntheticCopilotMetadata(root, home, [{
    id: "gpt-test", billing: { tokenPrices: { maxPromptTokens: 272000 } },
  }]);
}

const model = {
  id: "gpt-test",
  name: "Isolated Test Model",
  vendor: "OpenAI",
  model_picker_enabled: true,
  is_chat_default: true,
  supported_endpoints: ["/responses"],
  capabilities: {
    type: "chat",
    supports: { reasoning_effort: ["low"] },
    limits: { max_prompt_tokens: 272000, max_context_window_tokens: 400000, max_output_tokens: 128000 },
  },
};

test("control rejects forged browser requests; busy inference is preserved, then idle bridge drains", async (t) => {
  const home = fs.mkdtempSync(path.join(os.tmpdir(), "ccodex-control-"));
  const sdk = isolatedCopilotSdk(home);
  let releaseResponse;
  const holdResponse = new Promise((resolve) => { releaseResponse = resolve; });
  let inferenceReached;
  let reachedCount = 0;
  const reached = new Promise((resolve) => { inferenceReached = resolve; });
  const upstream = http.createServer(async (req, res) => {
    if (req.url === "/models") {
      res.writeHead(200, { "content-type": "application/json" });
      res.end(JSON.stringify({ data: [model] }));
    } else if (req.url === "/user") {
      res.writeHead(200, { "content-type": "application/json" });
      res.end(JSON.stringify({ login: "isolated-user" }));
    } else if (req.url === "/responses") {
      for await (const _chunk of req) { /* consume the inference body */ }
      reachedCount += 1;
      if (reachedCount === 5) inferenceReached();
      await holdResponse;
      res.writeHead(200, { "content-type": "application/json" });
      res.end(JSON.stringify({ id: "response-isolated", output: [], usage: {} }));
    } else {
      res.writeHead(404).end();
    }
  });
  const upstreamPort = await listen(upstream);
  const port = await freePort();
  const env = {
    ...process.env,
    CODEX_COPILOT_HOME: home,
    CODEX_COPILOT_AUTH_MODE: "environment",
    CODEX_COPILOT_GITHUB_TOKEN: "isolated-placeholder-not-a-github-credential",
    CODEX_COPILOT_CLI_SDK: sdk.sdkPath,
    GH_TOKEN: "",
    GITHUB_TOKEN: "",
    CODEX_COPILOT_MODEL_SAMPLES: "1",
    CODEX_COPILOT_BRIDGE_PORT: String(port),
    CODEX_COPILOT_API_BASE: `http://127.0.0.1:${upstreamPort}`,
    CODEX_COPILOT_GITHUB_API_BASE: `http://127.0.0.1:${upstreamPort}`,
  };
  const startBridge = () => spawn(process.execPath, [...sdk.nodeArguments, path.join(root, "bridge", "server.mjs")], {
    cwd: root, windowsHide: true, stdio: "ignore", env,
  });
  const bridge = startBridge();
  let restarted = null;
  t.diagnostic(`Isolated bridge-control test PID ${bridge.pid}`);
  let stage = "startup";
  try {
    const endpoint = `http://127.0.0.1:${port}`;
    const state = await health(port, bridge.pid);
    assert.equal(state.runtime.controlProtocol, 1);
    assert.equal(state.activeRequests, 0);
    const tokenFile = path.join(home, `bridge-control-${port}.json`);
    const runtimeFile = path.join(home, `bridge-${port}.json`);
    const record = JSON.parse(fs.readFileSync(tokenFile, "utf8"));
    assert.equal(record.pid, bridge.pid);
    assert.equal(record.instanceId, state.runtime.instanceId);
    assert.match(record.token, /^[A-Za-z0-9_-]{43}$/);
    assert.equal(fs.existsSync(path.join(home, "github-auth.json")), false);
    if (process.platform === "win32") {
      const acl = execFileSync("icacls.exe", [tokenFile], { encoding: "utf8" });
      assert.doesNotMatch(acl, /\(I\)/, "control file must not inherit broad ACLs");
    } else {
      assert.equal(fs.statSync(tokenFile).mode & 0o777, 0o600);
    }
    assert.equal(JSON.stringify(state).includes(record.token), false);
    assert.equal(fs.readFileSync(runtimeFile, "utf8").includes(record.token), false);
    assert.equal(fs.existsSync(path.join(home, "bridge.json")), false);

    stage = "unauthorized control requests";
    const stop = (headers = {}, method = "POST") =>
      fetch(`${endpoint}/_control/stop`, {
        method, headers, signal: AbortSignal.timeout(3000),
      });
    assert.equal((await stop()).status, 403);
    assert.equal((await stop({ "x-codex-copilot-control": "wrong" })).status, 403);
    assert.equal((await stop({
      "x-codex-copilot-control": record.token, origin: "https://attacker.example",
    })).status, 403);
    assert.equal((await stop({
      "x-codex-copilot-control": record.token, "sec-fetch-site": "same-origin",
    })).status, 403);
    assert.equal((await stop({
      "x-codex-copilot-control": record.token, host: `attacker.example:${port}`,
    })).status, 403);
    assert.equal((await stop({ "x-codex-copilot-control": record.token }, "OPTIONS")).status, 403);
    assert.equal((await health(port, bridge.pid)).runtime.instanceId, record.instanceId);
    const withheld = `${tokenFile}.withheld`;
    fs.renameSync(tokenFile, withheld);
    try {
      const missing = await control(port, home);
      assert.equal(missing.code, 1);
      assert.match(missing.stderr, /credential is unavailable/);
      assert.equal((await health(port, bridge.pid)).pid, bridge.pid);
    } finally {
      fs.renameSync(withheld, tokenFile);
    }

    stage = "in-flight inference";
    const inferences = Array.from({ length: 5 }, (_, index) =>
      fetch(`${endpoint}/responses`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ model: "gpt-test", stream: false, input: `isolated request ${index}` }),
        signal: AbortSignal.timeout(20000),
      }).then((response) => ({ response }), (error) => ({ error })));
    await reached;
    assert.equal((await health(port, bridge.pid)).activeRequests, 5);
    stage = "busy control";
    const busy = await control(port, home);
    stage = "busy control result";
    assert.equal(busy.code, 1, busy.stderr);
    assert.match(busy.stderr, /busy|active requests/i);
    stage = "busy bridge still healthy";
    assert.equal((await health(port, bridge.pid)).activeRequests, 5);
    releaseResponse();
    stage = "inference completion";
    for (const completed of await Promise.all(inferences)) {
      if (completed.error) throw completed.error;
      assert.equal(completed.response.status, 200, "every in-flight inference must complete");
    }
    assert.equal((await health(port, bridge.pid)).activeRequests, 0);

    stage = "idle control";
    const stopped = await stopWhenIdle(port, home);
    assert.equal(stopped.code, 0, stopped.stderr);
    assert.match(stopped.stdout, /stopped pid/);
    await exit(bridge);
    assert.equal(fs.existsSync(tokenFile), false, "control token removed after graceful exit");
    assert.equal(fs.existsSync(runtimeFile), false);
    assert.equal(fs.existsSync(path.join(home, "bridge.json")), false);
    assert.equal(fs.readFileSync(path.join(home, "bridge.log"), "utf8").includes(record.token), false);

    stage = "token rotation after restart";
    // Simulate a crash leaving a stale token file; startup must replace it.
    fs.writeFileSync(tokenFile, JSON.stringify(record));
    restarted = startBridge();
    t.diagnostic(`Isolated restarted bridge PID ${restarted.pid}`);
    await health(port, restarted.pid);
    const rotated = JSON.parse(fs.readFileSync(tokenFile, "utf8"));
    assert.notEqual(rotated.token, record.token);
    assert.notEqual(rotated.instanceId, record.instanceId);
    if (process.platform === "win32") {
      assert.doesNotMatch(execFileSync("icacls.exe", [tokenFile], { encoding: "utf8" }), /\(I\)/);
    }
    assert.equal((await stop({ "x-codex-copilot-control": record.token })).status, 403);
    assert.equal((await health(port, restarted.pid)).runtime.instanceId, rotated.instanceId);
    const stoppedAgain = await stopWhenIdle(port, home);
    assert.equal(stoppedAgain.code, 0, stoppedAgain.stderr);
    await exit(restarted);
    assert.equal(fs.existsSync(tokenFile), false);
    assert.equal(fs.existsSync(runtimeFile), false);
    assert.equal(fs.readFileSync(path.join(home, "bridge.log"), "utf8").includes(rotated.token), false);
  } catch (error) {
    t.diagnostic(`New bridge-control test failed at ${stage}`);
    t.diagnostic(`Isolated bridge exit code ${bridge.exitCode ?? "running"}`);
    const log = path.join(home, "bridge.log");
    if (fs.existsSync(log)) {
      t.diagnostic(fs.readFileSync(log, "utf8").split("\n").slice(-8).join("\n"));
    }
    throw error;
  } finally {
    releaseResponse();
    if (restarted) {
      if (restarted.exitCode === null && restarted.signalCode === null) restarted.kill();
      await exit(restarted);
    }
    if (bridge.exitCode === null && bridge.signalCode === null) bridge.kill();
    await exit(bridge);
    await new Promise((resolve) => upstream.close(resolve));
    assert.equal(path.dirname(fs.realpathSync(home)), fs.realpathSync(os.tmpdir()));
    fs.rmSync(home, { recursive: true, force: true });
  }
});

test("background catalog refresh blocks shutdown even with zero HTTP requests", async (t) => {
  const home = fs.mkdtempSync(path.join(os.tmpdir(), "ccodex-catalog-drain-"));
  const sdk = isolatedCopilotSdk(home);
  let hold = false;
  let releaseRefresh;
  const blocked = new Promise((resolve) => { releaseRefresh = resolve; });
  let refreshEntered;
  const entered = new Promise((resolve) => { refreshEntered = resolve; });
  const upstream = http.createServer(async (req, res) => {
    if (req.url === "/models") {
      if (hold) {
        refreshEntered();
        await blocked;
      }
      res.writeHead(200, { "content-type": "application/json" });
      res.end(JSON.stringify({ data: [model] }));
    } else if (req.url === "/user") {
      res.writeHead(200, { "content-type": "application/json" });
      res.end(JSON.stringify({ login: "isolated-user" }));
    } else {
      res.writeHead(404).end();
    }
  });
  const upstreamPort = await listen(upstream);
  const port = await freePort();
  const bridge = spawn(process.execPath, [...sdk.nodeArguments, path.join(root, "bridge", "server.mjs")], {
    cwd: root, windowsHide: true, stdio: "ignore",
    env: {
      ...process.env,
      CODEX_COPILOT_HOME: home,
      CODEX_COPILOT_AUTH_MODE: "environment",
      CODEX_COPILOT_GITHUB_TOKEN: "isolated-placeholder-not-a-github-credential",
      CODEX_COPILOT_CLI_SDK: sdk.sdkPath,
      GH_TOKEN: "",
      GITHUB_TOKEN: "",
      CODEX_COPILOT_MODEL_SAMPLES: "1",
      CODEX_COPILOT_CATALOG_SYNC_MS: "750",
      CODEX_COPILOT_BRIDGE_PORT: String(port),
      CODEX_COPILOT_API_BASE: `http://127.0.0.1:${upstreamPort}`,
      CODEX_COPILOT_GITHUB_API_BASE: `http://127.0.0.1:${upstreamPort}`,
    },
  });
  t.diagnostic(`Isolated catalog-drain test PID ${bridge.pid}`);
  try {
    await health(port, bridge.pid);
    for (let attempt = 0; attempt < 200 && !fs.existsSync(path.join(home, "models.json")); attempt += 1) {
      await pause(50);
    }
    assert.equal(fs.existsSync(path.join(home, "models.json")), true);
    hold = true;
    await Promise.race([
      entered,
      pause(5000).then(() => { throw new Error("Isolated catalog refresh never started."); }),
    ]);
    assert.equal((await health(port, bridge.pid)).activeRequests, 0);
    const busy = await control(port, home);
    assert.equal(busy.code, 1, busy.stderr);
    assert.match(busy.stderr, /0 active requests, [1-9]\d* background jobs/);
    assert.equal((await health(port, bridge.pid)).pid, bridge.pid);
  } finally {
    releaseRefresh();
    if (bridge.exitCode === null && bridge.signalCode === null) bridge.kill();
    await exit(bridge);
    await new Promise((resolve) => upstream.close(resolve));
    assert.equal(path.dirname(fs.realpathSync(home)), fs.realpathSync(os.tmpdir()));
    fs.rmSync(home, { recursive: true, force: true });
  }
});

test("parallel bridge ports keep independent runtime and token files without touching legacy bridge.json", async (t) => {
  const home = fs.mkdtempSync(path.join(os.tmpdir(), "ccodex-parallel-ports-"));
  const sdk = isolatedCopilotSdk(home);
  const legacyFile = path.join(home, "bridge.json");
  const legacyBytes = JSON.stringify({
    pid: 1234, host: "127.0.0.1", port: 22690,
    started_at: "2000-01-01T00:00:00.000Z",
    runtime: { sourceGeneration: "legacy-sentinel" },
  });
  fs.writeFileSync(legacyFile, legacyBytes);
  const upstream = http.createServer((req, res) => {
    res.writeHead(200, { "content-type": "application/json" });
    if (req.url === "/models") res.end(JSON.stringify({ data: [model] }));
    else if (req.url === "/user") res.end(JSON.stringify({ login: "isolated-user" }));
    else res.end("{}");
  });
  const upstreamPort = await listen(upstream);
  const portA = await freePort();
  const portB = await freePort();
  assert.notEqual(portA, portB);
  const env = {
    ...process.env,
    CODEX_COPILOT_HOME: home,
    CODEX_COPILOT_AUTH_MODE: "environment",
    CODEX_COPILOT_GITHUB_TOKEN: "isolated-placeholder-not-a-github-credential",
    CODEX_COPILOT_CLI_SDK: sdk.sdkPath,
    GH_TOKEN: "",
    GITHUB_TOKEN: "",
    CODEX_COPILOT_MODEL_SAMPLES: "1",
    CODEX_COPILOT_API_BASE: `http://127.0.0.1:${upstreamPort}`,
    CODEX_COPILOT_GITHUB_API_BASE: `http://127.0.0.1:${upstreamPort}`,
  };
  const spawnPort = (port) => spawn(process.execPath, [...sdk.nodeArguments, path.join(root, "bridge", "server.mjs")], {
    cwd: root, windowsHide: true, stdio: "ignore",
    env: { ...env, CODEX_COPILOT_BRIDGE_PORT: String(port) },
  });
  const bridgeA = spawnPort(portA);
  const bridgeB = spawnPort(portB);
  t.diagnostic(`Isolated parallel bridge PIDs ${bridgeA.pid}, ${bridgeB.pid}`);
  try {
    const [healthA, healthB] = await Promise.all([
      health(portA, bridgeA.pid), health(portB, bridgeB.pid),
    ]);
    const runtimeA = path.join(home, `bridge-${portA}.json`);
    const runtimeB = path.join(home, `bridge-${portB}.json`);
    const controlA = path.join(home, `bridge-control-${portA}.json`);
    const controlB = path.join(home, `bridge-control-${portB}.json`);
    const recordA = JSON.parse(fs.readFileSync(runtimeA, "utf8"));
    const recordB = JSON.parse(fs.readFileSync(runtimeB, "utf8"));
    const tokenA = JSON.parse(fs.readFileSync(controlA, "utf8"));
    const tokenB = JSON.parse(fs.readFileSync(controlB, "utf8"));
    assert.equal(recordA.pid, bridgeA.pid);
    assert.equal(recordA.port, portA);
    assert.equal(recordB.pid, bridgeB.pid);
    assert.equal(recordB.port, portB);
    assert.equal(recordA.runtime.instanceId, healthA.runtime.instanceId);
    assert.equal(recordB.runtime.instanceId, healthB.runtime.instanceId);
    assert.notEqual(tokenA.token, tokenB.token);
    assert.notEqual(tokenA.instanceId, tokenB.instanceId);
    const keepRuntimeB = fs.readFileSync(runtimeB, "utf8");
    const keepTokenB = fs.readFileSync(controlB, "utf8");
    assert.equal(fs.readFileSync(legacyFile, "utf8"), legacyBytes);

    const stoppedA = await stopWhenIdle(portA, home);
    assert.equal(stoppedA.code, 0, stoppedA.stderr);
    await exit(bridgeA);
    assert.equal(fs.existsSync(runtimeA), false);
    assert.equal(fs.existsSync(controlA), false);
    assert.equal(fs.readFileSync(runtimeB, "utf8"), keepRuntimeB);
    assert.equal(fs.readFileSync(controlB, "utf8"), keepTokenB);
    assert.equal((await health(portB, bridgeB.pid)).runtime.instanceId, tokenB.instanceId);
    assert.equal(fs.readFileSync(legacyFile, "utf8"), legacyBytes);

    const stoppedB = await stopWhenIdle(portB, home);
    assert.equal(stoppedB.code, 0, stoppedB.stderr);
    await exit(bridgeB);
    assert.equal(fs.existsSync(runtimeB), false);
    assert.equal(fs.existsSync(controlB), false);
    assert.equal(fs.readFileSync(legacyFile, "utf8"), legacyBytes);
  } finally {
    for (const child of [bridgeA, bridgeB]) {
      if (child.exitCode === null && child.signalCode === null) child.kill();
      await exit(child);
    }
    await new Promise((resolve) => upstream.close(resolve));
    assert.equal(path.dirname(fs.realpathSync(home)), fs.realpathSync(os.tmpdir()));
    fs.rmSync(home, { recursive: true, force: true });
  }
});

test("server and control follow a profile port switch while explicit overrides still win", async (t) => {
  const home = fs.mkdtempSync(path.join(os.tmpdir(), "ccodex-port-pointer-"));
  const sdk = isolatedCopilotSdk(home);
  const upstream = http.createServer((req, res) => {
    res.writeHead(200, { "content-type": "application/json" });
    if (req.url === "/models") res.end(JSON.stringify({ data: [model] }));
    else if (req.url === "/user") res.end(JSON.stringify({ login: "isolated-user" }));
    else res.end("{}");
  });
  const upstreamPort = await listen(upstream);
  const portA = await freePort();
  let portB = await freePort();
  while (portB === portA) portB = await freePort();
  let portC = await freePort();
  while (portC === portA || portC === portB) portC = await freePort();
  const pointer = path.join(home, "bridge-port.txt");
  fs.writeFileSync(pointer, `${portA}\n`);
  const baseEnv = {
    ...process.env,
    CODEX_COPILOT_HOME: home,
    CODEX_COPILOT_AUTH_MODE: "environment",
    CODEX_COPILOT_GITHUB_TOKEN: "isolated-placeholder-not-a-github-credential",
    CODEX_COPILOT_CLI_SDK: sdk.sdkPath,
    GH_TOKEN: "",
    GITHUB_TOKEN: "",
    CODEX_COPILOT_MODEL_SAMPLES: "1",
    CODEX_COPILOT_API_BASE: `http://127.0.0.1:${upstreamPort}`,
    CODEX_COPILOT_GITHUB_API_BASE: `http://127.0.0.1:${upstreamPort}`,
  };
  delete baseEnv.CODEX_COPILOT_BRIDGE_PORT;
  const spawnChosen = (override) => spawn(process.execPath, [...sdk.nodeArguments, path.join(root, "bridge", "server.mjs")], {
    cwd: root, windowsHide: true, stdio: "ignore",
    env: override == null ? baseEnv : { ...baseEnv, CODEX_COPILOT_BRIDGE_PORT: String(override) },
  });
  const children = [];
  try {
    const first = spawnChosen();
    children.push(first);
    t.diagnostic(`Isolated pointer-selected bridge PID ${first.pid}`);
    await health(portA, first.pid);
    fs.writeFileSync(pointer, `${portB}\n`);
    const second = spawnChosen();
    children.push(second);
    t.diagnostic(`Isolated new pointer-selected bridge PID ${second.pid}`);
    await health(portB, second.pid);
    const runtimeA = path.join(home, `bridge-${portA}.json`);
    const runtimeB = path.join(home, `bridge-${portB}.json`);
    assert.equal(JSON.parse(fs.readFileSync(runtimeA, "utf8")).pid, first.pid);
    assert.equal(JSON.parse(fs.readFileSync(runtimeB, "utf8")).pid, second.pid);

    const stopSelected = await stopWhenIdle(portB, home, { fromProfile: true });
    assert.equal(stopSelected.code, 0, stopSelected.stderr);
    await exit(second);
    assert.equal(fs.existsSync(runtimeB), false);
    assert.equal((await health(portA, first.pid)).pid, first.pid);
    const stopExplicit = await stopWhenIdle(portA, home);
    assert.equal(stopExplicit.code, 0, stopExplicit.stderr);
    await exit(first);
    assert.equal(fs.existsSync(runtimeA), false);

    fs.writeFileSync(pointer, "invalid\n");
    const override = spawnChosen(portC);
    children.push(override);
    t.diagnostic(`Isolated explicit-override bridge PID ${override.pid}`);
    await health(portC, override.pid);
    assert.equal(JSON.parse(fs.readFileSync(path.join(home, `bridge-${portC}.json`), "utf8")).pid, override.pid);
    const stopOverride = await stopWhenIdle(portC, home);
    assert.equal(stopOverride.code, 0, stopOverride.stderr);
    await exit(override);
    assert.equal(fs.existsSync(path.join(home, `bridge-${portC}.json`)), false);
  } finally {
    for (const child of children) {
      if (child.exitCode === null && child.signalCode === null) child.kill();
      await exit(child);
    }
    await new Promise((resolve) => upstream.close(resolve));
    assert.equal(path.dirname(fs.realpathSync(home)), fs.realpathSync(os.tmpdir()));
    fs.rmSync(home, { recursive: true, force: true });
  }
});

const legacySource = `
import http from "node:http";
let active = 0;
let stopProbed = false;
const pending = [];
const port = Number(process.env.CODEX_COPILOT_BRIDGE_PORT);
const server = http.createServer((req, res) => {
  active++;
  let done = false;
  const settle = () => { if (!done) { done = true; active--; } };
  res.once("finish", settle);
  res.once("close", settle);
  if (req.method === "GET" && req.url === "/health") {
    const drifted = process.env.TEST_DRIFT === "1" && stopProbed;
    if (drifted) stopProbed = false;
    res.writeHead(200, { "content-type": "application/json" });
    res.end(JSON.stringify({
      status: "ok", bridge: "codex-copilot", pid: process.pid,
      endpoint: \`http://127.0.0.1:\${port}\`, activeRequests: active - 1,
      runtime: process.env.TEST_NO_GENERATION === "1" ? {} : { sourceGeneration:
        drifted ? "changed" : "legacy" },
    }));
  } else if (req.method === "GET" && req.url === "/responses") {
    pending.push(res);
  } else if (req.method === "POST" && req.url === "/release") {
    for (const held of pending.splice(0)) held.end("completed");
    res.end("released");
  } else {
    if (req.method === "POST" && req.url === "/_control/stop") stopProbed = true;
    res.writeHead(404).end("not found");
  }
});
server.listen(port, "127.0.0.1");
process.on("SIGTERM", () => process.exit(0));
`;

async function withLegacyBridge(t, { drift = false, runtimeRecord = true, noGeneration = false } = {}, run) {
  const home = fs.mkdtempSync(path.join(os.tmpdir(), "ccodex-legacy-control-"));
  const directory = path.join(home, "bridge");
  fs.mkdirSync(directory);
  const entry = path.join(directory, "server.mjs");
  fs.writeFileSync(entry, legacySource);
  const port = await freePort();
  const child = spawn(process.execPath, [entry], {
    windowsHide: true, stdio: "ignore",
    env: {
      ...process.env,
      CODEX_COPILOT_BRIDGE_PORT: String(port),
      TEST_DRIFT: drift ? "1" : "0",
      TEST_NO_GENERATION: noGeneration ? "1" : "0",
    },
  });
  t.diagnostic(`Isolated legacy fallback test PID ${child.pid}`);
  try {
    await health(port, child.pid);
    const legacyFile = path.join(home, "bridge.json");
    const legacyBytes = JSON.stringify({
      pid: child.pid, host: "127.0.0.1", port,
      started_at: new Date().toISOString(),
      runtime: { sourceGeneration: "legacy" },
    });
    if (runtimeRecord) fs.writeFileSync(legacyFile, legacyBytes);
    await run({ home, port, child, legacyFile, legacyBytes });
  } finally {
    if (child.exitCode === null && child.signalCode === null) child.kill();
    await exit(child);
    assert.equal(path.dirname(fs.realpathSync(home)), fs.realpathSync(os.tmpdir()));
    fs.rmSync(home, { recursive: true, force: true });
  }
}

test("legacy busy bridge and new port coexist in one profile without overwriting legacy metadata", async (t) => {
  await withLegacyBridge(t, {}, async ({
    home, port: oldPort, child: oldBridge, legacyFile, legacyBytes,
  }) => {
    const sdk = isolatedCopilotSdk(home);
    const upstream = http.createServer((req, res) => {
      res.writeHead(200, { "content-type": "application/json" });
      if (req.url === "/models") res.end(JSON.stringify({ data: [model] }));
      else if (req.url === "/user") res.end(JSON.stringify({ login: "isolated-user" }));
      else res.end("{}");
    });
    const upstreamPort = await listen(upstream);
    let newPort = await freePort();
    while (newPort === oldPort) newPort = await freePort();
    const newBridge = spawn(process.execPath, [...sdk.nodeArguments, path.join(root, "bridge", "server.mjs")], {
      cwd: root, windowsHide: true, stdio: "ignore",
      env: {
        ...process.env,
        CODEX_COPILOT_HOME: home,
        CODEX_COPILOT_AUTH_MODE: "environment",
        CODEX_COPILOT_GITHUB_TOKEN: "isolated-placeholder-not-a-github-credential",
        CODEX_COPILOT_CLI_SDK: sdk.sdkPath,
        GH_TOKEN: "",
        GITHUB_TOKEN: "",
        CODEX_COPILOT_MODEL_SAMPLES: "1",
        CODEX_COPILOT_BRIDGE_PORT: String(newPort),
        CODEX_COPILOT_API_BASE: `http://127.0.0.1:${upstreamPort}`,
        CODEX_COPILOT_GITHUB_API_BASE: `http://127.0.0.1:${upstreamPort}`,
      },
    });
    t.diagnostic(`Isolated old/new parallel PIDs ${oldBridge.pid}, ${newBridge.pid}`);
    let oldPending = null;
    const oldEndpoint = `http://127.0.0.1:${oldPort}`;
    try {
      oldPending = fetch(`${oldEndpoint}/responses`, {
        signal: AbortSignal.timeout(20000),
      }).then((response) => ({ response }), (error) => ({ error }));
      for (let attempt = 0; attempt < 40; attempt += 1) {
        if ((await health(oldPort, oldBridge.pid)).activeRequests === 1) break;
        await pause(50);
      }
      assert.equal((await health(oldPort, oldBridge.pid)).activeRequests, 1);
      await health(newPort, newBridge.pid);
      const runtimeFile = path.join(home, `bridge-${newPort}.json`);
      const tokenFile = path.join(home, `bridge-control-${newPort}.json`);
      assert.equal(JSON.parse(fs.readFileSync(runtimeFile, "utf8")).pid, newBridge.pid);
      assert.equal(JSON.parse(fs.readFileSync(tokenFile, "utf8")).pid, newBridge.pid);
      const newRuntimeBytes = fs.readFileSync(runtimeFile, "utf8");
      const newTokenBytes = fs.readFileSync(tokenFile, "utf8");
      assert.equal(fs.readFileSync(legacyFile, "utf8"), legacyBytes);
      assert.equal((await health(oldPort, oldBridge.pid)).activeRequests, 1);

      assert.equal((await fetch(`${oldEndpoint}/release`, { method: "POST" })).status, 200);
      const completed = await oldPending;
      if (completed.error) throw completed.error;
      assert.equal(completed.response.status, 200);
      const stoppedOld = await stopVerifiedLegacy(oldPort, home, oldBridge, {
        legacyFile, legacyBytes,
      });
      assert.equal(stoppedOld.code, 0, stoppedOld.stderr);
      await exit(oldBridge);
      assert.equal(fs.readFileSync(legacyFile, "utf8"), legacyBytes);
      assert.equal(fs.readFileSync(runtimeFile, "utf8"), newRuntimeBytes);
      assert.equal(fs.readFileSync(tokenFile, "utf8"), newTokenBytes);
      assert.equal((await health(newPort, newBridge.pid)).pid, newBridge.pid);

      const stoppedNew = await stopWhenIdle(newPort, home);
      assert.equal(stoppedNew.code, 0, stoppedNew.stderr);
      await exit(newBridge);
      assert.equal(fs.existsSync(runtimeFile), false);
      assert.equal(fs.existsSync(tokenFile), false);
      assert.equal(fs.readFileSync(legacyFile, "utf8"), legacyBytes);
    } finally {
      if (oldPending && oldBridge.exitCode === null && oldBridge.signalCode === null) {
        await fetch(`${oldEndpoint}/release`, { method: "POST" }).catch(() => {});
        await oldPending;
      }
      if (newBridge.exitCode === null && newBridge.signalCode === null) newBridge.kill();
      await exit(newBridge);
      await new Promise((resolve) => upstream.close(resolve));
    }
  });
});

test("legacy fallback refuses an active request, then stops repeatedly verified idle process", async (t) => {
  await withLegacyBridge(t, {}, async ({ home, port, child, legacyFile, legacyBytes }) => {
    const endpoint = `http://127.0.0.1:${port}`;
    const pending = fetch(`${endpoint}/responses`, { signal: AbortSignal.timeout(15000) });
    for (let tries = 0; tries < 40; tries += 1) {
      if ((await health(port, child.pid)).activeRequests === 1) break;
      await pause(50);
    }
    assert.equal((await health(port, child.pid)).activeRequests, 1);
    const refused = await control(port, home);
    assert.equal(refused.code, 1);
    assert.match(refused.stderr, /became busy|identity changed/);
    assert.equal((await health(port, child.pid)).activeRequests, 1);
    assert.equal((await fetch(`${endpoint}/release`, { method: "POST" })).status, 200);
    assert.equal((await pending).status, 200);
    assert.equal((await health(port, child.pid)).activeRequests, 0);
    fs.writeFileSync(legacyFile, JSON.stringify({ ...JSON.parse(legacyBytes), port: port + 1 }));
    const wrongPort = await control(port, home);
    assert.equal(wrongPort.code, 1);
    assert.match(wrongPort.stderr, /bridge\.json belongs to another port or process/);
    assert.equal((await health(port, child.pid)).pid, child.pid);
    fs.writeFileSync(legacyFile, legacyBytes);
    const stopped = await stopVerifiedLegacy(port, home, child, { legacyFile, legacyBytes });
    assert.equal(stopped.code, 0, stopped.stderr);
    await exit(child);
    assert.equal(fs.readFileSync(legacyFile, "utf8"), legacyBytes, "controller never edits legacy metadata");
  });
});

test("legacy fallback refuses changing source identity without terminating the server", async (t) => {
  await withLegacyBridge(t, { drift: true }, async ({ home, port, child, legacyFile, legacyBytes }) => {
    const refused = await stopVerifiedLegacy(port, home, child, { legacyFile, legacyBytes });
    assert.equal(refused.code, 1);
    assert.match(refused.stderr, /identity changed/);
    assert.equal((await health(port, child.pid)).pid, child.pid);
  });
});

test("legacy bridge.json supplies missing health generation without being modified", async (t) => {
  await withLegacyBridge(t, { noGeneration: true }, async ({
    home, port, child, legacyFile, legacyBytes,
  }) => {
    const stopped = await stopVerifiedLegacy(port, home, child, { legacyFile, legacyBytes });
    assert.equal(stopped.code, 0, stopped.stderr);
    await exit(child);
    assert.equal(fs.readFileSync(legacyFile, "utf8"), legacyBytes);
  });
});

test("legacy shutdown falls back to stable health and process identity if bridge.json is absent", async (t) => {
  await withLegacyBridge(t, { runtimeRecord: false }, async ({ home, port, child, legacyFile }) => {
    assert.equal(fs.existsSync(legacyFile), false);
    const stopped = await stopVerifiedLegacy(port, home, child, { legacyFile });
    assert.equal(stopped.code, 0, stopped.stderr);
    await exit(child);
    assert.equal(fs.existsSync(legacyFile), false);
  });
});

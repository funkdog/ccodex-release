// Isolated protocol verification. Does not launch/restart Desktop or use a model.
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { createHash, randomUUID } from "node:crypto";
import { spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";
import { isDeepStrictEqual } from "node:util";
import { startNativePeer } from "../gateway/native-peer.mjs";
import { AppServerRouter } from "../gateway/router.mjs";
import { RpcPeer } from "../gateway/rpc-peer.mjs";
import { connectGateway, writeMessage } from "../gateway/ipc.mjs";
import { startGateway } from "../gateway/server.mjs";
import { readThreadOwnership } from "../gateway/state.mjs";

export async function probeNativeRouting(executable, { outputParent = os.tmpdir() } = {}) {
  if (!path.isAbsolute(executable) || !fs.statSync(executable).isFile()) throw new Error("Pass an absolute installed native CLI executable.");
  const root = fs.mkdtempSync(path.join(outputParent, "ccodex-native-route-"));
  const profile = path.join(root, "native-profile");
  const home = path.join(root, "enhancement");
  const workspace = path.join(root, "workspace");
  for (const directory of [profile, home, workspace]) fs.mkdirSync(directory, { mode: 0o700 });
  fs.writeFileSync(path.join(profile, "config.toml"), 'cli_auth_credentials_store = "file"\ncheck_for_update_on_startup = false\n[analytics]\nenabled = false\n', { mode: 0o600 });
  const env = Object.fromEntries(["HOME", "PATH", "LANG", "TMPDIR", "SHELL"].filter(key => process.env[key]).map(key => [key, process.env[key]]));
  env.CODEX_HOME = profile;
  const version = spawnSync(executable, ["--version"], { env, encoding: "utf8", timeout: 10000 });
  if (version.status !== 0) {
    fs.rmSync(root, { recursive: true, force: true });
    throw new Error("Native CLI version probe failed.");
  }
  const report = { schemaVersion: 1, recordedAt: new Date().toISOString(), platform: process.platform,
    architecture: process.arch, cliVersion: version.stdout.trim(), cliSha256: createHash("sha256").update(fs.readFileSync(executable)).digest("hex"),
    desktopRestarted: false, existingProfileUsed: false, nativeInferenceTurns: 0, realCliInferenceTurns: 0, checks: {} };
  let direct, native, router, gateway;
  const log = fs.openSync(path.join(root, "native-stderr.log"), "wx", 0o600);
  try {
    const configuration = { home, endpoint: path.join(root, "s"), token: randomUUID(), generation: "isolated-probe",
      defaultEngine: "probe", engines: new Map([["probe", { models: async () => [{ id: "deterministic" }],
        run: async ({ prompt, onSession, onText }) => {
          if (prompt !== "CCODEX_NATIVE_ROUTE_PROBE") throw new Error("Probe accepts only its synthetic sentinel.");
          onSession("synthetic-cli-session"); onText("CCODEX_NATIVE_ROUTE_OK");
        } }]]) };
    gateway = await startGateway(configuration);
    direct = await startNativePeer({ executable, args: ["app-server"], cwd: workspace, env, stderr: log });
    const init = { clientInfo: { name: "ccodex_native_route_probe", version: "0.1" }, capabilities: { experimentalApi: true } };
    const expected = await direct.request("initialize", init, { timeoutMs: 10000 });
    direct.notify({ method: "initialized" });
    native = await startNativePeer({ executable, args: ["app-server"], cwd: workspace, env, stderr: log });
    const output = new Map();
    let terminal;
    const completed = new Promise(resolve => { terminal = resolve; });
    router = new AppServerRouter({ native,
      ownsThread: id => readThreadOwnership(path.join(home, "gateway", "threads"), id), cursorSecret: configuration.token,
      send: message => {
        if (!message.method) output.set(message.id, message);
        if (message.method === "turn/completed") terminal(message.params.turn);
      },
      connectGateway: async () => {
        let socket;
        const peer = new RpcPeer(message => writeMessage(socket, message));
        socket = await connectGateway(configuration, message => peer.receive(message));
        socket.on("close", () => peer.close());
        peer.dispose = async () => { socket.destroy(); peer.close(); };
        return peer;
      } });
    let sequence = 0;
    const request = async (method, params) => {
      const id = ++sequence;
      let timer;
      try { await Promise.race([router.receive({ id, method, params }), new Promise((_, reject) => {
        timer = setTimeout(() => reject(new Error(`Native routing probe timed out: ${method}`)), 10000);
      })]); } finally { clearTimeout(timer); }
      const result = output.get(id); output.delete(id);
      if (!result || result.error) throw new Error(`${method}: ${result?.error?.message || "No response"}`);
      return result.result;
    };
    const actual = await request("initialize", init);
    await router.receive({ method: "initialized" });
    report.checks.nativeInitializePreserved = expected.userAgent === actual.userAgent && expected.codexHome === actual.codexHome;
    for (const method of ["account/read", "config/read"]) {
      const params = method === "config/read" ? { includeLayers: false } : { refreshToken: false };
      report.checks[`${method}Unchanged`] = isDeepStrictEqual(await direct.request(method, params, { timeoutMs: 10000 }), await request(method, params));
    }
    const nativeModels = await direct.request("model/list", { limit: 1000 }, { timeoutMs: 10000 });
    const merged = await request("model/list", { limit: 1000 });
    report.checks.nativeModelsPreserved = isDeepStrictEqual(nativeModels.data, merged.data.filter(model => !model.model.startsWith("mycodex/")));
    report.checks.syntheticModelAdded = merged.data.some(model => model.model === "mycodex/probe/deterministic" && model.isDefault === false);
    const nativeThread = await request("thread/start", { cwd: workspace });
    report.checks.nativeThreadCreatedByNative = Boolean((await native.request("thread/read", { threadId: nativeThread.thread.id }, { timeoutMs: 10000 })).thread);
    const foreign = await request("thread/start", { cwd: workspace, model: "mycodex/probe/deterministic" });
    await request("turn/start", { threadId: foreign.thread.id, input: [{ type: "text", text: "CCODEX_NATIVE_ROUTE_PROBE" }] });
    const timeout = setTimeout(() => terminal(null), 5000);
    const turn = await completed; clearTimeout(timeout);
    report.checks.syntheticTurnCompleted = turn?.status === "completed" && turn.items.at(-1).text === "CCODEX_NATIVE_ROUTE_OK";
    const history = await request("thread/list", { limit: 100, sortKey: "created_at" });
    const nativeHistory = await direct.request("thread/list", { limit: 100 }, { timeoutMs: 10000 });
    report.nativeListedThreads = nativeHistory.data.length;
    report.checks.nativeHistoryPreserved = nativeHistory.data.every(row => history.data.some(item => item.id === row.id));
    report.checks.syntheticThreadVisibleInMergedHistory = history.data.some(row => row.id === foreign.thread.id);
    report.checks.syntheticThreadAbsentFromNativeStore = !nativeHistory.data.some(row => row.id === foreign.thread.id);
    const foreignRead = await native.call({ id: `probe-foreign:${randomUUID()}`, method: "thread/read", params: { threadId: foreign.thread.id } }, { timeoutMs: 10000 });
    report.nativeForeignRead = { error: foreignRead.error ?? null, returnedThreadId: foreignRead.result?.thread?.id ?? null };
    // Metadata-only read reports "not loaded" for a thread outside this native
    // process. Record that exact observation, not a claim about disk history.
    report.checks.syntheticThreadNotLoadedByNative = foreignRead.error?.code === -32600 &&
      foreignRead.error.message === `thread not loaded: ${foreign.thread.id}`;
    report.passed = Object.values(report.checks).every(Boolean);
  } catch (error) { report.passed = false; report.error = error.message; }
  finally {
    if (router) await router.close(); else await native?.dispose?.();
    await direct?.dispose?.(); await gateway?.close(); fs.closeSync(log);
    for (const directory of [profile, home, workspace]) fs.rmSync(directory, { recursive: true, force: true });
  }
  fs.writeFileSync(path.join(root, "report.json"), JSON.stringify(report, null, 2) + "\n", { mode: 0o600 });
  return { root, report };
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  if (process.argv[2] !== "--native-cli" || !process.argv[3] || process.argv.length !== 4) throw new Error("Usage: node tools/probe-native-routing.mjs --native-cli /absolute/original/codex");
  probeNativeRouting(process.argv[3]).then(({ root, report }) => {
    console.log(JSON.stringify({ reportFile: path.join(root, "report.json"), ...report }, null, 2));
    if (!report.passed) process.exitCode = 1;
  }, error => { console.error(error.message); process.exitCode = 1; });
}

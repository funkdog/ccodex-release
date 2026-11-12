// Explicit authenticated live probe: temporary profiles/workspace only, no
// Desktop connection, copied temporary credential removed in finally.
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { randomUUID } from "node:crypto";
import { pathToFileURL } from "node:url";
import { createEngines } from "../gateway/engines/index.mjs";
import { assertAntigravityAccount } from "../gateway/engines/antigravity.mjs";
import { startGateway } from "../gateway/server.mjs";
import { startNativePeer } from "../gateway/native-peer.mjs";
import { AppServerRouter } from "../gateway/router.mjs";
import { RpcPeer } from "../gateway/rpc-peer.mjs";
import { connectGateway, writeMessage } from "../gateway/ipc.mjs";
import { readThreadOwnership } from "../gateway/state.mjs";

export async function probeAntigravity({ executable, harnessPath, accountHome, nativeCli }) {
  assertAntigravityAccount(accountHome);
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "cc-antigravity-live-")); fs.chmodSync(root, 0o700);
  const cliHome = path.join(root, "account"), home = path.join(root, "gateway"), profile = path.join(root, "native"), workspace = path.join(root, "workspace");
  for (const dir of [cliHome, home, profile, workspace, path.join(cliHome, "antigravity-acp")]) fs.mkdirSync(dir, { recursive: true, mode: 0o700 });
  for (const name of ["settings.json", "acp_token.json"]) {
    const target = path.join(cliHome, "antigravity-acp", name);
    fs.copyFileSync(path.join(accountHome, "antigravity-acp", name), target, fs.constants.COPYFILE_EXCL); fs.chmodSync(target, 0o600);
  }
  fs.writeFileSync(path.join(profile, "config.toml"), 'cli_auth_credentials_store = "file"\ncheck_for_update_on_startup = false\n[analytics]\nenabled = false\n', { mode: 0o600 });
  const report = { recordedAt: new Date().toISOString(), runtime: "official-antigravity-acp", desktopRestarted: false,
    temporaryProfiles: true, nativeInferenceTurns: 0, agentTurns: 0, approvalsAllowed: 0, approvalsDenied: 0, checks: {} };
  const log = fs.openSync(path.join(root, "native.stderr.log"), "wx", 0o600);
  let gateway, router, threadId, activeTurn, approveWrite = false;
  const terminals = new Map(), output = new Map(); let sequence = 0;
  const file = path.join(fs.realpathSync(workspace), "probe.txt");
  const config = { home, endpoint: path.join(root, "s"), token: randomUUID(), generation: "isolated-antigravity-probe", defaultEngine: "antigravity" };
  async function connect() {
    const engines = await createEngines([{ id: "antigravity", adapter: "antigravity-acp", executable, harnessPath, cliHome }],
      { env: { ...process.env, HOME: root } });
    gateway = await startGateway({ ...config, engines });
    const native = await startNativePeer({ executable: nativeCli, args: ["app-server"], cwd: workspace,
      env: { HOME: root, CODEX_HOME: profile, PATH: process.env.PATH }, stderr: log });
    const call = native.call.bind(native);
    native.call = (message, ...args) => {
      if (["turn/start", "turn/addUserMessage", "turn/steer"].includes(message.method)) { report.nativeInferenceTurns++; throw new Error("Native inference was blocked by the live probe."); }
      return call(message, ...args);
    };
    router = new AppServerRouter({ native, discoveryTimeoutMs: 30000, cursorSecret: config.token,
      ownsThread: id => readThreadOwnership(path.join(home, "gateway/threads"), id), send: message => {
        if (!message.method) output.set(message.id, message);
        if (message.method === "turn/completed") terminals.set(message.params.turn.id, message.params.turn);
        if (Object.hasOwn(message, "id") && message.method) {
          let allow = false;
          try {
            const q = message.params.questions[0], detail = JSON.parse(q.question.slice(q.question.indexOf("\n") + 1));
            const diffs = detail.content?.filter(c => c.type === "diff") ?? [];
            allow = approveWrite && q.id === "permission" && detail.kind === "edit" && diffs.length > 0 &&
              diffs.every(d => path.resolve(d.path) === file && !d.oldText && d.newText.trim() === "ANTIGRAVITY_TOOL_OK");
          } catch {}
          if (allow) report.approvalsAllowed++; else report.approvalsDenied++;
          void router.receive({ id: message.id, result: { answers: { permission: { answers: [allow ? "Allow once" : "Deny"] } } } });
        }
      }, connectGateway: async () => {
        let socket; const peer = new RpcPeer(message => writeMessage(socket, message));
        socket = await connectGateway(config, message => peer.receive(message)); socket.on("close", () => peer.close());
        peer.dispose = async () => { socket.destroy(); peer.close(); }; return peer;
      } });
    await request("initialize", { clientInfo: { name: "mycodex_antigravity_probe", version: "1" }, capabilities: { experimentalApi: true } });
    await router.receive({ method: "initialized" });
  }
  async function request(method, params = {}) {
    const id = ++sequence; await router.receive({ id, method, params }); const reply = output.get(id); output.delete(id);
    if (!reply || reply.error) throw new Error(`${method}: ${reply?.error?.message || "no response"}`); return reply.result;
  }
  async function turn(text, images = []) {
    const started = await request("turn/start", { threadId, input: [{ type: "text", text }, ...images] });
    activeTurn = started.turn.id; report.agentTurns++;
    const deadline = Date.now() + 150000;
    while (!terminals.has(activeTurn) && Date.now() < deadline) await new Promise(resolve => setTimeout(resolve, 100));
    const result = terminals.get(activeTurn);
    if (!result) { await request("turn/interrupt", { threadId, turnId: activeTurn }); throw new Error("Live Antigravity turn timed out; cancelled, no retry."); }
    activeTurn = null;
    if (result.status !== "completed") throw new Error(result.error?.message || `Turn ended ${result.status}`);
    return result.items.filter(i => i.type === "agentMessage").map(i => i.text).join("").trim();
  }
  try {
    await connect();
    const models = (await request("model/list", { limit: 1000 })).data.filter(m => m.model.startsWith("mycodex/antigravity/"));
    report.modelIds = models.map(m => m.model.slice("mycodex/antigravity/".length));
    report.efforts = Object.fromEntries(models.map(m => [m.model, m.supportedReasoningEfforts.map(e => e.reasoningEffort)]));
    const model = models.find(m => /flash/.test(m.model)); if (!model) throw new Error("Account does not advertise a Flash model; no model was substituted.");
    threadId = (await request("thread/start", { cwd: fs.realpathSync(workspace), model: model.model, effort: "low" })).thread.id;
    const nonce = "AGY_MEM_" + randomUUID().slice(0, 8);
    report.firstReply = await turn(`Remember this synthetic nonce for this conversation: ${nonce}. Reply exactly AGY_CONNECTED. Do not use any tools, files, shell, search or delegation.`);
    const before = gateway.protocol.store.get(threadId).nativeSessionId;
    await router.close(); await gateway.close(); await connect();
    await request("thread/resume", { threadId });
    const remembered = await turn("Reply with only the synthetic nonce I gave you earlier. Do not use tools, files, shell, search or delegation.");
    report.checks.firstReply = report.firstReply === "AGY_CONNECTED";
    report.checks.coldResumeRemembersWithoutHint = remembered === nonce;
    report.checks.sessionIdentityPreserved = gateway.protocol.store.get(threadId).nativeSessionId === before;
    const png = "iVBORw0KGgoAAAANSUhEUgAAABAAAAAQCAIAAACQkWg2AAAAF0lEQVR4nGP4z8BAEiJN9aiGUQ1DSgMAkPn/Afnh+ngAAAAASUVORK5CYII=";
    report.imageReply = await turn("Name the dominant color in the attached image. Reply with one English color word only. Do not use tools, files, shell, search or delegation.", [{ type: "image", url: `data:image/png;base64,${png}` }]);
    report.checks.imageUnderstood = /^red[.!]?$/i.test(report.imageReply);
    const argon = models.find(m => /argon/.test(m.model));
    if (argon) {
      const previous = threadId; threadId = (await request("thread/start", { cwd: fs.realpathSync(workspace), model: argon.model, effort: "low" })).thread.id;
      report.argonReply = await turn("Reply exactly AGY_ARGON_OK. Do not use tools, files, shell, search or delegation.");
      report.checks.argonExecuted = report.argonReply === "AGY_ARGON_OK"; threadId = previous;
    }
    approveWrite = true;
    await turn(`Use only the file-writing tool to create ${file} with exactly ANTIGRAVITY_TOOL_OK. Do not use shell, read unrelated files, search, delegate, or modify any other path. If permission is denied, stop without retrying or finding another route.`);
    report.checks.approvalAndExactFileWrite = report.approvalsAllowed > 0 && fs.existsSync(file) && fs.readFileSync(file, "utf8").trim() === "ANTIGRAVITY_TOOL_OK";
    report.checks.noNativeInference = report.nativeInferenceTurns === 0;
    report.checks.gatewayHistory = gateway.protocol.store.get(threadId).turns.length === 4;
    report.passed = Object.values(report.checks).every(Boolean);
  } catch (error) { report.passed = false; report.error = error.message; }
  finally {
    if (activeTurn && router) try { await request("turn/interrupt", { threadId, turnId: activeTurn }); } catch {}
    await router?.close(); await gateway?.close(); fs.closeSync(log);
    for (const dir of [cliHome, home, profile, workspace]) fs.rmSync(dir, { recursive: true, force: true });
    report.temporaryCredentialRemoved = !fs.existsSync(cliHome);
  }
  fs.writeFileSync(path.join(root, "report.json"), JSON.stringify(report, null, 2) + "\n", { mode: 0o600 });
  return { root, report };
}
if (process.argv[1] && import.meta.url === pathToFileURL(path.resolve(process.argv[1])).href) {
  const [executable, harnessPath, accountHome, nativeCli] = process.argv.slice(2);
  if (!nativeCli || process.argv.length !== 6) throw new Error("Usage: probe-antigravity.mjs <ACP executable> <matching harness> <private account home> <native CLI>");
  const { root, report } = await probeAntigravity({ executable, harnessPath, accountHome, nativeCli });
  console.log(JSON.stringify({ reportFile: path.join(root, "report.json"), ...report }, null, 2)); if (!report.passed) process.exitCode = 1;
}

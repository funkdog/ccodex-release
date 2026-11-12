// Real native runtime, isolated profile/workspace, existing authenticated local
// model bridge. Does not launch, reconnect or restart Desktop.
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { pathToFileURL } from "node:url";
import { randomUUID } from "node:crypto";
import { startNativePeer } from "../gateway/native-peer.mjs";
import { AppServerRouter } from "../gateway/router.mjs";
import { codexCopilotCatalog, copilotProviderArguments, copilotProviderConfig } from "../gateway/copilot-provider.mjs";

export async function probeCodexCopilot({ nativeCli, bridgeHome, bridgePort, model }) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "cc-native-copilot-"));
  const profile = path.join(root, "profile"), workspace = path.join(root, "workspace");
  fs.mkdirSync(profile); fs.mkdirSync(workspace);
  fs.writeFileSync(path.join(profile, "config.toml"), 'cli_auth_credentials_store = "file"\ncheck_for_update_on_startup = false\n[analytics]\nenabled = false\n', { mode: 0o600 });
  const report = { recordedAt: new Date().toISOString(), runtime: "native-codex", model, desktopRestarted: false,
    existingNativeProfileUsed: false, cliGatewayInferenceTurns: 0, checks: {} };
  const provider = { bridgeHome, bridgePort };
  const log = fs.openSync(path.join(root, "stderr.log"), "wx", 0o600);
  let router, sequence = 0;
  const replies = new Map(), turns = new Map();
  const request = async (method, params) => {
    const id = ++sequence;
    await router.receive({ id, method, params });
    const reply = replies.get(id); replies.delete(id);
    if (!reply || reply.error) throw new Error(`${method}: ${reply?.error?.message || "no response"}`);
    return reply.result;
  };
  async function connect() {
    const native = await startNativePeer({ executable: nativeCli,
      args: ["app-server", ...copilotProviderArguments(provider)], cwd: workspace, stderr: log,
      env: { HOME: root, CODEX_HOME: profile, PATH: process.env.PATH } });
    router = new AppServerRouter({ native, copilotProvider: provider, cursorSecret: "owned-probe-no-gateway",
      connectProvider: id => {
        if (id !== "mycodex-copilot") throw new Error("Unexpected native provider in Copilot probe.");
        return startNativePeer({ executable: nativeCli,
          args: ["app-server", ...copilotProviderArguments(provider), "-c", "model_provider=mycodex-copilot",
            "-c", `model_catalog_json=${JSON.stringify(copilotProviderConfig(provider).model_catalog_json)}`],
          cwd: workspace, stderr: log, env: { HOME: root, CODEX_HOME: profile, PATH: process.env.PATH } });
      },
      ownsThread: () => false,
      connectGateway: async () => { report.cliGatewayInferenceTurns++; throw new Error("Unexpected Copilot CLI gateway call."); },
      send: message => {
        if (!message.method) replies.set(message.id, message);
        else if (message.method === "turn/completed") turns.set(message.params.turn.id, message.params.turn);
        else if (Object.hasOwn(message, "id")) void router.receive({ id: message.id, error: { code: -32000, message: "Probe grants no tool permissions." } });
      } });
    await request("initialize", { clientInfo: { name: "mycodex_native_copilot_probe", version: "1" },
      capabilities: { experimentalApi: true } });
    await router.receive({ method: "initialized" });
  }
  async function complete(threadId, turnId) {
    const deadline = Date.now() + 120000;
    while (!turns.has(turnId) && Date.now() < deadline) await new Promise(resolve => setTimeout(resolve, 100));
    const turn = turns.get(turnId);
    if (!turn) { await request("turn/interrupt", { threadId, turnId }); throw new Error("Probe timed out; interrupt requested, no retry."); }
    if (turn.status !== "completed") throw new Error(turn.error?.message || `Turn ended: ${turn.status}`);
    return turn;
  }
  try {
    const models = await codexCopilotCatalog(provider).models();
    const selected = models.find(row => row.id === model);
    if (!selected || !selected.inputModalities.includes("image")) throw new Error("Requested vision model is not in the authenticated API catalog.");
    const effort = selected.supportedReasoningEfforts.includes("xhigh") ? "xhigh" : selected.defaultReasoningEffort;
    report.effort = effort;
    await connect();
    const created = await request("thread/start", { cwd: workspace, model: `mycodex/codex-copilot/${model}`, approvalPolicy: "never", sandbox: "read-only" });
    const threadId = created.thread.id;
    const png = "iVBORw0KGgoAAAANSUhEUgAAABAAAAAQCAIAAACQkWg2AAAAF0lEQVR4nGP4z8BAEiJN9aiGUQ1DSgMAkPn/Afnh+ngAAAAASUVORK5CYII=";
    const nonce = `MYCODEX_UPGRADE_${randomUUID().slice(0, 8)}`;
    const { turn } = await request("turn/start", { threadId, model: `mycodex/codex-copilot/${model}`, effort,
      input: [{ type: "text", text: `Remember this synthetic nonce for our next turn: ${nonce}. For this turn, name the dominant color in the attached image. Reply with one English color word only. Do not use any tools, files, shell, search or delegation.` },
        { type: "image", url: `data:image/png;base64,${png}` }] });
    const result = await complete(threadId, turn.id);
    report.imageReply = result.items.filter(item => item.type === "agentMessage").map(item => item.text).join("").trim();
    report.checks.imageUnderstood = /^red[.!]?$/i.test(report.imageReply);
    report.checks.nativeProvider = created.modelProvider === "mycodex-copilot";
    await router.close(); await connect();
    const resumed = await request("thread/resume", { threadId });
    report.checks.sameNativeHistoryAfterRestart = resumed.thread.id === threadId &&
      resumed.thread.turns.some(value => value.id === turn.id) && resumed.modelProvider === "mycodex-copilot";
    report.checks.settingsAfterRestart = resumed.approvalPolicy === "never" && resumed.reasoningEffort === effort;
    const continued = await request("turn/start", { threadId, input: [{ type: "text", text: "Reply with only the synthetic nonce from my previous message. Do not use any tools, files, shell, search or delegation." }] });
    const continuation = await complete(threadId, continued.turn.id);
    report.checks.continuationRetainsContext = continuation.items.filter(item => item.type === "agentMessage").map(item => item.text).join("").trim() === nonce;
    report.checks.noCliGateway = report.cliGatewayInferenceTurns === 0;
    report.checks.workspaceUntouched = fs.readdirSync(workspace).length === 0;
    report.passed = Object.values(report.checks).every(Boolean);
  } catch (error) { report.passed = false; report.error = error.message; }
  finally {
    await router?.close(); fs.closeSync(log);
    for (const dir of [profile, workspace]) fs.rmSync(dir, { recursive: true, force: true });
  }
  fs.writeFileSync(path.join(root, "report.json"), JSON.stringify(report, null, 2) + "\n", { mode: 0o600 });
  return { root, report };
}
if (process.argv[1] && import.meta.url === pathToFileURL(path.resolve(process.argv[1])).href) {
  const [nativeCli, bridgeHome, port, model] = process.argv.slice(2);
  if (!nativeCli || !bridgeHome || !port || !model || process.argv.length !== 6)
    throw new Error("Usage: node tools/probe-codex-copilot.mjs <native CLI> <bridge home> <bridge port> <catalog model>");
  const { root, report } = await probeCodexCopilot({ nativeCli, bridgeHome, bridgePort: Number(port), model });
  console.log(JSON.stringify({ reportFile: path.join(root, "report.json"), ...report }, null, 2));
  if (!report.passed) process.exitCode = 1;
}

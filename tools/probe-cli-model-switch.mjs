// Explicit real-CLI check in temporary profiles/workspaces. Never connects to
// Desktop or the production gateway. Two bounded inference turns per engine.
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { pathToFileURL } from "node:url";
import { copilotEngine } from "../gateway/engines/github-copilot.mjs";
import { antigravityEngine } from "../gateway/engines/antigravity.mjs";
import { cliEnvironment } from "../gateway/engines/index.mjs";
import { readRoutingConnection } from "../gateway/routed-stdio.mjs";
import { startGateway } from "../gateway/server.mjs";
import { createCliSelectorServices } from "../bridge/desktop-cli-selector.mjs";
import { startAcpPeer } from "../gateway/acp-peer.mjs";

export async function probeCliModelSwitch(connectionFile) {
  const configured = readRoutingConnection(connectionFile);
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "cc-model-switch-"));
  const report = { recordedAt: new Date().toISOString(), desktopRestarted: false, productionGatewayTouched: false,
    temporaryProfiles: true, nativeInferenceTurns: 0, cliTurns: 0, results: [], checks: {} };
  const privateDirectories = [];
  const copyPrivate = (source, target) => {
    const stat = fs.lstatSync(source);
    if (!stat.isFile() || stat.isSymbolicLink() || stat.size > 256 * 1024) throw new Error("Expected a bounded regular account file.");
    fs.copyFileSync(source, target, fs.constants.COPYFILE_EXCL); fs.chmodSync(target, 0o600);
  };
  let gateway;
  try {
    for (const adapter of ["github-copilot", "antigravity-acp"]) {
      const source = configured.engines.find(e => e.adapter === adapter);
      if (!source) throw new Error(`Missing configured adapter: ${adapter}`);
      const directory = path.join(root, source.id), profile = path.join(directory, "profile"), home = path.join(directory, "gateway"), workspace = path.join(directory, "workspace");
      fs.mkdirSync(directory, { mode: 0o700 }); privateDirectories.push(directory);
      for (const dir of [profile, home, workspace]) fs.mkdirSync(dir, { mode: 0o700 });
      const runtimeStates = [], runtimeOperations = [];
      const result = { engine: source.id, runtimeStates, runtimeOperations, passed: false }; report.results.push(result);
      let engine;
      if (adapter === "github-copilot") {
        copyPrivate(path.join(process.env.HOME, ".copilot/config.json"), path.join(profile, "config.json"));
        const sdk = await import(pathToFileURL(source.sdkPath).href);
        const observe = async (session, config, phase) => {
          const actual = await session.rpc.model.getCurrent();
          runtimeStates.push({ phase, model: actual.modelId, effort: actual.reasoningEffort });
          assert.equal(actual.modelId, config.model, "The real CLI must acknowledge the selected model before send");
          if (config.reasoningEffort) assert.equal(actual.reasoningEffort, config.reasoningEffort);
          return session;
        };
        engine = copilotEngine({ env: { ...cliEnvironment(), COPILOT_HOME: profile }, sdk: { ...sdk, CopilotClient: class extends sdk.CopilotClient {
          constructor(options) { super({ ...options, baseDirectory: profile }); }
          async createSession(config) { return observe(await super.createSession(config), config, "create"); }
          async resumeSession(id, config) { return observe(await super.resumeSession(id, config), config, "resume"); }
        } } });
      } else {
        const account = path.join(profile, "antigravity-acp"); fs.mkdirSync(account, { mode: 0o700 });
        for (const name of ["settings.json", "acp_token.json"]) copyPrivate(path.join(source.cliHome, "antigravity-acp", name), path.join(account, name));
        engine = antigravityEngine({ ...source, cliHome: profile, start: async options => {
          const peer = await startAcpPeer(options), request = peer.request.bind(peer);
          peer.request = async (method, params, settings) => {
            const start = Date.now();
            try { const result = await request(method, params, settings); runtimeOperations.push({ method, elapsedMs: Date.now() - start }); return result; }
            catch (error) { runtimeOperations.push({ method, elapsedMs: Date.now() - start, failed: true });
              throw new Error(`Antigravity ${method}: ${error.message}`); }
          };
          return peer;
        } });
      }
      const config = { home, endpoint: path.join(directory, "s"), token: randomUUID(), generation: "isolated-model-switch",
        defaultEngine: source.id, engines: new Map([[source.id, { adapter, ...engine }]]) };
      gateway = await startGateway(config);
      const connection = { initialized: true, send() {}, request: async () => ({ answers: { permission: { answers: ["Deny"] } } }) };
      const call = (method, params) => gateway.protocol.handle(method, params, connection);
      const services = createCliSelectorServices(call);
      const models = (await call("model/list", { limit: 1000 })).data;
      assert.ok(models.length >= 2, "Need two advertised models; never invent a fallback");
      const a = models.find(m => /(?:gpt-6\.1-sol|flash)/.test(m.model)) ?? models[0];
      const others = models.filter(m => m.id !== a.id && !m.model.endsWith('/auto'));
      const b = others.find(m => /(?:gpt-6-astra|argon)/.test(m.model)) ??
        others.find(m => /(?:flash|haiku|mini|luna)/i.test(m.model)) ?? others[0];
      assert.ok(b, "Need a second concrete advertised model");
      result.models = [a.model, b.model];
      const common = a.supportedReasoningEfforts.map(e => e.reasoningEffort).filter(e => b.supportedReasoningEfforts.some(v => v.reasoningEffort === e));
      const effort = common.includes("high") ? "high" : common[0] ?? a.defaultReasoningEffort;
      const { thread } = await call("thread/start", { cwd: workspace, model: a.model, effort, cliApprovalMode: "deny" });
      const execute = async prompt => {
        report.cliTurns++;
        await call("turn/start", { threadId: thread.id, input: [{ type: "text", text: prompt }] });
        const active = gateway.protocol.active.get(thread.id);
        const timer = setTimeout(() => active?.controller.abort(), 90000);
        try { await active?.done; } finally { clearTimeout(timer); }
        const stored = gateway.protocol.store.get(thread.id), turn = stored.turns.at(-1);
        assert.equal(turn.status, "completed", turn.error?.message);
        return turn.items.filter(i => i.type === "agentMessage").map(i => i.text).join("").trim();
      };
      console.log(JSON.stringify({ event: "model-switch-start", engine: source.id, from: a.model, to: b.model, effort }));
      const nonce = "MODEL_CONTEXT_" + randomUUID().slice(0, 8);
      await execute(`Remember this nonce for this conversation: ${nonce}. Reply only MODEL_A_OK. Do not use any tools, files, shell, search, delegation or questions.`);
      const before = gateway.protocol.store.get(thread.id);
      const switched = await services.updateSettings({ threadId: thread.id, model: `mycodex/${b.model}` });
      assert.equal(switched.model, b.model); assert.equal(switched.cliApprovalMode, "deny");
      await gateway.close(); gateway = await startGateway(config);
      const resumed = await call("thread/resume", { threadId: thread.id });
      assert.equal(resumed.thread.model, b.model); assert.equal(resumed.thread.reasoningEffort, switched.reasoningEffort);
      assert.equal(resumed.thread.cliApprovalMode, "deny");
      const answer = await execute("Reply only with the nonce I gave you previously. Do not use any tools, files, shell, search, delegation or questions.");
      assert.ok(answer.includes(nonce), "The second model must retain context without replay or a new hint");
      const after = gateway.protocol.store.get(thread.id);
      assert.equal(after.nativeSessionId, before.nativeSessionId); assert.equal(after.turns.length, 2);
      Object.assign(result, { reasoningEffort: switched.reasoningEffort, approvalMode: "deny",
        contextRetained: true, sessionIdentityRetained: true, coldRestartRetained: true, passed: true });
      await gateway.close(); gateway = null;
      console.log(JSON.stringify({ event: "model-switch-passed", engine: source.id }));
    }
    report.passed = true;
  } catch (error) { report.passed = false; report.error = error.message; }
  finally {
    await gateway?.close();
    for (const directory of privateDirectories) fs.rmSync(directory, { recursive: true, force: true });
    report.temporaryProfilesRemoved = privateDirectories.every(directory => !fs.existsSync(directory));
  }
  const reportFile = path.join(root, "report.json"); fs.writeFileSync(reportFile, JSON.stringify(report, null, 2) + "\n", { mode: 0o600 });
  return { reportFile, ...report };
}
if (process.argv[1] && import.meta.url === pathToFileURL(path.resolve(process.argv[1])).href) {
  if (process.argv.length !== 3) throw new Error("Usage: probe-cli-model-switch.mjs <private connection file; read only>");
  const result = await probeCliModelSwitch(process.argv[2]); console.log(JSON.stringify(result, null, 2)); if (!result.passed) process.exitCode = 1;
}

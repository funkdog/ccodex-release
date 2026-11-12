// Explicit real-CLI smoke test. Uses a temporary workspace/native profile and
// bounded text or exact-file permission prompts. Never launches or reconnects Desktop.
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { randomUUID } from "node:crypto";
import { pathToFileURL } from "node:url";
import { createEngines, cliEnvironment } from "../gateway/engines/index.mjs";
import { copilotEngine } from "../gateway/engines/github-copilot.mjs";
import { startGateway } from "../gateway/server.mjs";
import { startNativePeer } from "../gateway/native-peer.mjs";
import { AppServerRouter } from "../gateway/router.mjs";
import { RpcPeer } from "../gateway/rpc-peer.mjs";
import { connectGateway, writeMessage } from "../gateway/ipc.mjs";
import { readThreadOwnership } from "../gateway/state.mjs";
import { createNativeSessionController } from "../bridge/desktop-native-session.mjs";

export async function probeCliGateway({ sdkPath, nativeCli, model, resume = false, permissions = false, interrupt = false, desktopEnvelope = false, nativeDraft = false, settings = false, images = false }) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "cc-gw-live-"));
  const home = path.join(root, "gateway-state"), profile = path.join(root, "native"), workspace = path.join(root, "workspace");
  for (const directory of [home, profile, workspace]) fs.mkdirSync(directory, { mode: 0o700 });
  fs.writeFileSync(path.join(profile, "config.toml"), 'cli_auth_credentials_store = "file"\n[analytics]\nenabled = false\n', { mode: 0o600 });
  const log = fs.openSync(path.join(root, "native-stderr.log"), "wx", 0o600);
  const report = { recordedAt: new Date().toISOString(), model, desktopRestarted: false, existingCodexProfileUsed: false,
    desktopEnvelope, nativeDraft, settings, images,
    cliAuthSource: "current-user-native-login", cliSessionStorage: "CLI-managed new probe session",
    nativeInferenceTurns: 0, cliTurns: 0, toolEvents: 0, questionsDenied: 0, questionsAllowed: 0, checks: {} };
  report.permissionRequests = [];
  report.pendingApprovals = 0;
  const testFile = path.join(fs.realpathSync(workspace), "probe.txt");
  let allowProbeWrite = false;
  let gateway, native, router, activeTurn, threadId;
  const terminals = new Map(), terminalCounts = new Map(), output = new Map();
  try {
    const engines = await createEngines([{ id: "copilot", adapter: "github-copilot", sdkPath }]);
    if (settings) {
      const sdk = await import(pathToFileURL(sdkPath).href);
      report.runtimeEfforts = []; report.automaticApprovals = 0; report.probeGuardRejections = 0;
      const wrap = config => ({ ...config, onPermissionRequest: async (request, invocation) => {
        // The production policy is tested below; this probe adds an independent
        // exact-file guard so model deviation cannot widen its test workspace.
        const files = request.fileEdits?.map(edit => edit.after?.path ?? edit.before?.path) ?? [request.fileName];
        if (request.kind !== "write" || !files.length || files.some(file => typeof file !== "string" || path.resolve(file) !== testFile)) {
          report.probeGuardRejections++; return { kind: "reject" };
        }
        const result = await config.onPermissionRequest(request, invocation);
        if (result.kind === "approve-once") report.automaticApprovals++;
        return result;
      } });
      const observe = async (session, phase) => {
        const state = await session.rpc.model.getCurrent();
        report.runtimeEfforts.push({ phase, model: state.modelId, effort: state.reasoningEffort }); return session;
      };
      engines.set("copilot", { adapter: "github-copilot", ...copilotEngine({ env: cliEnvironment(), sdk: { ...sdk, CopilotClient: class extends sdk.CopilotClient {
        async createSession(config) { return observe(await super.createSession(wrap(config)), "create"); }
        async resumeSession(id, config) { return observe(await super.resumeSession(id, wrap(config)), "resume"); }
      } } }) });
    }
    const config = { home, endpoint: path.join(root, "s"), token: randomUUID(), generation: "live-probe", engines, defaultEngine: "copilot" };
    gateway = await startGateway(config);
    const env = Object.fromEntries(["HOME", "PATH", "LANG", "TMPDIR"].filter(key => process.env[key]).map(key => [key, process.env[key]]));
    env.CODEX_HOME = profile;
    native = await startNativePeer({ executable: nativeCli, args: ["app-server"], cwd: workspace, env, stderr: log });
    const nativeCall = native.call.bind(native);
    native.call = (message, ...args) => {
      if (["turn/start", "turn/addUserMessage", "turn/steer"].includes(message.method)) {
        report.nativeInferenceTurns++;
        throw new Error("Unexpected native inference request was blocked by the probe.");
      }
      return nativeCall(message, ...args);
    };
    report.nativeInferenceGuard = "observed-and-blocked-at-native-peer";
    router = new AppServerRouter({ native, cursorSecret: config.token, discoveryTimeoutMs: 30000,
      ownsThread: id => readThreadOwnership(path.join(home, "gateway", "threads"), id),
      send: message => {
        if (!message.method) output.set(message.id, message);
        if (message.method === "turn/completed") {
          terminals.set(message.params.turn.id, message.params.turn);
          terminalCounts.set(message.params.turn.id, (terminalCounts.get(message.params.turn.id) || 0) + 1);
        }
        if (message.method === "item/started" && message.params.item.type === "dynamicToolCall") report.toolEvents++;
        if (message.method && Object.hasOwn(message, "id")) {
          if (interrupt && message.method === "item/tool/requestUserInput") {
            report.pendingApprovals++; return; // Deliberately unanswered, then cancel through the public protocol.
          }
          let allow = false;
          if (permissions && allowProbeWrite && message.method === "item/tool/requestUserInput") {
            try {
              const question = message.params.questions[0];
              const details = JSON.parse(question.question.slice(question.question.indexOf("\n") + 1));
              report.permissionRequests.push({ kind: details.kind, expectedFile: details.fileName === testFile,
                hasContents: typeof details.newFileContents === "string", editCount: details.fileEdits?.length ?? 0,
                managedApprovalRequired: details.managedApprovalRequired === true });
              allow = question.id === "permission" && details.kind === "write" && details.managedApprovalRequired !== true &&
                path.resolve(details.fileName) === testFile && !fs.existsSync(testFile) &&
                (details.newFileContents ?? details.fileEdits?.[0]?.after?.content)?.trim() === "CCODEX_PERMISSION_OK" &&
                (!details.fileEdits || details.fileEdits.every(edit => !edit.before && edit.after?.path === testFile && edit.after.content.trim() === "CCODEX_PERMISSION_OK"));
            } catch {}
          }
          if (allow) report.questionsAllowed++; else report.questionsDenied++;
          void router.receive({ id: message.id, result: { answers: { permission: { answers: [allow ? "Allow once" : "Deny"] } } } });
        }
      }, connectGateway: async () => {
        let socket; const peer = new RpcPeer(message => writeMessage(socket, message));
        socket = await connectGateway(config, message => peer.receive(message));
        socket.on("close", () => peer.close()); peer.dispose = async () => { socket.destroy(); peer.close(); }; return peer;
      } });
    let id = 0;
    const selection = nativeDraft ? createNativeSessionController() : null;
    const request = async (method, params = {}) => {
      const requestId = ++id;
      if (method === "turn/start") report.cliTurns++;
      const payload = { hostId: "local", request: { id: requestId, method, params } };
      await router.receive(selection ? selection.outgoing("mcp-request", payload).request : payload.request);
      const reply = output.get(requestId); output.delete(requestId);
      if (!reply || reply.error) throw new Error(`${method}: ${reply?.error?.message || "No response"}`);
      selection?.observe({ type: "mcp-response", hostId: "local", message: reply });
      return reply.result;
    };
    await request("initialize", { clientInfo: { name: "ccodex_real_cli_probe", version: "0.1" }, ...(nativeDraft ? { capabilities: { experimentalApi: true } } : {}) });
    await router.receive({ method: "initialized" });
    const catalog = await request("model/list", { limit: 1000 });
    report.availableCliModels = catalog.data.filter(row => row.model.startsWith("mycodex/copilot/")).map(row => row.model.slice("mycodex/copilot/".length));
    report.geminiAvailable = report.availableCliModels.some(id => /gemini/i.test(id));
    if (!report.availableCliModels.includes(model)) throw new Error("Requested model is not in the authenticated CLI catalog; no fallback attempted.");
    selection?.select(`mycodex/copilot/${model}`);
    const intent = selection?.begin({ clientUserMessageId: randomUUID(), input: [{ type: "text", text: "bounded real CLI probe" }] });
    const started = await request("thread/start", { model: `mycodex/copilot/${model}`, cwd: workspace,
      ...(nativeDraft ? { threadSource: "user", permissions: ":workspace-write", effort: "high" } : {}) });
    intent?.finish();
    threadId = started.thread.id;
    if (nativeDraft) {
      const { project } = await request("project/create", { name: "MyCodex isolated probe", roots: [{ path: workspace }], idempotencyKey: randomUUID() });
      await request("thread/metadata/update", { threadId, projectId: project.id });
      await request("thread/settings/update", { threadId, disabledPluginIds: [] });
      const page = await request("thread/list", { projectId: project.id, sortKey: "recency_at" });
      report.checks.projectSidebarEntry = page.data.some(thread => thread.id === threadId);
      selection.select(null); // A new native draft must not change this CLI thread.
    }
    if (desktopEnvelope) {
      const listed = await request("thread/list", { sourceKinds: ["cli", "vscode", "appServer"], sectionId: null, limit: 100, sortKey: "recency_at", useStateDbOnly: true });
      report.checks.findCreatedThread = listed.data.some(thread => thread.id === threadId && thread.name);
      for (const method of ["thread/attachment/list", "thread/queue/list", "thread/goal/get"])
        await request(method, { threadId });
      const resumed = await request("thread/resume", { threadId });
      report.checks.desktopHydration = resumed.thread.canAcceptDirectInput === true && resumed.thread.historyMode === "legacy";
    }
    const turns = resume || permissions || settings ? 2 : 1;
    for (let index = 0; index < turns; index++) {
      if (index && permissions) {
        // A denied request is intentionally not retried. Approval gets a fresh
        // test session so prior denial cannot suppress the new permission test.
        threadId = (await request("thread/start", { model: `mycodex/copilot/${model}`, cwd: workspace })).thread.id;
      } else if (index) await request("thread/resume", { threadId, ...(nativeDraft ? { model: "native-default" } : {}) });
      if (settings) await request("thread/settings/update", { threadId, reasoningEffort: index ? "low" : "high", cliApprovalMode: index ? "read-only" : "auto" });
      const expected = images ? "red" : index ? "CCODEX_COPILOT_RESUMED" : "CCODEX_COPILOT_OK";
      allowProbeWrite = permissions && index === 1;
      const prompt = permissions || interrupt || (settings && !index) ? `Using only apply_patch, add ${testFile} containing exactly CCODEX_PERMISSION_OK. Do not run shell commands, read other files, delegate, or use other tools. If permission is denied, stop without retrying or finding a workaround.`
        : images ? "Name the dominant color in the attached image. Reply with one English color word only. Do not use any tools, files, shell, search or delegation."
        : `Reply with exactly ${expected}. Do not use tools, read files, run commands, search, or modify anything.`;
      const { turn } = await request("turn/start", { threadId, input: [{ type: "text", text:
        prompt, text_elements: [] }, ...(images ? [{ type: "image", url: "data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAABAAAAAQCAIAAACQkWg2AAAAF0lEQVR4nGP4z8BAEiJN9aiGUQ1DSgMAkPn/Afnh+ngAAAAASUVORK5CYII=" }] : [])], ...(desktopEnvelope ? {
          permissions: ":danger-full-access", runtimeWorkspaceRoots: [workspace], approvalPolicy: "never", approvalsReviewer: "user",
          model: `mycodex/copilot/${model}`, effort: "none", summary: "detailed", multiAgentMode: "explicitRequestOnly",
          collaborationMode: { mode: "default", settings: { model: `mycodex/copilot/${model}`, reasoning_effort: "none", developer_instructions: null } },
        } : {}), ...(nativeDraft ? { model: "native-default", permissions: ":workspace-write", effort: "high" } : {}) });
      activeTurn = turn.id;
      const deadline = Date.now() + 90000;
      let interruptSent = false;
      while (!terminals.has(turn.id) && Date.now() < deadline) {
        if (interrupt && report.pendingApprovals && !interruptSent) {
          interruptSent = true;
          await request("turn/interrupt", { threadId, turnId: turn.id });
        }
        await new Promise(resolve => setTimeout(resolve, 100));
      }
      const terminal = terminals.get(turn.id);
      if (!terminal) { await request("turn/interrupt", { threadId, turnId: turn.id }); throw new Error("Real CLI text turn timed out; interrupt requested, no retry."); }
      activeTurn = null;
      if (terminal.status !== (interrupt ? "interrupted" : "completed")) throw new Error(terminal.error?.message || `CLI turn ended: ${terminal.status}`);
      if (interrupt) {
        report.checks.interruptedPendingApproval = interruptSent && report.pendingApprovals > 0;
        report.checks.onlyOneTerminal = terminalCounts.get(turn.id) === 1;
        report.checks.noActiveTurnAfterInterrupt = !gateway.protocol.active.has(threadId);
      } else if (settings) {
        (report.settingsReplies ??= []).push(terminal.items.filter(item => item.type === "agentMessage").map(item => item.text).join(""));
        if (!index) report.checks.automaticWriteWithoutUiPrompt = report.automaticApprovals > 0 && report.questionsAllowed === 0 && report.questionsDenied === 0 &&
          fs.existsSync(testFile) && fs.readFileSync(testFile, "utf8").trim() === "CCODEX_PERMISSION_OK";
        else report.checks.resumedReply = terminal.items.filter(item => item.type === "agentMessage").map(item => item.text).join("").trim() === expected;
      } else if (permissions) report.checks[index ? "approvedWrite" : "deniedWrite"] = index
        ? report.questionsAllowed > 0 && fs.existsSync(testFile) && fs.readFileSync(testFile, "utf8").trim() === "CCODEX_PERMISSION_OK"
        : report.questionsDenied > 0 && !fs.existsSync(testFile);
      else {
        const reply = terminal.items.filter(item => item.type === "agentMessage").map(item => item.text).join("").trim();
        report.checks[index ? "resumedReply" : images ? "imageReply" : "textReply"] = images ? reply.toLowerCase() === expected.toLowerCase() : reply === expected;
      }
    }
    const read = await request("thread/read", { threadId });
    report.checks.historyStored = read.thread.turns.length === (permissions ? 1 : turns) && read.thread.turns.every(turn => turn.status === (interrupt ? "interrupted" : "completed"));
    if (settings) {
      report.checks.runtimeReasoningOnCreateAndResume = report.runtimeEfforts[0]?.effort === "high" && report.runtimeEfforts[1]?.effort === "low";
      report.checks.savedSettings = read.thread.reasoningEffort === "low" && read.thread.cliApprovalMode === "read-only";
      report.checks.onlyProbeFile = fs.readdirSync(workspace).every(name => name === "probe.txt");
      report.checks.probeGuardUnused = report.probeGuardRejections === 0;
    } else if (permissions) report.checks.onlyProbeFile = fs.readdirSync(workspace).every(name => name === "probe.txt");
    else { if (!interrupt) report.checks.noTools = report.toolEvents === 0 && report.questionsDenied === 0;
      report.checks.workspaceUntouched = fs.readdirSync(workspace).length === 0; }
    report.checks.noNativeInference = report.nativeInferenceTurns === 0;
    report.passed = Object.values(report.checks).every(Boolean);
  } catch (error) { report.passed = false; report.error = error.message; }
  finally {
    if (activeTurn && gateway) gateway.protocol.active.get(threadId)?.controller.abort();
    if (router) await router.close(); else await native?.dispose?.();
    await gateway?.close(); fs.closeSync(log);
    for (const directory of [home, profile, workspace]) fs.rmSync(directory, { recursive: true, force: true });
  }
  fs.writeFileSync(path.join(root, "report.json"), JSON.stringify(report, null, 2) + "\n", { mode: 0o600 });
  return { root, report };
}
if (process.argv[1] && import.meta.url === pathToFileURL(path.resolve(process.argv[1])).href) {
  const [sdkPath, nativeCli, model, flag] = process.argv.slice(2);
  if (!sdkPath || !nativeCli || !model || (flag && !["--resume", "--permissions", "--interrupt", "--desktop-envelope", "--native-draft", "--settings", "--images"].includes(flag))) throw new Error("Usage: node tools/probe-cli-gateway.mjs <SDK entry> <native CLI> <catalog model> [--resume|--permissions|--interrupt|--desktop-envelope|--native-draft|--settings|--images]");
  probeCliGateway({ sdkPath, nativeCli, model, resume: ["--resume", "--desktop-envelope", "--native-draft", "--settings"].includes(flag), permissions: flag === "--permissions", interrupt: flag === "--interrupt", desktopEnvelope: flag === "--desktop-envelope", nativeDraft: ["--native-draft", "--settings", "--images"].includes(flag), settings: flag === "--settings", images: flag === "--images" }).then(({ root, report }) => {
    console.log(JSON.stringify({ reportFile: path.join(root, "report.json"), ...report }, null, 2));
    if (!report.passed) process.exitCode = 1;
  }, error => { console.error(error.message); process.exitCode = 1; });
}

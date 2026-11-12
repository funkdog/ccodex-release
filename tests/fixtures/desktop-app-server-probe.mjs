// Explicitly opt-in, deterministic R0 fixture. Never an installed backend.
import fs from "node:fs";
import path from "node:path";
import readline from "node:readline";

const root = process.env.CCODEX_APP_SERVER_PROBE_ROOT;
if (!root || path.resolve(process.env.CODEX_HOME || ".") !== path.join(root, "profile") ||
    !fs.existsSync(path.join(root, ".ccodex-probe"))) {
  process.stderr.write("The probe requires its own marked, isolated profile.\n");
  process.exit(2);
}
const trace = (entry) => fs.appendFileSync(path.join(root, "rpc-shapes.jsonl"),
  JSON.stringify({ pid: process.pid, ...entry }) + "\n", { mode: 0o600 });
const args = process.argv.slice(2);
trace({ kind: "launch", flags: args.filter(arg => arg.startsWith("--")),
  command: args.includes("app-server") ? "app-server" : "other" });
if (args.includes("--version")) {
  console.log("ccodex-r0-fixture 0.1.0");
  process.exit(0);
}
if (args.includes("--startup-sign-out")) process.exit(2);
if (args.includes("--print-startup-config")) {
  console.log(JSON.stringify({ appServerVersion: "0.165.0-alpha.1.2",
    configRequirements: { supportsIndependentSpeedModes: true, requirements: null } }));
  process.exit(0);
}
if (!args.includes("app-server")) process.exit(2);

const model = { id: "ccodex-r0-fixture", model: "ccodex-r0-fixture",
  displayName: "R0 fixture (no model calls)", description: "Deterministic protocol test only",
  hidden: false, isDefault: true, inputModalities: ["text"],
  supportedReasoningEfforts: [{ reasoningEffort: "none", description: "No inference" }],
  defaultReasoningEffort: "none" };
const thread = { id: "019a0000-0000-7000-8000-000000000001",
  sessionId: "019a0000-0000-7000-8000-000000000001", cliVersion: "ccodex-r0-fixture",
  createdAt: Math.floor(Date.now() / 1000), updatedAt: Math.floor(Date.now() / 1000),
  cwd: path.join(root, "workspace"), ephemeral: false, modelProvider: "ccodex-r0-fixture",
  model: model.model, preview: "R0 isolated gateway probe", name: "R0 isolated gateway probe",
  projectId: null, source: "appServer", status: { type: "idle" }, turns: [] };
const write = (message) => process.stdout.write(JSON.stringify(message) + "\n");
const notify = (method, params) => { trace({ kind: "notification", method }); write({ method, params }); };
const threadResult = () => ({ thread, model: model.model, modelProvider: thread.modelProvider,
  cwd: thread.cwd, approvalPolicy: "untrusted", approvalsReviewer: "user",
  sandbox: { type: "readOnly", networkAccess: false }, reasoningEffort: "none" });
const requireThread = (params) => {
  if (params.threadId !== thread.id) throw new Error("Unknown fixture thread");
};
let turnAccepted = false;
const handlers = {
  initialize: () => ({ userAgent: "ccodex-r0-fixture/0.1.0",
    platformFamily: "unix", platformOs: "macos", codexHome: process.env.CODEX_HOME }),
  "account/read": () => ({ account: null, requiresOpenaiAuth: false }),
  getAuthStatus: () => ({ authMethod: null, authToken: null, requiresOpenaiAuth: false }),
  "configRequirements/read": () => ({ requirements: null, supportsIndependentSpeedModes: true }),
  "config/read": () => ({ config: { model: model.model, model_provider: "ccodex-r0-fixture",
    analytics: { enabled: false }, features: {} }, origins: {}, layers: [] }),
  "model/list": () => ({ data: [model], nextCursor: null }),
  "thread/list": () => ({ data: [{ ...thread, turns: [] }], nextCursor: null }),
  "thread/start": () => {
    setTimeout(() => notify("thread/started", { thread: { ...thread, turns: [] } }), 10);
    return threadResult();
  },
  "thread/read": (params) => { requireThread(params); return { thread }; },
  "thread/turns/list": (params) => { requireThread(params); return { data: thread.turns, nextCursor: null, backwardsCursor: null }; },
  "thread/items/list": (params) => { requireThread(params); return { data: [], nextCursor: null, backwardsCursor: null }; },
  "thread/resume": (params) => { requireThread(params); return threadResult(); },
  "turn/start": (params) => {
    requireThread(params);
    // Desktop may wrap the composer text in a request/context envelope. The
    // fixture only recognizes the sentinel line and never executes any context.
    if (!Array.isArray(params.input) || !params.input.every(item => item.type === "text") ||
        !params.input.some(item => item.text?.split("\n").some(line => line.trim() === "CCODEX_R0_SYNTHETIC_PING"))) {
      throw new Error("Only CCODEX_R0_SYNTHETIC_PING is allowed in the fixture");
    }
    if (turnAccepted) throw new Error("This fixture supports only one synthetic turn per process");
    turnAccepted = true;
    const turn = { id: "019a0000-0000-7000-8000-000000000002", status: "inProgress", items: [] };
    const item = { id: "r0-answer", type: "agentMessage", text: "", phase: "final_answer" };
    const context = { threadId: thread.id, turnId: turn.id };
    setTimeout(() => {
      notify("turn/started", { threadId: thread.id, turn: { ...turn } });
      notify("item/started", { ...context, item: { ...item }, startedAtMs: Date.now() });
      item.text = "CCODEX_R0_SYNTHETIC_OK — independent app-server; no model calls.";
      notify("item/agentMessage/delta", { ...context, itemId: item.id, delta: item.text });
      notify("item/completed", { ...context, item, completedAtMs: Date.now() });
      turn.status = "completed";
      turn.items = [item];
      thread.turns = [turn];
      notify("turn/completed", { threadId: thread.id, turn });
      notify("thread/status/changed", { threadId: thread.id, status: { type: "idle" } });
    }, 100);
    return { turn };
  },
  "thread/loaded/list": () => ({ data: [], nextCursor: null }),
  "skills/list": () => ({ data: [] }),
  "mcpServerStatus/list": () => ({ data: [], nextCursor: null }),
  "experimentalFeature/list": () => ({ data: [], nextCursor: null }),
  "collaborationMode/list": () => ({ data: [] }),
  "permissionProfile/list": () => ({ data: [], nextCursor: null }),
  "plugin/list": () => ({ marketplaces: [], marketplaceLoadErrors: [], featuredPluginIds: [] }),
};
// Desktop 26.1023.50603 uses this extension, absent from its bundled CLI's
// generated public schema. Only the one synthetic admission is implemented.
handlers["turn/addUserMessage"] = params => ({ ...handlers["turn/start"](params), admissionOutcome: "started" });
const lines = readline.createInterface({ input: process.stdin });
for await (const line of lines) {
  let request;
  try { request = JSON.parse(line); } catch { continue; }
  trace({ kind: "rpc", method: request.method ?? "response",
    paramKeys: Object.keys(request.params || {}), hasId: Object.hasOwn(request, "id") });
  if (!Object.hasOwn(request, "id")) continue;
  const handler = Object.hasOwn(handlers, request.method) && handlers[request.method];
  try {
    write(handler ? { id: request.id, result: handler(request.params || {}) }
      : { id: request.id, error: { code: -32601, message: "Unsupported by R0 fixture" } });
  } catch (error) {
    write({ id: request.id, error: { code: -32602, message: error.message } });
  }
}

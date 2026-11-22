import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import http from "node:http";
import { spawn } from "node:child_process";
import { randomUUID } from "node:crypto";
import { pathToFileURL } from "node:url";
import { SquadV2Kernel } from "../gateway/spine/squad-v2-kernel.mjs";
import { git } from "../gateway/spine/squad-v2-workspace.mjs";
import { hasActiveNativeSubagents } from "../gateway/squad-native-peer.mjs";
import { renderSquadStudioHtml } from "../bridge/diy/squad-studio.mjs";
import { conversationSquadCardResource } from "../bridge/diy/squad-card.mjs";
import { createResponsesWriter, buildChatRequest } from "../bridge/translate.mjs";
import { RpcPeer } from "../gateway/rpc-peer.mjs";
import { connectGateway, readMessages, writeMessage } from "../gateway/ipc.mjs";
import { squadFixture } from "./squad-flow-fixture.mjs";
import { attachSquadNative } from "./squad-native-fixture.mjs";

const root = path.resolve(import.meta.dirname, "..");
const delay = ms => new Promise(resolve => setTimeout(resolve, ms));

async function kernelFixture(t) {
  const home = await fs.mkdtemp(path.join(await fs.realpath(os.tmpdir()), "squad-v2-adv-"));
  const threads = new Map([["anchor", { id: "anchor", cwd: home, status: { type: "active" } }]]);
  let count = 0;
  const kernel = new SquadV2Kernel(home, {
    read: async id => threads.get(id),
    create: async (_slot, cwd) => { const thread = { id: "worker-" + (++count), cwd, status: { type: "idle" } }; threads.set(thread.id, thread); return thread; },
    send: async thread => { thread.status = { type: "active" }; },
  }, () => {});
  t.after(async () => { await kernel.shutdown(); await fs.rm(home, { recursive: true, force: true }); });
  const initial = await kernel.init({ anchorThreadId: "anchor", intent: "Adversarial regression fixture" });
  return { home, threads, kernel, squadId: initial.squadId };
}

async function writeResult(f, slot, status = "done") {
  const file = path.join(f.home, ".mycodex", "squads-v2", f.squadId, "slots", slot.slotId, ".mycodex", "result.md");
  await delay(20);
  await fs.writeFile(file, `status: ${status}\nsummary: ORIGINAL_REPORT\n\n## Assumptions & Trade-offs\n- ORIGINAL_ASSUMPTION\n`);
}

test("F2a: active subagent remains detected even after >190KB nonterminal output", async t => {
  const home = await fs.mkdtemp(path.join(os.tmpdir(), "squad-adv-probe-"));
  t.after(() => fs.rm(home, { recursive: true, force: true }));
  const parentId = randomUUID(), childId = randomUUID(), parent = path.join(home, "rollout-parent.jsonl");
  const child = path.join(home, "rollout-child.jsonl");
  const lines = [
    { type: "session_meta", payload: { id: childId, parent_thread_id: parentId, source: { subagent: "worker" } } },
    { type: "event_msg", payload: { type: "task_started", turn_id: "active-turn" } },
  ];
  await fs.writeFile(child, lines.map(x => JSON.stringify(x)).join("\n") + "\n");
  const filler = JSON.stringify({ type: "event_msg", payload: { type: "agent_message", message: "x".repeat(2048) } }) + "\n";
  await fs.appendFile(child, filler.repeat(95));
  assert.equal(hasActiveNativeSubagents(parent, parentId), true);
  await fs.appendFile(child, JSON.stringify({ type: "event_msg", payload: { type: "task_complete", turn_id: "active-turn" } }) + "\n");
  assert.equal(hasActiveNativeSubagents(parent, parentId), false);
});

test("F2b: active subagent in subsequent date directory is detected", async t => {
  const home = await fs.mkdtemp(path.join(os.tmpdir(), "squad-adv-date-"));
  t.after(() => fs.rm(home, { recursive: true, force: true }));
  const previous = path.join(home, "sessions", "2026", "11", "16"), current = path.join(home, "sessions", "2026", "11", "17");
  await fs.mkdir(previous, { recursive: true }); await fs.mkdir(current, { recursive: true });
  const parentId = randomUUID();
  const childFile = path.join(current, "rollout-child.jsonl");
  await fs.writeFile(childFile, [
    { type: "session_meta", payload: { id: randomUUID(), parent_thread_id: parentId, source: { subagent: "worker" } } },
    { type: "event_msg", payload: { type: "task_started", turn_id: "still-running" } },
  ].map(x => JSON.stringify(x)).join("\n") + "\n");
  assert.equal(hasActiveNativeSubagents(path.join(previous, "rollout-parent.jsonl"), parentId), true);
  await fs.appendFile(childFile, JSON.stringify({ type: "event_msg", payload: { type: "turn_aborted", turn_id: "still-running" } }) + "\n");
  assert.equal(hasActiveNativeSubagents(path.join(previous, "rollout-parent.jsonl"), parentId), false);
});

test("F3: Studio /diff rejects intermediate directory symlinks escaping the worktree", async t => {
  const f = await kernelFixture(t);
  await git(f.home, "init", "-b", "main");
  await git(f.home, "config", "user.email", "review@example.invalid");
  await git(f.home, "config", "user.name", "Verifier");
  await fs.writeFile(path.join(f.home, ".gitignore"), ".mycodex/\nnode_modules\n");
  await fs.writeFile(path.join(f.home, "owned.txt"), "base\n");
  await git(f.home, "add", ".gitignore", "owned.txt");
  await git(f.home, "commit", "-m", "base");
  const snap = await f.kernel.dispatch({ squadId: f.squadId, slots: [{ slotId: "worker", task: "inspect", touches: ["owned.txt"], workspace: "worktree" }] });
  const outside = await fs.mkdtemp(path.join(os.tmpdir(), "squad-adv-outside-"));
  t.after(() => fs.rm(outside, { recursive: true, force: true }));
  await fs.writeFile(path.join(outside, "private.txt"), "OWNED_SYNTHETIC_SECRET\n");
  await fs.symlink(outside, path.join(snap.slots[0].worktreePath, "linked-private"), "dir");
  const url = new URL(snap.studioUrl);
  url.pathname += "/diff";
  url.searchParams.set("slotId", "worker");
  url.searchParams.set("path", "linked-private/private.txt");
  const res = await fetch(url);
  assert.equal(res.status, 409);
  const body = await res.text();
  assert.doesNotMatch(body, /OWNED_SYNTHETIC_SECRET/);
});

test("F4 & F5: promoting preserves completed report/assumptions, and explicit blocked report populates Needs You", async t => {
  const f = await kernelFixture(t);
  const snap = await f.kernel.dispatch({ squadId: f.squadId, slots: [
    { slotId: "expert", task: "deliver", touches: [] },
    { slotId: "blocker", task: "blocked-task", touches: [] },
  ] });
  for (const s of snap.slots) f.threads.get(s.threadId).status = { type: "idle" };
  await writeResult(f, snap.slots[0], "done");
  await writeResult(f, snap.slots[1], "blocked");
  await delay(25);
  const promoted = await f.kernel.promote({ squadId: f.squadId, slotId: "expert" });
  const expert = promoted.slots.find(s => s.slotId === "expert");
  assert.equal(expert.sidebarHidden, false);
  assert.equal(expert.result.summary, "ORIGINAL_REPORT");
  assert.deepEqual(expert.result.assumptions, ["- ORIGINAL_ASSUMPTION"]);
  assert.equal(Boolean(expert.result.autoSynthesized), false);
  assert.equal(promoted.needsYou.some(item => item.slotId === "blocker"), true);
});

test("F6: stateful redispatch rejects silent model/engine mutation", async t => {
  const f = await squadFixture(t);
  f.gateway.protocol.engines.set("second", { adapter: "second", models: async () => [{ id: "model", name: "Other" }], run: async ctx => ctx.onText("second") });
  f.gateway.protocol.catalogPromise = null;
  const anchor = await f.createThread();
  const initial = await f.call("diy/squad/create", { v2: true, anchorThreadId: anchor.id, intent: "model truth" });
  const first = await f.call("diy/squad/dispatch", { v2: true, squadId: initial.squadId, slots: [{ slotId: "same", task: "first", touches: [], model: "fixture/model" }] });
  await f.gateway.protocol.active.get(first.slots[0].threadId)?.done;
  await assert.rejects(
    f.call("diy/squad/dispatch", { v2: true, squadId: initial.squadId, slots: [{ slotId: "same", task: "second", touches: [], model: "second/model" }] }),
    /Stateful slot retains its bound engine, model/,
  );
});

test("F7: STATE.md, Studio view and inline card agree on criterion verification semantics", async t => {
  const runtime = process.env.MYCODEX_TEST_PLAYWRIGHT ?? "/Applications/ChatGPT.app/Contents/Resources/cua_node/lib/node_modules/playwright/index.mjs";
  const browserBin = process.env.MYCODEX_TEST_BROWSER ?? "/Applications/Google Chrome.app/Contents/MacOS/Google Chrome";
  try { await fs.access(runtime); await fs.access(browserBin); } catch { t.skip("Playwright/Chrome unavailable"); return; }
  const f = await kernelFixture(t);
  const snap = await f.kernel.state({
    squadId: f.squadId,
    expectedRevision: 1,
    patch: {
      criteria: [
        { id: "C-by", text: "Verified by handle", verifiedBy: "@verifier" },
        { id: "C-at", text: "Verified by timestamp", verifiedAt: Date.now() },
        { id: "C-open", text: "Pending criterion" },
      ],
    },
  });
  const md = await fs.readFile(path.join(f.home, ".mycodex", "squads-v2", f.squadId, "STATE.md"), "utf8");
  assert.match(md, /- \[x\] C-by/);
  assert.match(md, /- \[x\] C-at/);
  assert.match(md, /- \[ \] C-open/);
  const { chromium } = await import(pathToFileURL(runtime).href);
  const browser = await chromium.launch({ executablePath: browserBin, headless: true });
  t.after(() => browser.close());
  const page = await browser.newPage();
  await page.setContent(renderSquadStudioHtml(snap));
  await page.waitForSelector(".criterion-row");
  assert.equal(await page.locator(".completed-criteria").getAttribute("open"), null);
  assert.equal(await page.locator(".criterion-row:visible").count(), 1);
  assert.match(await page.locator(".criterion-row:visible").innerText(), /Pending criterion/);
  await page.locator(".completed-criteria summary").click();
  const studioStates = await page.locator(".criterion-row").evaluateAll(rows => Object.fromEntries(rows.map(r => [r.querySelector(".criterion-id").textContent, r.classList.contains("is-done")])));
  assert.deepEqual(studioStates, { "C-by": true, "C-at": true, "C-open": false });
  await page.addInitScript(value => { window.openai = { toolOutput: value }; }, snap);
  await page.route("http://card.invalid/**", route => route.fulfill({ contentType: "text/html", body: conversationSquadCardResource().text }));
  await page.goto("http://card.invalid/");
  assert.equal(await page.locator(".mc-criteria-fold").getAttribute("open"), null);
  await page.locator(".mc-criteria-fold summary").click();
  await page.waitForSelector(".mc-criterion");
  const cardStates = await page.locator(".mc-criterion").evaluateAll(rows => rows.map(r => r.classList.contains("is-done")));
  assert.deepEqual(cardStates, [true, true, false]);
});

test("F1: native V2 worker receives zero squad_* MCP tools and cannot mutate orchestrator STATE", { timeout: 30000 }, async t => {
  const executable = process.env.MYCODEX_TEST_NATIVE_CLI ?? "/Applications/ChatGPT.app/Contents/Resources/codex-cli/CodexCLI.app/Contents/MacOS/codex";
  try { await fs.access(executable); } catch { t.skip("Native CLI unavailable"); return; }
  const cleanups = [], f = await squadFixture({ after: fn => cleanups.push(fn) });
  t.after(async () => { for (const fn of cleanups.reverse()) await fn(); });
  let workerCalls = 0, workerSquadTools = [];
  const provider = http.createServer(async (req, res) => {
    if (req.method !== "POST" || req.url !== "/responses") { res.writeHead(404).end(); return; }
    const parts = []; for await (const chunk of req) parts.push(chunk);
    const body = JSON.parse(Buffer.concat(parts));
    const translated = buildChatRequest(body, {});
    if (JSON.stringify(body.input).includes("INSPECT_WORKER_TOOLS")) {
      workerCalls++;
      const names = (translated.body.tools ?? []).map(x => x.function?.name).filter(Boolean);
      workerSquadTools = names.filter(x => x.includes("squad_"));
    }
    const writer = createResponsesWriter(res, body, translated.toolKinds);
    writer.pushChunk({ choices: [{ delta: { content: "WORKER_FINISHED" } }] });
    writer.finish();
  });
  await new Promise(resolve => provider.listen(0, "127.0.0.1", resolve));
  cleanups.push(() => new Promise(resolve => provider.close(resolve)));
  const profile = path.join(f.home, "native-profile");
  await fs.mkdir(profile, { mode: 0o700 });
  await fs.writeFile(path.join(profile, "config.toml"), `model="verifier-local"\nmodel_provider="verifier-local"\ncli_auth_credentials_store="file"\ncheck_for_update_on_startup=false\n[features]\napps=false\nplugins=false\nremote_plugin=false\n[model_providers.verifier-local]\nname="Local provider"\nbase_url="http://127.0.0.1:${provider.address().port}"\nwire_api="responses"\nrequires_openai_auth=false\nsupports_websockets=false\n`);
  const connection = path.join(f.home, "connection.json");
  await fs.writeFile(connection, JSON.stringify({ ...f.config, engines: [], spine: { mcp: true } }), { mode: 0o600 });
  const child = spawn(process.execPath, [path.join(root, "gateway/routed-stdio.mjs"), "app-server"], {
    cwd: f.home,
    env: { PATH: process.env.PATH, HOME: f.home, CODEX_HOME: profile, CCODEX_NATIVE_CLI: executable, CCODEX_GATEWAY_CONNECTION: connection },
    stdio: ["pipe", "pipe", "pipe"],
  });
  const peer = new RpcPeer(message => writeMessage(child.stdin, message));
  readMessages(child.stdout, message => peer.receive(message), error => peer.close(error));
  const exited = new Promise(resolve => child.once("exit", code => { peer.close(); resolve(code); }));
  cleanups.push(async () => { child.stdin.end(); const timer = setTimeout(() => child.kill("SIGKILL"), 2500); await exited; clearTimeout(timer); });
  await peer.request("initialize", { clientInfo: { name: "f1-check", version: "1" }, capabilities: { experimentalApi: true } }, { timeoutMs: 5000 });
  peer.notify({ method: "initialized" });
  let binding;
  const deadline = Date.now() + 10000;
  do { binding = (await f.call("diy/host/status")).bindings.find(x => x.squad); if (!binding) await delay(25); } while (!binding && Date.now() < deadline);
  assert(binding);
  const anchor = (await peer.request("thread/start", { cwd: f.home, model: "verifier-local", approvalPolicy: "never", sandbox: "workspace-write" })).thread;
  const initial = await f.call("diy/squad/create", {
    v2: true,
    anchorThreadId: anchor.id,
    anchorHostRef: { hostId: binding.hostId, accountId: binding.accountId, runtimeId: binding.runtimeId, threadId: anchor.id },
    intent: "ORCHESTRATOR_ORIGINAL_INTENT",
  });
  await f.call("diy/squad/dispatch", {
    v2: true,
    squadId: initial.squadId,
    slots: [{ slotId: "clean-reviewer", continuity: "clean", engine: "native", model: "verifier-local", task: "UNPROJECTED_ORCHESTRATOR_TASK", artifacts: ["INSPECT_WORKER_TOOLS"], touches: [] }],
  });
  const end = Date.now() + 14000;
  let state;
  do { state = await f.call("diy/squad/list", { v2: true, squadId: initial.squadId }); if (workerCalls > 0 && state.slots[0].activity === "quiescent") break; await delay(40); } while (Date.now() < end);
  assert.equal(workerCalls, 1);
  assert.deepEqual(workerSquadTools, [], "Native worker must not inherit any mycodex.squad_* tools");
  const reviewThread = (await peer.request("thread/read", { threadId: state.slots[0].threadId, includeTurns: false })).thread;
  const reviewRollout = (await fs.readFile(reviewThread.path, "utf8")).trim().split("\n").map(line => JSON.parse(line));
  const reviewContext = reviewRollout.findLast(row => row.type === "turn_context");
  assert.equal(reviewContext?.payload?.sandbox_policy?.type, "read-only");
  assert.equal(state.state.intent, "ORCHESTRATOR_ORIGINAL_INTENT");
  assert.equal(state.state.revision, 1);
  const workerConfig = JSON.parse(await fs.readFile(path.join(f.home, ".mycodex", "squad-worker-client.json"), "utf8"));
  assert.notEqual(workerConfig.token, f.config.token);
  let workerSocket;
  const workerPeer = new RpcPeer(message => writeMessage(workerSocket, message));
  workerSocket = await connectGateway(workerConfig, message => workerPeer.receive(message));
  cleanups.push(async () => { workerSocket.destroy(); workerPeer.close(); });
  await workerPeer.request("initialize", { clientInfo: { name: "worker-rpc-attempt", version: "1" } }, { timeoutMs: 5000 });
  await assert.rejects(
    workerPeer.request("diy/squad/summarize", { v2: true, squadId: initial.squadId, expectedRevision: 1, patch: { intent: "BYPASS_ATTEMPT" } }, { timeoutMs: 5000 }),
    /Squad worker channel cannot perform orchestrator/,
  );
  const afterAttempt = await f.call("diy/squad/list", { v2: true, squadId: initial.squadId });
  assert.equal(afterAttempt.state.intent, "ORCHESTRATOR_ORIGINAL_INTENT");
  assert.equal(afterAttempt.state.revision, 1);
});

test("Phase 3 Studio previews only exact slot registrations and commits from the bound repository", async t => {
  const f = await kernelFixture(t);
  await git(f.home, "init", "-b", "main");
  await git(f.home, "config", "user.email", "review@example.invalid");
  await git(f.home, "config", "user.name", "Verifier");
  await git(f.home, "remote", "add", "origin", "git@gitlab.example:group/repo.git");
  await fs.writeFile(path.join(f.home, "tracked.txt"), "base\n");
  await git(f.home, "add", "tracked.txt");
  await git(f.home, "commit", "-m", "Bound SHA");
  const sha = await git(f.home, "rev-parse", "HEAD");
  const wide = "abc你好\n".repeat(32_000);
  await fs.writeFile(path.join(f.home, "report.md"), wide);
  await fs.writeFile(path.join(f.home, "binary.log"), Buffer.concat([Buffer.alloc(260 * 1024, 65), Buffer.from([0])]));
  await fs.writeFile(path.join(f.home, "unlisted.txt"), "private fixture");
  await fs.writeFile(path.join(f.home, "brief.md"), "private brief");
  await fs.mkdir(path.join(f.home, "directory.txt"));
  await fs.symlink(path.join(f.home, "unlisted.txt"), path.join(f.home, "linked.txt"));
  const outside = await fs.mkdtemp(path.join(await fs.realpath(os.tmpdir()), "squad-artifact-outside-"));
  t.after(() => fs.rm(outside, { recursive: true, force: true }));
  await fs.writeFile(path.join(outside, "secret.txt"), "private fixture");
  await fs.symlink(outside, path.join(f.home, "linked"));
  const otherRepo = path.join(f.home, "clone");
  await git(f.home, "init", "-b", "main", otherRepo);
  await git(otherRepo, "remote", "add", "origin", "https://github.com/second/project.git");
  await git(otherRepo, "-c", "user.name=Other", "-c", "user.email=other@example.invalid", "commit", "--allow-empty", "-m", "Other repository object");
  const otherSha = await git(otherRepo, "rev-parse", "HEAD");

  const slot = id => ({ slotId: id, task: "inspect", touches: [] });
  const dispatched = await f.kernel.dispatch({ squadId: f.squadId, slots: [slot("builder"), slot("other")] });
  const builder = dispatched.slots.find(s => s.slotId === "builder");
  f.threads.get(builder.threadId).status = { type: "idle" };
  const reply = path.join(f.home, ".mycodex", "squads-v2", f.squadId, "slots", "builder", ".mycodex", "result.md");
  await delay(10);
  await fs.writeFile(reply, "status: done\nsummary: See group/repo!83 and #12.\n\n## Deliverables\n- [report] Original report | ./report.md\n\n## Assumptions & Trade-offs\n- local fixture\n");
  const initial = await f.kernel.status({ squadId: f.squadId });
  const reportPreview = initial.slots.find(s => s.slotId === "builder").deliverables.find(d => d.kind === "report");
  assert.equal(reportPreview.previewRef, "file:./report.md");
  const request = (ref, slotId = "builder", token) => {
    const url = new URL(dispatched.studioUrl);
    url.pathname += "/artifact";
    url.searchParams.set("ref", ref);
    url.searchParams.set("slotId", slotId);
    if (token !== undefined) url.searchParams.set("token", token);
    return fetch(url);
  };
  const immediate = await request(reportPreview.previewRef);
  assert.equal(immediate.status, 200);
  const large = await immediate.json();
  assert.equal(large.kind, "markdown");
  assert.equal(large.truncated, true);
  assert.ok(Buffer.byteLength(large.content) <= 256 * 1024);
  assert.ok(wide.startsWith(large.content));

  await f.kernel.state({ squadId: f.squadId, expectedRevision: 1, slotDeliverables: { builder: [
    { kind: "commit", label: "Bound commit", target: sha.slice(0, 12) },
    { kind: "commit", label: `clone@${otherSha}`, target: otherRepo },
    { kind: "commit", label: "Unbound commit", target: otherSha },
    { kind: "branch", label: "Local new branch", target: "new-local" },
    { kind: "mr", label: "!7", target: otherRepo },
    { kind: "mr", label: "repo!99" },
    ...["brief.md", reply, "directory.txt", "linked.txt", "linked/secret.txt", "../unlisted.txt", "binary.log"].map(target => ({ kind: "artifact", label: target, target })),
  ] } });
  const second = await f.kernel.status({ squadId: f.squadId });
  const outputs = second.slots.find(s => s.slotId === "builder").deliverables;
  assert.equal(outputs.find(d => d.label === "group/repo!83")?.href, "https://gitlab.example/group/repo/-/merge_requests/83");
  assert.equal(outputs.find(d => d.label === "repo!99")?.href, "https://gitlab.example/group/repo/-/merge_requests/99");
  assert.equal(outputs.find(d => d.label === "#12")?.href, "https://gitlab.example/group/repo/-/issues/12");
  assert.equal(outputs.find(d => d.label === "!7")?.href, "https://github.com/second/project/pull/7");
  assert.equal(outputs.find(d => d.label === "Bound commit")?.previewRef, "commit:" + sha);
  assert.equal(outputs.find(d => d.label === `clone@${otherSha}`)?.previewRef, `commit:${otherSha}@${otherRepo}`);
  for (const label of ["Local new branch", "Bound commit", "Unbound commit"]) assert.equal(outputs.find(d => d.label === label)?.href, undefined);
  assert.equal(outputs.find(d => d.label === "binary.log")?.previewKind, undefined);

  const commit = await request("commit:" + sha);
  assert.equal(commit.status, 200);
  const patch = await commit.json();
  assert.equal(patch.kind, "commit");
  assert.match(patch.content, /Bound SHA[\s\S]*\+base/);
  const cloneCommit = await request(`commit:${otherSha}@${otherRepo}`);
  assert.equal(cloneCommit.status, 200);
  assert.match((await cloneCommit.json()).content, /Other repository object/);
  for (const [ref, id, token] of [
    ["file:./report.md", "other"], ["file:report.md"], ["file:unlisted.txt"], ["file:../unlisted.txt"],
    ["file:linked.txt"], ["file:linked/secret.txt"], ["file:brief.md"], ["file:" + reply],
    ["file:directory.txt"], ["file:binary.log"], ["commit:HEAD"], ["commit:--help"], ["commit:" + otherSha],
    [`commit:${otherSha}@${outside}`], [`commit:${otherSha}@${otherRepo}`, "other"],
    ["file:./report.md", "builder", "untrusted-token"],
  ]) {
    const denied = await request(ref, id, token);
    assert.equal(denied.status, 409, ref);
    assert.equal(typeof (await denied.json()).error, "string");
  }

  await f.kernel.dispatch({ squadId: f.squadId, slots: [slot("builder")] });
  assert.equal((await request(reportPreview.previewRef)).status, 200, "A prior wave remains registered after redispatch");
});

test("Phase 3 Studio reloads the compiled renderer by mtime on the same HTTP listener", async t => {
  const f = await kernelFixture(t);
  const isolated = path.join(f.home, "runtime");
  await fs.mkdir(path.join(isolated, "gateway", "spine"), { recursive: true });
  await fs.mkdir(path.join(isolated, "bridge", "diy"), { recursive: true });
  for (const name of ["squad-v2-kernel", "squad-v2-state", "squad-v2-workspace"]) {
    await fs.copyFile(path.join(root, "gateway", "spine", name + ".mjs"), path.join(isolated, "gateway", "spine", name + ".mjs"));
  }
  const renderer = path.join(isolated, "bridge", "diy", "squad-studio.mjs");
  const writeRenderer = html => fs.writeFile(renderer, `export function renderSquadStudioHtml() { return ${JSON.stringify(html)}; }`);
  await writeRenderer("first compiled renderer");
  const { SquadV2Kernel: Kernel } = await import(pathToFileURL(path.join(isolated, "gateway", "spine", "squad-v2-kernel.mjs")).href);
  const kernel = new Kernel(path.join(f.home, "profile"), { read: async id => ({ id, cwd: f.home, status: { type: "idle" } }) }, () => {});
  try {
    const initial = await kernel.init({ anchorThreadId: "anchor" });
    const render = async () => (await fetch(initial.studioUrl, { headers: { Accept: "text/html" } })).text();
    assert.equal(await render(), "first compiled renderer");
    await writeRenderer("second compiled renderer");
    await fs.utimes(renderer, new Date(), new Date(Date.now() + 1000));
    assert.equal(await render(), "second compiled renderer");
    assert.equal((await kernel.status({ squadId: initial.squadId })).studioUrl, initial.studioUrl);
  } finally { await kernel.shutdown(); }
});

test("Phase 4 passes read-only policy to native threads and turns, and unsupported CLI adapters fail closed", async t => {
  const f = await squadFixture(t);
  const calls = [];
  const native = await attachSquadNative(t, f, { beforeRequest: (method, params) => calls.push({ method, params }) });
  const anchor = await native.create();
  const binding = (await f.call("diy/host/status")).bindings.find(item => item.squad);
  const initial = await f.call("diy/squad/create", { v2: true, anchorThreadId: anchor.id,
    anchorHostRef: { hostId: binding.hostId, accountId: binding.accountId, runtimeId: binding.runtimeId, threadId: anchor.id } });
  const review = (await f.call("diy/squad/dispatch", { v2: true, squadId: initial.squadId, slots: [
    { slotId: "review", task: "Review", engine: "native", continuity: "clean", model: "native-model" },
  ] })).slots[0];
  assert.equal(review.readOnly, true);
  assert.equal(calls.filter(call => call.method === "thread/start").at(-1).params.sandbox, "read-only");
  assert.deepEqual(calls.filter(call => call.method === "turn/start").at(-1).params.sandboxPolicy, { type: "readOnly" });

  const cliAnchor = await f.createThread();
  const cliSquad = await f.call("diy/squad/create", { v2: true, anchorThreadId: cliAnchor.id });
  await assert.rejects(f.call("diy/squad/dispatch", { v2: true, squadId: cliSquad.squadId, slots: [
    { slotId: "cli", task: "Review", engine: "cli", model: "fixture/model", readOnly: true },
  ] }), /no Codex OS sandbox/);
  assert.equal(f.gateway.protocol.store.all().length, 1);
  assert.equal(f.prompts.length, 0);
});

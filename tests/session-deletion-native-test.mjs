import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { CodexRpc, codexBackend, threadWriterOwnership } from "../tools/history/backends.mjs";
import { HistoryManager } from "../tools/history/manager.mjs";
import { SessionManagement } from "../bridge/session-management.mjs";
import { runSessions } from "../bridge/sessions-cli.mjs";

const core = process.env.CCODEX_TEST_NATIVE_CORE;

function seed(home, cwd, label, parentId = null) {
  const id = randomUUID(), turnId = randomUUID(), timestamp = new Date().toISOString();
  const source = parentId
    ? { subagent: { thread_spawn: { parent_thread_id: parentId, depth: 1,
      agent_nickname: "Synthetic child", agent_role: "explorer" } } } : "cli";
  const records = [
    { type: "session_meta", payload: { id, session_id: id, timestamp, cwd, source,
      originator: "ccodex-delete-test", cli_version: "0.145.0", model_provider: "synthetic",
      base_instructions: { text: "Isolated history test only." }, history_mode: "legacy" } },
    { type: "event_msg", payload: { type: "task_started", turn_id: turnId, model_context_window: 100000 } },
    { type: "event_msg", payload: { type: "user_message", message: label,
      images: [], local_images: [], text_elements: [] } },
    { type: "response_item", payload: { type: "message", role: "user",
      content: [{ type: "input_text", text: label }] } },
    { type: "event_msg", payload: { type: "agent_message", message: "Synthetic saved answer.", phase: "final_answer" } },
    { type: "response_item", payload: { type: "message", id: "msg_synthetic", role: "assistant",
      phase: "final_answer", content: [{ type: "output_text", text: "Synthetic saved answer." }] } },
    { type: "event_msg", payload: { type: "task_complete", turn_id: turnId,
      last_agent_message: "Synthetic saved answer." } },
  ];
  const directory = path.join(home, "sessions", ...timestamp.slice(0, 10).split("-"));
  fs.mkdirSync(directory, { recursive: true });
  const file = path.join(directory, `rollout-${timestamp.slice(0, 19).replaceAll(":", "-")}-${id}.jsonl`);
  fs.writeFileSync(file, records.map(row => JSON.stringify({ timestamp, ...row })).join("\n") + "\n");
  return { id, file, key: "ccodex:" + id };
}

function rolloutFiles(home, id) {
  const found = [];
  const visit = directory => {
    if (!fs.existsSync(directory)) return;
    for (const entry of fs.readdirSync(directory, { withFileTypes: true })) {
      const file = path.join(directory, entry.name);
      assert(!entry.isSymbolicLink(), "An isolated fixture must not follow links");
      if (entry.isDirectory()) visit(file);
      else if (entry.isFile() && entry.name.endsWith(`-${id}.jsonl`)) found.push(file);
    }
  };
  for (const name of ["sessions", "archived_sessions"]) visit(path.join(home, name));
  return found;
}

test("installed native API permanently deletes isolated history, not project files, and protects active/descendant histories", {
  skip: !core, timeout: 180000,
}, async t => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "ccodex-permanent-delete-"));
  const home = path.join(root, "profile"), project = path.join(root, "project");
  fs.mkdirSync(home);
  fs.mkdirSync(project);
  const keep = path.join(project, "keep.txt");
  fs.writeFileSync(keep, "Synthetic project content must survive all history operations.");
  fs.writeFileSync(path.join(home, "config.toml"), [
    'model = "synthetic-model"', 'model_provider = "synthetic"',
    'approval_policy = "never"', 'sandbox_mode = "read-only"',
    'cli_auth_credentials_store = "file"', 'mcp_oauth_credentials_store = "file"',
    'check_for_update_on_startup = false',
    '[model_providers.synthetic]', 'name = "Isolated history test"',
    'base_url = "http://127.0.0.1:1"', 'wire_api = "responses"',
    'requires_openai_auth = false', '[features]', 'plugins = false',
    'remote_plugin = false', 'apps = false', "",
  ].join("\n"));
  const idle = seed(home, project, "SYNTHETIC_IDLE_DELETE");
  const archived = seed(home, project, "SYNTHETIC_ARCHIVED_DELETE");
  const held = seed(home, project, "SYNTHETIC_ACTIVE_PROTECTED");
  const parent = seed(home, project, "SYNTHETIC_PARENT_PROTECTED");
  const child = seed(home, project, "SYNTHETIC_CHILD_PROTECTED", parent.id);
  const grandchild = seed(home, project, "SYNTHETIC_GRANDCHILD_PROTECTED", child.id);
  const expectedIds = [idle, archived, held, parent, child, grandchild].map(row => row.id).sort();
  const clients = [];
  let service;
  const checks = [];
  const startedAt = Date.now();
  let text = "";
  try {
    const owner = new CodexRpc(core, home);
    clients.push(owner);
    await owner.initialize();
    const metadata = new CodexRpc(core, home);
    clients.push(metadata);
    await metadata.initialize();
    const backend = await codexBackend({ home, rpc: metadata, nativeWriterLocks: true });
    const manager = new HistoryManager({ ccodex: backend });
    service = new SessionManagement({ home,
      managerFactory: async () => ({ manager, close() {} }) });
    const clientId = randomUUID();
    const api = (operation, args) => service.request(operation, { ...args, clientId });
    const apply = async plan => {
      await api("apply", { planId: plan.id, confirmation: plan.confirmation,
        ...(plan.operation === "delete" ? { deletionAcknowledgement: plan.deletionAcknowledgement } : {}) });
      await service.jobs.get(plan.id).work;
      const result = await api("progress", { planId: plan.id });
      if (result.results.some(row => row.status === "failed")) {
        t.diagnostic("Isolated operation failure: " + JSON.stringify(result));
        for (const row of result.results.filter(row => row.status === "failed")) {
          t.diagnostic("Fresh metadata: " + JSON.stringify(await backend.get(row.key.slice(7))));
          t.diagnostic("Listed metadata: " + JSON.stringify((await backend.list()).find(item => item.id === row.key.slice(7))));
        }
      }
      return result;
    };
    const before = await backend.list();
    assert.deepEqual(before.map(row => row.id).sort(), expectedIds);
    assert.equal(before.find(row => row.id === child.id).parentId, parent.id);
    assert.equal(before.find(row => row.id === grandchild.id).parentId, child.id);
    checks.push("All six synthetic histories, including spawned descendants, are visible to the installed API.");
    t.diagnostic(checks.at(-1));

    const archivePlan = await api("preview", { operation: "archive", keys: [archived.key] });
    assert.equal((await apply(archivePlan)).results[0].status, "complete");
    const archivedFile = rolloutFiles(home, archived.id);
    assert.equal(archivedFile.length, 1);
    assert(archivedFile[0].includes("archived_sessions"));
    const restorePlan = await api("preview", { operation: "unarchive", keys: [archived.key] });
    assert.equal((await apply(restorePlan)).results[0].status, "complete");
    assert.equal(rolloutFiles(home, archived.id).length, 1);
    const archiveAgain = await api("preview", { operation: "archive", keys: [archived.key] });
    assert.equal((await apply(archiveAgain)).results[0].status, "complete");
    checks.push("Archive keeps the rollout and restore returns the exact history; permanent deletion is a separate operation.");
    t.diagnostic(checks.at(-1));

    const cliOptions = { api, clientId, output: value => { text += value; },
      sleep: () => new Promise(resolve => setTimeout(resolve, 25)) };
    await runSessions(["delete", "--id", archived.id], cliOptions);
    const stored = [...service.previews.values()].find(item => item.plan.operation === "delete");
    assert(stored);
    assert.equal(rolloutFiles(home, archived.id).length, 1);
    await assert.rejects(runSessions(["apply", stored.plan.id, "--confirm", stored.confirm], cliOptions),
      error => error.code === "deletion_acknowledgement_required");
    assert.equal(rolloutFiles(home, archived.id).length, 1);
    await runSessions(["apply", stored.plan.id, "--confirm", stored.confirm,
      "--delete-ack", stored.deletionAcknowledgement], cliOptions);
    assert.equal(rolloutFiles(home, archived.id).length, 0);
    assert(!(await backend.list()).some(row => row.id === archived.id));
    await assert.rejects(owner.request("thread/unarchive", { threadId: archived.id }));
    await assert.rejects(owner.request("thread/read", { threadId: archived.id, includeTurns: false }));
    checks.push("CLI permanent deletion requires the exact acknowledgement, removes an archived rollout and cannot be restored or read.");
    t.diagnostic(checks.at(-1));

    const idlePlan = await api("preview", { operation: "delete", keys: [idle.key] });
    assert.equal(rolloutFiles(home, idle.id).length, 1);
    assert.equal((await apply(idlePlan)).results[0].status, "complete");
    assert.equal(rolloutFiles(home, idle.id).length, 0);
    await assert.rejects(owner.request("thread/read", { threadId: idle.id, includeTurns: false }));
    checks.push("An unarchived history is also permanently removed, only after confirmed apply.");
    t.diagnostic(checks.at(-1));

    await owner.request("thread/resume", { threadId: held.id, excludeTurns: true });
    const locks = await threadWriterOwnership(home, [held.id]);
    assert.equal(locks?.[held.id], true);
    const heldPlan = await api("preview", { operation: "delete", keys: [held.key] });
    assert.equal(heldPlan.entries[0].reason, "session_in_use");
    assert.equal((await apply(heldPlan)).results[0].status, "skipped");
    await assert.rejects(metadata.request("thread/delete", { threadId: held.id }), /writer|loaded|active|in use|running/i);
    assert.equal(rolloutFiles(home, held.id).length, 1);
    checks.push("A loaded native thread holds its writer lock and is protected from both batch and native deletion.");
    t.diagnostic(checks.at(-1));

    const archiveGrandchild = await api("preview", { operation: "archive", keys: [grandchild.key] });
    assert.equal((await apply(archiveGrandchild)).results[0].status, "complete");
    const missingChild = await api("preview", { operation: "delete", keys: [parent.key] });
    assert.equal(missingChild.entries[0].reason, "descendants_not_selected");
    assert.equal((await apply(missingChild)).results[0].status, "skipped");
    await assert.rejects(backend.mutate("delete", parent.id),
      error => error.code === "native_descendants_protected");
    const missingArchived = await api("preview", { operation: "delete", keys: [parent.key, child.key] });
    assert(missingArchived.entries.every(entry => !entry.eligible));
    assert.equal((await apply(missingArchived)).results.filter(row => row.status === "skipped").length, 2);
    for (const row of [parent, child, grandchild]) assert.equal(rolloutFiles(home, row.id).length, 1);
    checks.push("Unselected descendants, including archived grandchildren, are never implicitly deleted.");
    t.diagnostic(checks.at(-1));

    const family = await api("preview", { operation: "delete", keys: [parent.key, child.key, grandchild.key] });
    assert.deepEqual(family.entries.map(row => row.key), [grandchild.key, child.key, parent.key]);
    const done = await apply(family);
    assert(done.results.every(row => row.status === "complete"), JSON.stringify(done));
    for (const row of [parent, child, grandchild]) assert.equal(rolloutFiles(home, row.id).length, 0);
    assert.deepEqual((await backend.list()).map(row => row.id), [held.id]);
    assert.equal(fs.readFileSync(keep, "utf8"), "Synthetic project content must survive all history operations.");
    checks.push("An explicitly selected family deletes child-first; the unrelated protected history and project files survive.");
    t.diagnostic(checks.at(-1));
  } finally {
    await service?.close();
    const closed = await Promise.allSettled(clients.map(client => client.close()));
    for (const item of closed) if (item.status === "rejected") throw item.reason;
    const resolved = fs.realpathSync(root);
    assert.equal(path.dirname(resolved).toLowerCase(), fs.realpathSync(os.tmpdir()).toLowerCase());
    assert(path.basename(resolved).startsWith("ccodex-permanent-delete-"));
    assert(!fs.lstatSync(root).isSymbolicLink());
    await fs.promises.rm(resolved, { recursive: true, force: true, maxRetries: 8, retryDelay: 100 });
    assert(!fs.existsSync(root));
    t.diagnostic("Owned native test clients exited and the checked isolated profile was removed.");
  }
  if (process.env.CCODEX_TEST_DELETE_EVIDENCE) {
    fs.writeFileSync(process.env.CCODEX_TEST_DELETE_EVIDENCE, JSON.stringify({
      passed: true, checkedAt: new Date().toISOString(), core,
      syntheticHistories: 6, checks, cliOutput: text, elapsedMs: Date.now() - startedAt,
      projectFilesPreserved: true, userHistoryMutations: 0,
      modelRequests: 0, isolatedProfile: root, isolatedProfileRemoved: true,
    }, null, 2) + "\n");
  }
});

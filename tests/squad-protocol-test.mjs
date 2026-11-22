import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { randomUUID } from 'node:crypto';
import { createSquadNativeHandler } from '../gateway/squad-native-peer.mjs';
import { HostThreadBroker } from '../gateway/host-threads.mjs';
import { compactSquadPayload, parseResult, projectBrief, summarizeDelta, validateState } from '../gateway/spine/squad-v2-state.mjs';

const sharedState = {
  schemaVersion: 2, squadId: 'fixture', revision: 4, title: 'Fixture', intent: 'Shared purpose',
  invariants: ['Shared constraint'], contracts: ['Shared interface'],
  criteria: [{ id: 'C1', text: 'Bound standard', detail: 'Exact evidence' }, { id: 'C2', text: 'Unrelated standard' }],
  tasks: [{ slotId: 'dev', goal: 'Keep legacy tasks', touches: [], dependsOn: [], status: 'done' }],
  openBlockers: [], updatedAt: 0,
};

test('state rejects unknown persisted fields and preserves internal task projections', () => {
  validateState(sharedState);
  for (const [patch, expected] of [
    [{ extra: true }, /extra/],
    [{ criteria: [{ ...sharedState.criteria[0], status: 'done' }] }, /criteria\[0\]\.status.*verifyCriteria/],
    [{ openBlockers: [{ id: 'B', summary: 'Blocked', createdAt: 0, unknown: true }] }, /openBlockers\[0\]\.unknown/],
    [{ activeGate: { id: 'G', question: 'Ready?', status: 'open', unknown: true } }, /activeGate\.unknown/],
  ]) assert.throws(() => validateState({ ...sharedState, ...patch }), expected);
});

test('briefs scope criteria and references, and only unchanged stateful turns get an incremental prompt', () => {
  const slot = { handle: 'dev', touches: [], continuity: 'stateful' };
  const options = { criteriaIds: ['C1'], inputs: ['/review/original.md', '/review/log.txt'], forbid: ['secret/**'],
    readOnly: true, repo: { source: 'https://git.example/team/repo.git', baseRef: 'main', branch: 'topic', submodules: true },
    peerWorktrees: [{ slotId: 'peer', handle: 'peer', path: '/worktrees/peer', branch: 'peer-branch' }],
    promptOnly: true, incrementalFromRevision: 4, checkScriptPath: '/work trees/check-delivery.mjs' };
  const brief = projectBrief(sharedState, slot, 'Review the implementation', ['/review/original.md', '/review/design.md'], options);
  assert.match(brief, /Shared STATE unchanged \(rev\.4\)/);
  assert.match(brief, /Review the implementation[\s\S]*C1: Bound standard[\s\S]*Exact evidence/);
  assert.doesNotMatch(brief, /Unrelated standard|## Shared Purpose|## Shared Contracts|## Architecture Red Lines/);
  assert.match(brief, /## Inputs & References[\s\S]*original\.md[\s\S]*log\.txt[\s\S]*design\.md/);
  assert.equal(brief.match(/original\.md/g).length, 1);
  assert.match(brief, /## Peer Read-Only Worktrees\n- @peer -> \/worktrees\/peer \[peer-branch\]/);
  assert.match(brief, /repo.*repo\.git/);
  assert.match(brief, /readOnly.*true/);
  assert.match(brief, /forbid[\s\S]*secret\/\*\*/);
  assert.match(brief, /node .*check-delivery\.mjs/);
  assert.match(brief, /automatically collects.*commits/i);
  for (const changed of [{ ...options, incrementalFromRevision: 3 }, { ...options, promptOnly: false }]) {
    const full = projectBrief(sharedState, slot, 'Review', [], changed);
    assert.match(full, /## Shared Purpose[\s\S]*## Architecture Red Lines[\s\S]*## Shared Contracts/);
    assert.doesNotMatch(full, /Shared STATE unchanged/);
  }
  const clean = projectBrief(sharedState, { ...slot, continuity: 'clean' }, 'Private task', [], options);
  assert.match(clean, /C1: Bound standard[\s\S]*original\.md/);
  assert.doesNotMatch(clean, /Peer Read-Only Worktrees|Private task|Shared STATE unchanged|Shared constraint/);
  const legacy = projectBrief(sharedState, { ...slot, touches: ['src/**'] }, 'Legacy task', ['/legacy/output']);
  assert.match(legacy, /C2: Unrelated standard[\s\S]*\/legacy\/output[\s\S]*## Write Boundary \/ Touches\n- src\/\*\*/);
  assert.doesNotMatch(projectBrief(sharedState, slot, 'Review', [], {}), /\[\] \(read-only\)/);
});

test('reports accept decorated status and localized assumptions while retaining complete bodies', () => {
  for (const [header, expected, heading] of [
    ['---\r\nSTATUS: "DONE"\r\nsummary: Frontmatter\r\n---', 'done', 'Assumptions & Trade-offs / 主会话待收敛'],
    ['**Status**: BLOCKED', 'blocked', '关键假设与取舍'],
    ['- status: escalate', 'escalate', '假设与取舍'],
  ]) {
    const body = header + '\r\n\r\n## ' + heading + '\r\n- Assumption\r\n\r\n## Verification\r\nTested';
    const report = parseResult(body, 42);
    assert.equal(report.status, expected);
    assert.equal(report.body, body);
    assert.equal(report.reportedAt, 42);
    assert.deepEqual(report.assumptions, ['- Assumption']);
  }
  assert.equal(parseResult('---\nstatus: done\nsummary: Original\n---', 0).summary, 'Original');
  assert.deepEqual(parseResult('status: done\n## Changes\nReal report', 1).assumptions, []);
  assert.deepEqual(parseResult('status: done\n## Assumptions & Trade-offs\n## Evidence\nDetails', 1).assumptions, []);
  assert.throws(() => parseResult('\x60\x60\x60\nstatus: done\n\x60\x60\x60\nstatus: completed', 0), /status/i);
});

test('compact status and integration replies preserve repo and physical evidence', () => {
  const violations = Array.from({ length: 42 }, (_, index) => 'secret/' + index);
  const delta = { baseSha: 'base', headSha: 'head', commits: [], changed: [], outsideTouches: [], dirtyCount: 0, forbidViolations: violations };
  const summary = summarizeDelta(delta);
  assert.equal(summary.dirtyCount, 0);
  assert.deepEqual(summary.forbidViolations, violations);
  const repo = { source: '/code/core-service', branch: 'topic' };
  const integrations = { ext: { source: repo.source, repoKey: 'ext', branch: 'integration', worktreePath: '/tmp/integration' } };
  const snapshot = { integrations, slots: [{ repo, delta, rounds: [{ round: 1, repo, deltaSummary: summary }] }] };
  const compact = compactSquadPayload({ delta, snapshot });
  assert.deepEqual(compact.snapshot.integrations, integrations);
  assert.deepEqual(compact.snapshot.slots[0].repo, repo);
  assert.deepEqual(compact.snapshot.slots[0].rounds[0].repo, repo);
  for (const projected of [compact.delta, compact.snapshot.slots[0].delta, compact.snapshot.slots[0].rounds[0].deltaSummary]) {
    assert.equal(projected.dirtyCount, 0);
    assert.deepEqual(projected.forbidViolations, violations);
  }
});

const ref = () => ({ hostId: 'local:' + 'a'.repeat(32), accountId: 'b'.repeat(64), threadId: randomUUID(), runtimeId: randomUUID() });
test('native worker preserves roots/network, explicit permissions/trust and host Node path', async t => {
  const home = fs.mkdtempSync(path.join(os.tmpdir(), 'squad-protocol-')); t.after(() => fs.rmSync(home, { recursive: true, force: true }));
  const rollout = path.join(home, 'rollout.jsonl');
  fs.writeFileSync(rollout, JSON.stringify({ type: 'turn_context', payload: { approval_policy: 'on-request', sandbox_policy: { type: 'workspace-write', writable_roots: [home], network_access: true, exclude_slash_tmp: true } } }) + '\n');
  const target = ref(), starts = [];
  const handler = createSquadNativeHandler({ ownsThread: () => false, runExclusive: (_, run) => run(), request: async (method, p) => {
    if (method === 'thread/read') return { thread: { id: target.threadId, path: rollout } };
    starts.push(p); return { thread: { id: randomUUID(), cwd: home } };
  } });
  const command = { operation: 'create', requestId: randomUUID(), cwd: home, anchorThreadId: target.threadId, trusted: true };
  assert.equal((await handler(target, command)).state, 'accepted');
  assert.equal(starts[0].sandbox, 'workspace-write');
  assert.deepEqual(starts[0].config['sandbox_workspace_write.writable_roots'], [home]);
  assert.equal(starts[0].config['sandbox_workspace_write.network_access'], true);
  assert.equal(starts[0].config[`projects.${JSON.stringify(home)}.trust_level`], 'trusted');
  assert.equal(starts[0].config['shell_environment_policy.set'].PATH.split(path.delimiter)[0], path.dirname(process.execPath));
  await handler(target, { ...command, requestId: randomUUID(), approvalPolicy: 'never', sandbox: 'read-only' });
  assert.equal(starts[1].approvalPolicy, 'never'); assert.equal(starts[1].sandbox, 'read-only');
  assert.equal(starts[1].config['sandbox_workspace_write.network_access'], undefined);
  await assert.rejects(handler(target, { ...command, requestId: randomUUID(), trusted: 'yes' }), /permissions/);
});
test('headless turn reads expose native interactive waits', async () => {
  const target = ref();
  for (const waiting of ['waitingOnApproval', 'waitingOnUserInput']) {
    let turnStatus = 'inProgress';
    const handler = createSquadNativeHandler({ ownsThread: () => false, runExclusive: (_, run) => run(), request: async method => method === 'thread/read'
      ? { thread: { id: target.threadId, status: { type: 'active', activeFlags: [waiting] } } }
      : { data: [{ id: 'turn', status: turnStatus, items: [] }] } });
    const result = await handler(target, { operation: 'turn', turnId: 'turn' });
    assert.equal(result.status, waiting); assert.deepEqual(result.threadStatus.activeFlags, [waiting]);
    turnStatus = 'completed';
    assert.equal((await handler(target, { operation: 'turn', turnId: 'turn' })).status, 'completed');
  }
});
test('read reconnect uses unique host/account while mutations and receipts remain pinned', async () => {
  const broker = new HostThreadBroker(), target = ref(), runtimeId = randomUUID();
  const connection = { role: 'native-host', initialized: true, request: async (method, p) => method === 'mycodex/host/squad'
    ? { thread: { id: p.ref.threadId, hostRef: p.ref } }
    : { ref: p.ref, observedAt: new Date().toISOString(), title: '', cwd: '/', status: 'idle', archived: false } };
  broker.register({ hostId: target.hostId, accountId: target.accountId, runtimeId, accountVerified: true, canSquad: true }, connection);
  assert.equal((await broker.read(target)).ref.runtimeId, runtimeId);
  assert.equal((await broker.resolveSquad(target)).hostRef.runtimeId, runtimeId);
  await assert.rejects(broker.squad(target, { operation: 'receipt', requestId: randomUUID() }), /unavailable/);
  await assert.rejects(broker.read({ ...target, accountId: 'c'.repeat(64) }), /unavailable/);
  broker.register({ hostId: target.hostId, accountId: target.accountId, runtimeId: randomUUID(), accountVerified: true, canSquad: true }, { ...connection });
  await assert.rejects(broker.read(target), /ambiguous/);
  await assert.rejects(broker.resolveSquad(target), /unavailable/);
});
test('installed native app-server accepts worker permission and environment overrides in an isolated profile', { timeout: 15000 }, async t => {
  const executable = process.env.MYCODEX_TEST_NATIVE_CLI ?? '/Applications/ChatGPT.app/Contents/Resources/codex-cli/CodexCLI.app/Contents/MacOS/codex';
  if (!fs.existsSync(executable)) { t.skip('Native CLI unavailable'); return; }
  const { spawn } = await import('node:child_process');
  const { RpcPeer } = await import('../gateway/rpc-peer.mjs');
  const { readMessages, writeMessage } = await import('../gateway/ipc.mjs');
  const home = fs.mkdtempSync(path.join(os.tmpdir(), 'squad-native-config-'));
  const profile = path.join(home, 'profile'); fs.mkdirSync(profile);
  const child = spawn(executable, ['app-server'], { cwd: home, env: { HOME: home, CODEX_HOME: profile, PATH: '/usr/bin:/bin' }, stdio: ['pipe', 'pipe', 'pipe'] });
  child.stderr.resume();
  const native = new RpcPeer(message => writeMessage(child.stdin, message));
  readMessages(child.stdout, message => native.receive(message), error => native.close(error));
  const exited = new Promise(resolve => child.once('exit', code => { native.close(); resolve(code); }));
  t.after(async () => { child.stdin.end(); const timer = setTimeout(() => child.kill('SIGKILL'), 3000); await exited; clearTimeout(timer); fs.rmSync(home, { recursive: true, force: true }); });
  await native.request('initialize', { clientInfo: { name: 'squad-config-test', version: '1' }, capabilities: { experimentalApi: true } }, { timeoutMs: 5000 });
  native.notify({ method: 'initialized' });
  let started;
  const extraRoot = fs.mkdtempSync(home + '-extra-');
  t.after(() => fs.rmSync(extraRoot, { recursive: true, force: true }));
  const anchor = randomUUID(), rollout = path.join(home, 'anchor.jsonl');
  fs.writeFileSync(rollout, JSON.stringify({ type: 'turn_context', payload: { approval_policy: 'on-request', sandbox_policy: { type: 'workspace-write', writable_roots: [extraRoot], network_access: true, exclude_slash_tmp: true } } }) + '\n');
  const handler = createSquadNativeHandler({ ownsThread: () => false, runExclusive: (_, run) => run(), request: async (method, p) => {
    if (method === 'thread/read' && p.threadId === anchor) return { thread: { id: anchor, path: rollout } };
    const result = await native.request(method, p, { timeoutMs: 5000 });
    if (method === 'thread/start') started = result;
    return result;
  } });
  const receipt = await handler(ref(), { operation: 'create', requestId: randomUUID(), cwd: home, anchorThreadId: anchor, approvalPolicy: 'never', sandbox: 'workspace-write', trusted: true });
  assert.equal(receipt.state, 'accepted');
  assert.equal(started.approvalPolicy, 'never');
  assert.equal(started.sandbox.type, 'workspaceWrite');
  assert.equal(started.sandbox.networkAccess, true);
  assert.equal(started.sandbox.excludeSlashTmp, true);
  assert.deepEqual(started.sandbox.writableRoots.map(root => fs.realpathSync(root)), [fs.realpathSync(extraRoot)]);
  const notifications = [];
  native.onNotification = message => notifications.push(message);
  await native.request('thread/shellCommand', { threadId: started.thread.id, command: 'node --version', timeoutMs: 3000 }, { timeoutMs: 5000 });
  const deadline = Date.now() + 5000;
  while (!notifications.some(message => message.method === 'item/completed')) {
    if (Date.now() > deadline) throw new Error('Native shell did not finish');
    await new Promise(resolve => setTimeout(resolve, 10));
  }
  const item = notifications.find(message => message.method === 'item/completed').params.item;
  assert.equal(item.exitCode, 0, JSON.stringify(item));
  assert.match(item.aggregatedOutput, /v\d+\.\d+\.\d+/);
});

test('native read detects unfinished non-guardian subagent rollouts', async t => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'squad-subagent-probe-'));
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  const parentId = randomUUID(), parentRollout = path.join(dir, `rollout-parent-${parentId}.jsonl`);
  fs.writeFileSync(parentRollout, JSON.stringify({ type: 'session_meta', payload: { id: parentId, cwd: dir } }) + '\n');
  const guardianId = randomUUID();
  fs.writeFileSync(path.join(dir, `rollout-guardian-${guardianId}.jsonl`), [
    JSON.stringify({ type: 'session_meta', payload: { id: guardianId, parent_thread_id: parentId, thread_source: 'guardian_review', source: { subagent: { other: 'guardian' } } } }),
    JSON.stringify({ type: 'event_msg', payload: { type: 'task_started', turn_id: 'g1' } }),
  ].join('\n') + '\n');
  const childId = randomUUID(), childRollout = path.join(dir, `rollout-child-${childId}.jsonl`);
  fs.writeFileSync(childRollout, [
    JSON.stringify({ type: 'session_meta', payload: { id: childId, parent_thread_id: parentId, source: { subagent: 'worker' } } }),
    JSON.stringify({ type: 'event_msg', payload: { type: 'task_started', turn_id: 't1' } }),
  ].join('\n') + '\n');
  const target = { ...ref(), threadId: parentId };
  const handler = createSquadNativeHandler({ ownsThread: () => false, runExclusive: (_, run) => run(), request: async () => ({
    thread: { id: parentId, name: 'Parent', cwd: dir, status: { type: 'idle' }, path: parentRollout },
  }) });
  assert.equal((await handler(target, { operation: 'read' })).thread.activeSubagents, true);
  fs.appendFileSync(childRollout, JSON.stringify({ type: 'event_msg', payload: { type: 'task_complete', turn_id: 't1' } }) + '\n');
  assert.equal((await handler(target, { operation: 'read' })).thread.activeSubagents, undefined);
});

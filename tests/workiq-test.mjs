import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { spawn, spawnSync } from "node:child_process";
import http from "node:http";
import { randomUUID } from "node:crypto";
import vm from "node:vm";
import { setTimeout as delay } from "node:timers/promises";
import test from "node:test";
import {
  CLIENT_ID, ENDPOINT, SCOPES, START_MARKER, END_MARKER, DATA_NOTICE,
  configure, paths, publicStatus, readSettings, writeSettings, renderManagedConfig, validateTenant,
  identityBindingFingerprint,
} from "../bridge/workiq/settings.mjs";
import { SecureCachePlugin, acquireCacheLock, dpapi } from "../bridge/workiq/cache.mjs";
import { createIdentity, LoginRequiredError } from "../bridge/workiq/auth.mjs";
import { WorkIqUpstream, authorizedFetch, capabilitySnapshot, discoverEndpoint } from "../bridge/workiq/transport.mjs";
import { createWorkIqServer, STATUS_TOOL, ACTION_STATUS_TOOL, CALL_TOOL } from "../bridge/workiq/server.mjs";
import { createDesktopWorkIqHandler } from "../bridge/workiq/desktop.mjs";
import { ActionQueue, isReadOnlyTool } from "../bridge/workiq/actions.mjs";
import { runtimeImport } from "../bridge/workiq/dependencies.mjs";
import { runWorkIq } from "../bridge/workiq/main.mjs";
import { quotaSnapshotText, quotaSnapshotFreshness } from "../bridge/copilot-account.mjs";

const root = path.resolve(import.meta.dirname, "..");
const TEST_TENANT = "00000000-0000-4000-8000-000000000001";
const OTHER_TENANT = "00000000-0000-4000-8000-000000000002";
const testRoot = fs.mkdtempSync(path.join(os.tmpdir(), "ccodex-workiq-test-"));
let sequence = 0;
function profile() {
  const home = path.join(testRoot, `profile-${++sequence}`);
  fs.mkdirSync(home);
  return home;
}
function writeConfig(home, text) {
  fs.writeFileSync(paths(home).config, text);
}
function selectSyntheticIdentity(home, accountId = "selected-test-account", tenantId = TEST_TENANT) {
  writeSettings({ ...readSettings(home), selectedAccountId: accountId, selectedTenantId: tenantId }, home);
}
function identityFixture(home, accounts = [{ homeAccountId: "selected-test-account", tenantId: TEST_TENANT }]) {
  const calls = [];
  const app = {
    getTokenCache() {
      return {
        getAllAccounts: async () => { calls.push("accounts"); return accounts; },
        removeAccount: async account => { calls.push(["remove", account.homeAccountId]); },
      };
    },
    acquireTokenSilent: async args => {
      calls.push(["silent", args]);
      return { accessToken: "TEST_ONLY_ACCESS_TOKEN_NOT_A_REAL_CREDENTIAL", account: args.account, tenantId: args.account.tenantId };
    },
    acquireTokenByDeviceCode: async request => {
      calls.push("device");
      request.deviceCodeCallback({
        verificationUri: "https://microsoft.com/devicelogin",
        userCode: "TEST-CODE",
        expiresIn: 900,
        deviceCode: "NEVER_EXPOSE_THIS_DEVICE_SECRET",
      });
      return { accessToken: "TEST_ONLY_ACCESS_TOKEN_NOT_A_REAL_CREDENTIAL", account: accounts[0], tenantId: accounts[0].tenantId };
    },
  };
  return {
    calls, app,
    options: {
      applicationFactory: configuration => {
        assert.equal(configuration.auth.clientId, CLIENT_ID);
        assert.match(configuration.auth.authority, /^https:\/\/login\.microsoftonline\.com\//);
        assert.equal(configuration.system.loggerOptions.piiLoggingEnabled, false);
        assert.equal(configuration.broker, undefined);
        return app;
      },
      cachePlugin: {},
    },
  };
}

test("configure is disabled by default and preserves unrelated profile configuration byte-for-byte", () => {
  const home = profile();
  const original = '# user-owned comment\nmodel = "user-model"\n\n[mcp_servers.existing]\ncommand = "existing-tool"\n';
  writeConfig(home, original);
  const state = configure({ profile: home });
  const text = fs.readFileSync(paths(home).config, "utf8");
  assert.ok(text.startsWith(original));
  assert.equal(state.enabled, false);
  assert.equal(state.authentication, "not_checked");
  assert.match(text, /default_tools_approval_mode = "prompt"/);
  assert.match(text, /enabled = false/);
  assert.ok(text.includes(JSON.stringify(home)));
  assert.equal(fs.existsSync(paths(home).cache), false);
  configure({ profile: home });
  const twice = fs.readFileSync(paths(home).config, "utf8");
  assert.equal(twice.split(START_MARKER).length - 1, 1);
  assert.equal(twice.split(END_MARKER).length - 1, 1);
});

test("enabling requires acknowledgement and disabling retains the account without exporting it", () => {
  const home = profile();
  assert.throws(() => configure({ profile: home, enable: true }), /selected model provider/);
  assert.equal(fs.existsSync(paths(home).config), false);
  configure({ profile: home, enable: true, acknowledge: true });
  assert.equal(readSettings(home).enabled, true);
  assert.match(fs.readFileSync(paths(home).config, "utf8"), /enabled = true/);
  writeSettings({ ...readSettings(home), selectedAccountId: "private-test-account-id" }, home);
  configure({ profile: home, enable: false });
  assert.equal(readSettings(home).selectedAccountId, "private-test-account-id");
  assert.doesNotMatch(JSON.stringify(publicStatus(home)), /private-test-account-id/);
});

test("tenant changes clear selected-account binding and invalid authorities are rejected", () => {
  const home = profile();
  configure({ profile: home });
  selectSyntheticIdentity(home, "old-account");
  configure({ profile: home, tenant: "contoso.onmicrosoft.com" });
  assert.equal(readSettings(home).selectedAccountId, null);
  assert.equal(readSettings(home).selectedTenantId, null);
  for (const tenant of ["https://evil.example", "../tenant", "common", "", "bad;tenant", "tenant/user"]) {
    assert.throws(() => validateTenant(tenant));
  }
  assert.equal(validateTenant("00000000-0000-4000-8000-000000000001"), "00000000-0000-4000-8000-000000000001");
});

test("unmanaged servers, broken markers, and invalid stored settings fail without destructive changes", () => {
  for (const header of ["[mcp_servers.workiq]", '[mcp_servers."workiq"]', "[mcp_servers.'workiq']"]) {
    const home = profile();
    const original = `${header}\ncommand = "user-owned"\n`;
    writeConfig(home, original);
    assert.throws(() => configure({ profile: home }), /unmanaged/);
    assert.equal(fs.readFileSync(paths(home).config, "utf8"), original);
    assert.equal(fs.existsSync(paths(home).settings), false);
  }
  const home = profile();
  assert.throws(() => renderManagedConfig(`${START_MARKER}\nbroken`, readSettings(home), { profile: home }), /Malformed/);
  fs.mkdirSync(paths(home).state);
  fs.writeFileSync(paths(home).settings, '{"schemaVersion":999}');
  assert.throws(() => readSettings(home), /invalid/);
});

test("repair regenerates both clients' Work IQ configuration without losing opt-in or changing stock Codex", () => {
  const home = profile();
  const stock = profile();
  const stockConfig = '# stock profile\nmodel = "stock-model"\n[mcp_servers.example]\ncommand = "example"\n';
  writeConfig(stock, stockConfig);
  configure({ profile: home, enable: true, acknowledge: true });
  const result = spawnSync(process.execPath, [path.join(root, "tools", "gen-config.mjs")], {
    env: {
      ...process.env,
      CODEX_COPILOT_HOME: home,
      CODEX_COPILOT_SOURCE_HOME: stock,
      CODEX_COPILOT_DEFAULT_MODEL: "test-model",
      CODEX_COPILOT_AUTH_MODE: "saved",
    },
    windowsHide: true, encoding: "utf8", timeout: 15_000,
  });
  assert.equal(result.status, 0, result.stderr);
  const generated = fs.readFileSync(paths(home).config, "utf8");
  assert.match(generated, /\[mcp_servers.workiq\]/);
  assert.match(generated, /enabled = true/);
  assert.match(generated, /command = "example"/);
  assert.equal(fs.readFileSync(paths(stock).config, "utf8"), stockConfig);
});

test("secure cache serializes only through the vault and releases its lock on errors", async () => {
  const home = profile();
  const file = paths(home).cache;
  const plugin = new SecureCachePlugin(file, {
    protect: value => `SEALED:${Buffer.from(value).toString("base64")}`,
    unprotect: value => Buffer.from(value.slice(7), "base64").toString(),
  });
  const deserialized = [];
  const cache = { deserialize: value => deserialized.push(value), serialize: () => '{"fake":"TEST_ONLY_NOT_REAL"}' };
  await plugin.beforeCacheAccess({ tokenCache: cache });
  assert.equal(deserialized[0], "{}");
  await plugin.afterCacheAccess({ tokenCache: cache, cacheHasChanged: true });
  assert.doesNotMatch(fs.readFileSync(file, "utf8"), /TEST_ONLY_NOT_REAL/);
  assert.equal(fs.existsSync(`${file}.lock`), false);
  await plugin.beforeCacheAccess({ tokenCache: cache });
  await plugin.afterCacheAccess({ tokenCache: cache, cacheHasChanged: false });
  assert.equal(deserialized[1], cache.serialize());
  const broken = new SecureCachePlugin(file, { unprotect: () => { throw new Error("must not leak"); } });
  await assert.rejects(broken.beforeCacheAccess({ tokenCache: cache }), /encrypted cache/);
  assert.equal(fs.existsSync(`${file}.lock`), false);
});

test("cache access has a cross-process lock and never overwrites a live owner", async () => {
  const file = paths(profile()).cache;
  const unlock = await acquireCacheLock(file);
  await assert.rejects(acquireCacheLock(file, { timeoutMs: 30 }), /busy/);
  unlock();
  const unlockAgain = await acquireCacheLock(file);
  unlockAgain();
});

test("Windows vault really encrypts and decrypts an isolated synthetic credential", { skip: process.platform !== "win32" }, () => {
  const plain = JSON.stringify({ synthetic: "NOT_A_REAL_ACCESS_TOKEN", unicode: "隔离验证" });
  const sealed = dpapi("protect", plain);
  assert.doesNotMatch(sealed, /NOT_A_REAL_ACCESS_TOKEN/);
  assert.equal(dpapi("unprotect", sealed), plain);
  assert.throws(() => dpapi("unprotect", "not-protected-data"), /vault is unavailable/);
  assert.throws(() => dpapi("unprotect", sealed, { purpose: "action-record" }), /vault is unavailable/);
});

test("background identity requires explicit account selection and never initiates a login", async () => {
  const home = profile();
  const fixture = identityFixture(home);
  const identity = await createIdentity(home, fixture.options);
  await assert.rejects(identity.token(), LoginRequiredError);
  assert.deepEqual(fixture.calls, [], "Background startup must not even enumerate an unselected cache.");
  assert.equal((await identity.status()).authentication, "login_required");
  assert.equal(fixture.calls.includes("device"), false);
});

test("silent renewal uses only the explicitly selected profile account and documented resource scope", async () => {
  const home = profile();
  configure({ profile: home });
  selectSyntheticIdentity(home);
  const fixture = identityFixture(home);
  const identity = await createIdentity(home, fixture.options);
  assert.match(await identity.token(), /TEST_ONLY/);
  assert.equal(fixture.calls[1][0], "silent");
  assert.deepEqual(fixture.calls[1][1].scopes, SCOPES);
  assert.equal(fixture.calls[1][1].authority, `https://login.microsoftonline.com/${TEST_TENANT}`);
  assert.equal(fixture.calls[1][1].account.homeAccountId, "selected-test-account");
  fixture.app.acquireTokenSilent = async () => { throw { errorCode: "interaction_required", errorMessage: "PRIVATE_DETAIL" }; };
  const status = await identity.status();
  assert.equal(status.code, "interaction_required");
  assert.doesNotMatch(JSON.stringify(status), /PRIVATE_DETAIL/);
  assert.equal(fixture.calls.includes("device"), false);
});

test("missing selected accounts do not fall back to any other Windows or cached account", async () => {
  const home = profile();
  configure({ profile: home });
  selectSyntheticIdentity(home, "different-account");
  const fixture = identityFixture(home);
  await assert.rejects((await createIdentity(home, fixture.options)).token(), /explicit sign-in/);
  assert.deepEqual(fixture.calls, ["accounts"]);
});

test("explicit device-code login persists an account binding but never a plaintext access token", async () => {
  const home = profile();
  const fixture = identityFixture(home);
  const identity = await createIdentity(home, fixture.options);
  let code;
  const result = await identity.login(value => { code = value; });
  assert.equal(code.userCode, "TEST-CODE");
  assert.equal(result.authentication, "authenticated");
  assert.equal(readSettings(home).selectedAccountId, "selected-test-account");
  assert.equal(readSettings(home).selectedTenantId, TEST_TENANT);
  assert.equal(result.tenant, TEST_TENANT);
  assert.doesNotMatch(fs.readFileSync(paths(home).settings, "utf8"), /TEST_ONLY_ACCESS_TOKEN/);
  assert.equal(readSettings(home).enabled, false);
});

test("cancelled sign-in cannot activate the new cached account", async () => {
  const home = profile();
  const fixture = identityFixture(home);
  const controller = new AbortController();
  const identity = await createIdentity(home, fixture.options);
  await assert.rejects(identity.login(() => controller.abort(), { signal: controller.signal }), /explicit sign-in/);
  assert.equal(readSettings(home).selectedAccountId, null);
  assert.equal(readSettings(home).selectedTenantId, null);
});

test("a long-lived identity cannot silently substitute a newly selected account", async () => {
  const home = profile();
  configure({ profile: home });
  selectSyntheticIdentity(home);
  const fixture = identityFixture(home);
  const identity = await createIdentity(home, fixture.options);
  await identity.token();
  writeSettings({ ...readSettings(home), selectedAccountId: "different-account" }, home);
  await assert.rejects(identity.token(), error => error.code === "account_changed_refresh_mcp");
});

test("legacy account-only selections require explicit tenant-bound login without enumerating or guessing", async () => {
  const home = profile();
  configure({ profile: home });
  writeSettings({ ...readSettings(home), selectedAccountId: "selected-test-account" }, home);
  const fixture = identityFixture(home);
  const identity = await createIdentity(home, fixture.options);
  await assert.rejects(identity.token(), error => error.code === "selected_tenant_required");
  assert.deepEqual(fixture.calls, []);
  assert.equal(publicStatus(home).identityBindingPresent, false);
  await identity.login(() => {});
  assert.equal(publicStatus(home).identityBindingPresent, true);
  assert.equal(readSettings(home).selectedTenantId, TEST_TENANT);
  assert.match(await identity.token(), /TEST_ONLY/);
});

test("one home account with two tenant profiles selects the exact tenant, not cache order", async () => {
  const home = profile();
  configure({ profile: home });
  selectSyntheticIdentity(home, "selected-test-account", OTHER_TENANT);
  const fixture = identityFixture(home, [
    { homeAccountId: "selected-test-account", tenantId: TEST_TENANT },
    { homeAccountId: "selected-test-account", tenantId: OTHER_TENANT },
  ]);
  const identity = await createIdentity(home, fixture.options);
  await identity.token();
  const request = fixture.calls.find(value => Array.isArray(value) && value[0] === "silent")[1];
  assert.equal(request.account.tenantId, OTHER_TENANT);
  assert.equal(request.authority, `https://login.microsoftonline.com/${OTHER_TENANT}`);
  assert.equal(identity.bindingFingerprint(), identityBindingFingerprint(readSettings(home)));
});

test("an unexpected token tenant or account cannot reach the enterprise endpoint", async () => {
  for (const mismatch of ["tenant", "account", "claims", "missing-tenant"]) {
    const home = profile();
    configure({ profile: home });
    selectSyntheticIdentity(home);
    const fixture = identityFixture(home);
    fixture.app.acquireTokenSilent = async ({ account }) => ({
      accessToken: "TEST_ONLY_WRONG_CONTEXT",
      tenantId: mismatch === "missing-tenant" ? undefined : mismatch === "tenant" ? OTHER_TENANT : TEST_TENANT,
      account: {
        ...account,
        homeAccountId: mismatch === "account" ? "not-the-selected-account" : account.homeAccountId,
        tenantId: mismatch === "tenant" ? OTHER_TENANT : TEST_TENANT,
      },
      ...(mismatch === "claims" ? { idTokenClaims: { tid: OTHER_TENANT } } : {}),
    });
    let sent = 0;
    const send = authorizedFetch(await createIdentity(home, fixture.options), {
      fetchImpl: async () => { sent++; return new Response("must not send"); },
    });
    await assert.rejects(send(ENDPOINT), error => error.code === "token_identity_mismatch");
    assert.equal(sent, 0);
  }
});

test("a selected tenant change invalidates even an already-connected upstream client", async () => {
  const home = profile();
  configure({ profile: home });
  selectSyntheticIdentity(home);
  const fixture = identityFixture(home);
  const identity = await createIdentity(home, fixture.options);
  const remote = new WorkIqUpstream(identity, home, {
    clientFactory: fakeClientFactory(() => ({ tools: [{ name: "fetch", inputSchema: { type: "object" } }] })),
    transportFactory: FakeTransport,
  });
  try {
    await remote.connect();
    assert.equal(publicStatus(home).lastDiscoveredTools[0], "fetch");
    selectSyntheticIdentity(home, "selected-test-account", OTHER_TENANT);
    await assert.rejects(remote.connect(), error => error.code === "account_changed_refresh_mcp");
    await assert.rejects(identity.token(), error => error.code === "account_changed_refresh_mcp");
    assert.equal(publicStatus(home).lastToolDiscovery, null);
    assert.deepEqual(publicStatus(home).lastDiscoveredTools, []);
    assert.equal(publicStatus(home).toolDiscoveryNeedsRefresh, true);
  } finally {
    await remote.close();
  }
});

test("a tenant switch while silent renewal is pending cannot return the stale credential", async () => {
  const home = profile();
  configure({ profile: home });
  selectSyntheticIdentity(home);
  const fixture = identityFixture(home);
  fixture.app.acquireTokenSilent = async ({ account }) => {
    selectSyntheticIdentity(home, "selected-test-account", OTHER_TENANT);
    return { accessToken: "TEST_ONLY_STALE_TOKEN", account, tenantId: TEST_TENANT };
  };
  const identity = await createIdentity(home, fixture.options);
  await assert.rejects(identity.token(), error => error.code === "account_changed_refresh_mcp");
  assert.equal(readSettings(home).selectedTenantId, OTHER_TENANT);
});

test("an in-flight cloud result cannot be delivered after the selected tenant changes", async () => {
  const home = profile();
  configure({ profile: home });
  selectSyntheticIdentity(home);
  const fixture = identityFixture(home);
  const BaseClient = fakeClientFactory(() => ({
    tools: [{ name: "fetch", inputSchema: { type: "object" } }],
  }));
  class SwitchingClient extends BaseClient {
    async callTool(_params, _schema, options) {
      selectSyntheticIdentity(home, "selected-test-account", OTHER_TENANT);
      options.onprogress?.({ progress: 1, message: "PRIVATE_SYNTHETIC_OLD_TENANT_PROGRESS" });
      return { content: [{ type: "text", text: "PRIVATE_SYNTHETIC_OLD_TENANT_RESULT" }] };
    }
  }
  const remote = new WorkIqUpstream(await createIdentity(home, fixture.options), home, {
    clientFactory: SwitchingClient, transportFactory: FakeTransport,
  });
  try {
    const progress = [];
    await assert.rejects(remote.callTool({ name: "fetch", arguments: {} }, { onprogress: value => progress.push(value) }),
      error => error.code === "account_changed_refresh_mcp");
    assert.deepEqual(progress, []);
  } finally {
    await remote.close();
  }
});

test("explicit login rejects the wrong configured tenant and preserves a concurrent selection", async () => {
  const home = profile();
  configure({ profile: home, tenant: TEST_TENANT });
  const wrongTenant = identityFixture(home, [{ homeAccountId: "selected-test-account", tenantId: OTHER_TENANT }]);
  await assert.rejects((await createIdentity(home, wrongTenant.options)).login(() => {}),
    error => error.code === "token_identity_mismatch");
  assert.equal(readSettings(home).selectedAccountId, null);

  const fixture = identityFixture(home);
  const acquire = fixture.app.acquireTokenByDeviceCode;
  fixture.app.acquireTokenByDeviceCode = async request => {
    const result = await acquire(request);
    selectSyntheticIdentity(home, "concurrently-selected-account", TEST_TENANT);
    return result;
  };
  await assert.rejects((await createIdentity(home, fixture.options)).login(() => {}),
    error => error.code === "account_changed_refresh_mcp");
  assert.equal(readSettings(home).selectedAccountId, "concurrently-selected-account");
});

test("logout clears both local identity bindings without invoking interactive authentication", async () => {
  const home = profile();
  configure({ profile: home, enable: true, acknowledge: true });
  selectSyntheticIdentity(home);
  const fixture = identityFixture(home);
  const identity = await createIdentity(home, fixture.options);
  assert.equal((await identity.logout()).authentication, "signed_out");
  assert.equal(readSettings(home).selectedAccountId, null);
  assert.equal(readSettings(home).selectedTenantId, null);
  assert.equal(publicStatus(home).enabled, false);
  assert.deepEqual(fixture.calls, ["accounts", ["remove", "selected-test-account"]]);
});

test("stored tenant bindings require a UUID and an account, while legacy settings remain readable", () => {
  const home = profile();
  configure({ profile: home });
  assert.throws(() => writeSettings({ ...readSettings(home), selectedTenantId: TEST_TENANT }, home), /selected account/);
  assert.throws(() => selectSyntheticIdentity(home, "selected-test-account", "organizations"), /tenant UUID/);
  selectSyntheticIdentity(home, "selected-test-account", "AAAAAAAA-AAAA-4AAA-8AAA-AAAAAAAAAAAA");
  assert.equal(readSettings(home).selectedTenantId, "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa");
});

const syntheticCodec = {
  protect: value => `SYNTHETIC_SEAL:${Buffer.from(value).toString("base64")}`,
  unprotect: value => Buffer.from(value.slice("SYNTHETIC_SEAL:".length), "base64").toString(),
};
const writeParams = () => ({
  name: "do_action",
  arguments: { actionUrl: "/me/sendMail", jsonBody: { synthetic: "PRIVATE_TEST_MESSAGE", opaqueId: "A/B+==" } },
});

test("known writes cannot bypass review with an incorrect read-only annotation", () => {
  for (const name of ["create_entity", "update_entity", "delete_entity", "do_action"]) {
    assert.equal(isReadOnlyTool({ name, annotations: { readOnlyHint: true } }), false);
  }
  assert.equal(isReadOnlyTool({ name: "future_tool" }), false);
  assert.equal(isReadOnlyTool({ name: "fetch", annotations: { readOnlyHint: true } }), true);
});

test("writes are encrypted, deduplicated while pending, and never executed by queuing", async () => {
  const home = profile();
  configure({ profile: home, enable: true, acknowledge: true });
  selectSyntheticIdentity(home);
  const queue = new ActionQueue(home, syntheticCodec);
  const pending = await queue.enqueue(writeParams());
  assert.equal(pending.executed, false);
  assert.equal(pending.status, "approval_required");
  assert.match(pending.instruction, /must not approve its own action/);
  assert.equal((await queue.enqueue(writeParams())).id, pending.id);
  assert.equal(queue.list().length, 1);
  assert.doesNotMatch(fs.readFileSync(queue.file(pending.id), "utf8"), /PRIVATE_TEST_MESSAGE|opaqueId/);
  assert.deepEqual((await queue.show(pending.id)).arguments, writeParams().arguments);
});

test("only an exact reviewed action executes and it cannot be approved twice", async () => {
  const home = profile();
  configure({ profile: home, enable: true, acknowledge: true });
  selectSyntheticIdentity(home);
  const queue = new ActionQueue(home, syntheticCodec);
  const pending = await queue.enqueue(writeParams());
  let calls = 0;
  const execute = async params => { calls++; assert.deepEqual(params, writeParams()); return { content: [{ type: "text", text: "SYNTHETIC SUCCESS" }] }; };
  await assert.rejects(queue.approve(pending.id, "wrong-hash", execute), /hash/);
  assert.equal(calls, 0);
  assert.equal((await queue.approve(pending.id, pending.requestHash, execute)).status, "completed");
  await assert.rejects(queue.approve(pending.id, pending.requestHash, execute), /not be replayed/);
  assert.equal(calls, 1);
});

test("tampering, disabled integration, account changes and stale actions cannot authorize a write", async () => {
  const home = profile();
  configure({ profile: home, enable: true, acknowledge: true });
  selectSyntheticIdentity(home);
  let clock = Date.now();
  const queue = new ActionQueue(home, { ...syntheticCodec, now: () => clock });
  const pending = await queue.enqueue(writeParams());
  const neverExecute = async () => { assert.fail("A denied action must never execute."); };
  clock += 31 * 60_000;
  await assert.rejects(queue.approve(pending.id, pending.requestHash, neverExecute), /expired/);
  clock -= 31 * 60_000;
  writeSettings({ ...readSettings(home), selectedAccountId: "different-account" }, home);
  await assert.rejects(queue.approve(pending.id, pending.requestHash, neverExecute), /account changed/);
  await assert.rejects(queue.show(pending.id), /another Microsoft account/);
  selectSyntheticIdentity(home);
  const wrapper = JSON.parse(fs.readFileSync(queue.file(pending.id), "utf8"));
  wrapper.status = "completed";
  fs.writeFileSync(queue.file(pending.id), JSON.stringify(wrapper));
  await assert.rejects(queue.approve(pending.id, pending.requestHash, neverExecute), /integrity/);
  configure({ profile: home, enable: false });
  await assert.rejects(queue.approve(pending.id, pending.requestHash, neverExecute), /disabled/);
  assert.throws(() => queue.file("../outside"), /Invalid/);
});

test("an uncertain write outcome is terminal and cannot trigger automatic re-execution", async () => {
  const home = profile();
  configure({ profile: home, enable: true, acknowledge: true });
  selectSyntheticIdentity(home);
  const queue = new ActionQueue(home, syntheticCodec);
  const pending = await queue.enqueue(writeParams());
  let calls = 0;
  const result = await queue.approve(pending.id, pending.requestHash, async () => {
    calls++;
    throw Object.assign(new Error("PRIVATE_NETWORK_DETAIL"), { code: "ETIMEDOUT" });
  });
  assert.equal(result.status, "unknown");
  assert.doesNotMatch(JSON.stringify(result.error), /PRIVATE_NETWORK_DETAIL/);
  await assert.rejects(queue.approve(pending.id, pending.requestHash, async () => { calls++; }), /not be replayed/);
  assert.equal(calls, 1);
});

test("actions require a resolved tenant and cannot cross tenants of the same home account", async () => {
  const home = profile();
  configure({ profile: home, enable: true, acknowledge: true });
  const queue = new ActionQueue(home, syntheticCodec);
  await assert.rejects(queue.enqueue(writeParams()), /actual tenant binding/);
  selectSyntheticIdentity(home);
  const first = await queue.enqueue(writeParams());
  selectSyntheticIdentity(home, "selected-test-account", OTHER_TENANT);
  await assert.rejects(queue.show(first.id), /tenant selection/);
  await assert.rejects(queue.approve(first.id, first.requestHash, () => assert.fail("must not execute")), /tenant binding/);
  const second = await queue.enqueue(writeParams());
  assert.notEqual(second.id, first.id, "Identical content in different tenants must not deduplicate into one approval.");
  assert.equal((await queue.read(second.id)).tenantId, OTHER_TENANT);
});

test("old unbound action records require a fresh review and cannot inherit the new tenant", async () => {
  const home = profile();
  configure({ profile: home, enable: true, acknowledge: true });
  selectSyntheticIdentity(home);
  const queue = new ActionQueue(home, syntheticCodec);
  const pending = await queue.enqueue(writeParams());
  const legacy = await queue.read(pending.id);
  delete legacy.identityBindingSha256;
  delete legacy.tenantId;
  await queue.save(legacy);
  await assert.rejects(queue.show(pending.id), /fresh tenant-bound review/);
  await assert.rejects(queue.approve(pending.id, pending.requestHash, () => assert.fail("must not execute")), /tenant binding/);
  assert.notEqual((await queue.enqueue(writeParams())).id, pending.id);
});

test("a tenant change during approval persistence cancels before executing the cloud action", async () => {
  const home = profile();
  configure({ profile: home, enable: true, acknowledge: true });
  selectSyntheticIdentity(home);
  const queue = new ActionQueue(home, {
    ...syntheticCodec,
    protect: value => {
      if (JSON.parse(value).status === "executing") selectSyntheticIdentity(home, "selected-test-account", OTHER_TENANT);
      return syntheticCodec.protect(value);
    },
  });
  const pending = await queue.enqueue(writeParams());
  await assert.rejects(queue.approve(pending.id, pending.requestHash, () => assert.fail("must not execute")),
    /no operation was executed/);
  selectSyntheticIdentity(home);
  assert.equal((await queue.show(pending.id)).status, "cancelled");
});

test("non-interactive agent shell calls cannot approve queued actions", async () => {
  if (process.stdin.isTTY && process.stdout.isTTY) return;
  await assert.rejects(runWorkIq(["actions", "approve", "00000000-0000-4000-8000-000000000001"], {
    profile: profile(), output: () => {},
  }), /user's own interactive terminal/);
});

test("Desktop action review exposes no cloud call until explicit confirmation", async () => {
  const home = profile();
  configure({ profile: home, enable: true, acknowledge: true });
  selectSyntheticIdentity(home);
  const queue = new ActionQueue(home, syntheticCodec);
  const pending = await queue.enqueue(writeParams());
  let calls = 0;
  const handler = createDesktopWorkIqHandler(home, {
    actionQueue: queue,
    identityFactory: async () => ({}),
    upstreamFactory: () => ({
      async connect() {},
      async callTool(params) { calls++; assert.deepEqual(params, writeParams()); return { content: [{ type: "text", text: "SYNTHETIC RESULT" }] }; },
      async close() {},
    }),
  });
  await handler({ operation: "actions-list" });
  await handler({ operation: "action-show", actionId: pending.id });
  assert.equal(calls, 0);
  await assert.rejects(handler({ operation: "action-approve", actionId: pending.id }), /Explicit/);
  const completed = await handler({
    operation: "action-approve", actionId: pending.id, requestHash: pending.requestHash, confirmed: true,
  });
  assert.equal(completed.status, "completed");
  assert.equal(calls, 1);
});

test("authorization is confined to the exact Work IQ resource; redirects and auth replay are disabled", async () => {
  let tokenCalls = 0;
  const requests = [];
  const send = authorizedFetch({ token: async () => { tokenCalls++; return "TEST_ONLY"; } }, {
    fetchImpl: async (url, init) => {
      requests.push({ url, init });
      return new Response("unauthorized", { status: 401 });
    },
  });
  for (const target of [
    "https://example.test/mcp",
    "http://workiq.svc.cloud.microsoft/mcp",
    "https://workiq.svc.cloud.microsoft/not-mcp",
    "https://user:password@workiq.svc.cloud.microsoft/mcp",
  ]) {
    await assert.rejects(send(target), /destination/);
  }
  assert.equal(tokenCalls, 0);
  const response = await send(ENDPOINT, { method: "POST", body: "synthetic-request" });
  assert.equal(response.status, 401);
  assert.equal(requests.length, 1, "401 must not replay a request");
  assert.equal(requests[0].init.redirect, "error");
  assert.equal(requests[0].init.headers.get("authorization"), "Bearer TEST_ONLY");
});

test("public discovery validates resource and authority without requesting credentials", async () => {
  const metadata = {
    resource: ENDPOINT,
    authorization_servers: ["https://login.microsoftonline.com/organizations/v2.0"],
    scopes_supported: SCOPES,
  };
  assert.deepEqual(await discoverEndpoint({ fetchImpl: async () => Response.json(metadata) }), metadata);
  await assert.rejects(discoverEndpoint({ fetchImpl: async () => Response.json({ ...metadata, resource: "https://example.test/" }) }), /unexpected/);
  await assert.rejects(discoverEndpoint({ fetchImpl: async () => Response.json({ ...metadata, authorization_servers: [] }) }), /unexpected/);
  await assert.rejects(discoverEndpoint({ fetchImpl: async () => Response.json({ ...metadata, authorization_servers: ["https://example.test/"] }) }), /unexpected/);
});

test("capability receipts record actual names and schema hashes, not enterprise content or inflated proof", () => {
  const receipt = capabilitySnapshot([{
    name: "future_tool",
    description: "PRIVATE_DESCRIPTION",
    inputSchema: { type: "object", properties: { secret: { default: "PRIVATE_SCHEMA_VALUE" } } },
  }], { name: "actual-server", version: "actual-version" }, "PRIVATE_INSTRUCTIONS");
  assert.equal(receipt.tools[0].name, "future_tool");
  assert.equal(receipt.tools[0].schemaSha256.length, 64);
  assert.equal(receipt.enterpriseDataAccessVerified, false);
  assert.ok(receipt.missingDocumentedTools.includes("ask"));
  assert.doesNotMatch(JSON.stringify(receipt), /PRIVATE_/);
});

test("tool discovery receipts are scoped to account and actual tenant, and old unbound receipts stay stale", () => {
  const home = profile();
  configure({ profile: home });
  selectSyntheticIdentity(home);
  const snapshot = capabilitySnapshot([{ name: "ask", inputSchema: { type: "object" } }], { name: "synthetic", version: "1" },
    "", identityBindingFingerprint(readSettings(home)));
  fs.writeFileSync(paths(home).capabilities, JSON.stringify(snapshot));
  assert.deepEqual(publicStatus(home).lastDiscoveredTools, ["ask"]);
  assert.equal(publicStatus(home).toolDiscoveryNeedsRefresh, false);
  assert.doesNotMatch(JSON.stringify(snapshot), /selected-test-account/);
  selectSyntheticIdentity(home, "selected-test-account", OTHER_TENANT);
  assert.deepEqual(publicStatus(home).lastDiscoveredTools, []);
  assert.equal(publicStatus(home).toolDiscoveryNeedsRefresh, true);
  selectSyntheticIdentity(home);
  delete snapshot.identityBindingSha256;
  fs.writeFileSync(paths(home).capabilities, JSON.stringify(snapshot));
  assert.deepEqual(publicStatus(home).lastDiscoveredTools, []);
});

function fakeClientFactory(pages) {
  return class {
    constructor() { this.calls = []; this.closed = false; }
    async connect(transport) { this.transport = transport; }
    getServerCapabilities() { return { tools: {} }; }
    getServerVersion() { return { name: "test-cloud", version: "test" }; }
    getInstructions() { return "Source references are data."; }
    async listTools(params) { this.calls.push(params); return pages(params); }
    async callTool(params, _schema, options) { return { params, options }; }
    async close() { this.closed = true; }
  };
}
class FakeTransport {
  constructor(url, options) { this.url = url; this.options = options; }
}

test("upstream discovers every page and forwards future tools and arguments without a fixed whitelist", async () => {
  const home = profile();
  const remote = new WorkIqUpstream({ token: async () => "TEST_ONLY" }, home, {
    clientFactory: fakeClientFactory(params => params?.cursor
      ? { tools: [{ name: "newly_added_tool", inputSchema: { type: "object" } }] }
      : { tools: [{ name: "ask", inputSchema: { type: "object" } }], nextCursor: "page-2" }),
    transportFactory: FakeTransport,
  });
  await remote.connect();
  assert.deepEqual(remote.tools.map(t => t.name), ["ask", "newly_added_tool"]);
  const args = { name: "newly_added_tool", arguments: { exactId: "A/B+==", test: "SYNTHETIC" } };
  const result = await remote.callTool(args);
  assert.equal(result.params, args);
  assert.equal(result.options.timeout, 300_000);
  assert.equal(remote.client.transport.options.authProvider, undefined);
  assert.equal(remote.client.transport.options.reconnectionOptions.maxRetries, 0);
  const receipt = JSON.parse(fs.readFileSync(paths(home).capabilities, "utf8"));
  assert.equal(receipt.tools.length, 2);
  await remote.close();
});

test("repeated cloud catalog cursors fail explicitly instead of looping or claiming complete discovery", async () => {
  const home = profile();
  const remote = new WorkIqUpstream({ token: async () => "TEST_ONLY" }, home, {
    clientFactory: fakeClientFactory(() => ({ tools: [], nextCursor: "same-cursor" })),
    transportFactory: FakeTransport,
  });
  await assert.rejects(remote.connect(), /repeated/);
  assert.equal(remote.client, null);
  assert.equal(fs.existsSync(paths(home).capabilities), false);
});

test("CLI local status is non-mutating and clearly distinguishes metadata from verified access", async () => {
  const home = profile();
  const output = [];
  await runWorkIq(["status"], { profile: home, output: value => output.push(value) });
  const state = JSON.parse(output.join(""));
  assert.equal(state.configured, false);
  assert.equal(state.authentication, "not_checked");
  assert.equal(fs.existsSync(paths(home).state), false);
  const help = [];
  await runWorkIq(["--help"], { profile: home, output: value => help.push(value) });
  assert.match(help.join(""), /never opens a window/);
  assert.match(DATA_NOTICE, /selected model provider/);
});

test("Desktop status and enable/disable use the same settings as CLI without starting sign-in", async () => {
  const home = profile();
  let identitiesCreated = 0;
  const handler = createDesktopWorkIqHandler(home, { identityFactory: async () => { identitiesCreated++; throw new Error("must not run"); } });
  assert.equal((await handler({ operation: "status" })).enabled, false);
  await assert.rejects(handler({ operation: "enable" }), /acknowledgement/);
  await handler({ operation: "enable", acknowledge: true });
  assert.equal(publicStatus(home).enabled, true);
  await handler({ operation: "disable" });
  assert.equal(publicStatus(home).enabled, false);
  assert.equal(identitiesCreated, 0);
  await assert.rejects(handler({ operation: "arbitrary-shell-command" }), /Unsupported/);
});

test("Desktop device-code polling never exposes a device secret or access token and supports cancellation", async () => {
  const home = profile();
  for (const packagePath of [
    ["@azure", "msal-node"], ["@modelcontextprotocol", "sdk"],
  ]) {
    const directory = path.join(paths(home).runtime, "node_modules", ...packagePath);
    fs.mkdirSync(directory, { recursive: true });
    fs.writeFileSync(path.join(directory, "package.json"), "{}");
  }
  const handler = createDesktopWorkIqHandler(home, {
    identityFactory: async () => ({
      async login(callback, { signal }) {
        callback({
          verificationUri: "https://microsoft.com/devicelogin", userCode: "TEST-CODE",
          deviceCode: "PRIVATE_DEVICE_SECRET", accessToken: "PRIVATE_ACCESS_TOKEN", expiresIn: 900,
        });
        await new Promise(resolve => signal.addEventListener("abort", resolve, { once: true }));
        throw new LoginRequiredError("login_cancelled");
      },
    }),
  });
  const session = await handler({ operation: "login-start", method: "device-code" });
  await delay(0);
  const pending = await handler({ operation: "login-status", sessionId: session.id });
  assert.equal(pending.status, "pending");
  assert.equal(pending.userCode, "TEST-CODE");
  assert.doesNotMatch(JSON.stringify(pending), /PRIVATE_/);
  const cancelled = await handler({ operation: "login-cancel", sessionId: session.id });
  assert.equal(cancelled.status, "cancelled");
  assert.equal(cancelled.userCode, undefined);
  assert.equal(publicStatus(home).enabled, false);
});

test("all launchers and the Desktop account panel route to the shared integration", () => {
  const windows = fs.readFileSync(path.join(root, "bin", "codex-copilot.cmd"), "utf8");
  const unix = fs.readFileSync(path.join(root, "platforms", "unix", "bin", "codex-copilot"), "utf8");
  const desktop = fs.readFileSync(path.join(root, "bridge", "desktop-patch.mjs"), "utf8");
  assert.match(windows, /"%CC_SUB%"=="workiq"\s+goto :run_bridge_cli/);
  assert.match(unix, /doctor\|workiq\|verify/);
  assert.match(desktop, /createDesktopWorkIqHandler\(CODEX_COPILOT_HOME\)/);
  assert.match(desktop, /Microsoft 365 \/ Work IQ/);
  assert.match(desktop, /Sign in \(device code\)/);
  assert.match(desktop, /workIqRequest\('enable', \{ acknowledge: true \}\)/);
  const patchBody = desktop.match(/function buildAccountUiPatch\(\) \{([\s\S]*?)\r?\n\}\r?\n\r?\nfunction /)?.[1];
  assert.ok(patchBody, "Desktop account UI generator must be independently parseable.");
  const generated = new Function("quotaSnapshotText", "quotaSnapshotFreshness", patchBody)(
    quotaSnapshotText, quotaSnapshotFreshness);
  assert.doesNotThrow(() => new vm.Script(generated), "Generated Desktop JavaScript must parse, not just its template source.");
});

const dependencyProfile = process.env.WORKIQ_TEST_DEPENDENCY_PROFILE;
const requireIntegration = process.env.WORKIQ_REQUIRE_RUNTIME_TESTS === "1";
test("required Work IQ integration dependencies are provided by the test gate", () => {
  if (requireIntegration) assert.ok(dependencyProfile, "WORKIQ_TEST_DEPENDENCY_PROFILE is required.");
});

test("real pinned MSAL cache exposes two tenant profiles and the adapter selects the requested profile", { skip: !dependencyProfile }, async () => {
  const home = profile();
  configure({ profile: home });
  const accountId = `00000000-0000-4000-8000-000000000099.${TEST_TENANT}`;
  selectSyntheticIdentity(home, accountId, OTHER_TENANT);
  const { PublicClientApplication } = await runtimeImport("@azure/msal-node", dependencyProfile);
  const app = new PublicClientApplication({ auth: { clientId: CLIENT_ID } });
  const tenantProfiles = [TEST_TENANT, OTHER_TENANT].map(tenantId => ({
    tenantId, localAccountId: tenantId, name: "Synthetic tenant profile", isHomeTenant: tenantId === TEST_TENANT,
  }));
  app.getTokenCache().deserialize(JSON.stringify({
    Account: {
      [`${accountId}-login.windows.net-${TEST_TENANT}`]: {
        home_account_id: accountId, environment: "login.windows.net", realm: TEST_TENANT,
        local_account_id: tenantProfiles[0].localAccountId, username: "synthetic@example.test",
        authority_type: "MSSTS", tenantProfiles: tenantProfiles.map(value => JSON.stringify(value)),
      },
    },
  }));
  assert.deepEqual((await app.getTokenCache().getAllAccounts()).map(account => account.tenantId), [TEST_TENANT, OTHER_TENANT]);
  // Only token acquisition is synthetic; account deserialization and cache
  // enumeration above use the installed, pinned Microsoft library.
  let selected;
  app.acquireTokenSilent = async request => {
    selected = request;
    return { accessToken: "TEST_ONLY", account: request.account, tenantId: request.account.tenantId };
  };
  const identity = await createIdentity(home, { applicationFactory: () => app, cachePlugin: {} });
  assert.equal(await identity.token(), "TEST_ONLY");
  assert.equal(selected.account.tenantId, OTHER_TENANT);
  assert.equal(selected.authority, `https://login.microsoftonline.com/${OTHER_TENANT}`);
});

test("real MCP protocol preserves the cloud tool schemas, citations, structured content and isError", { skip: !dependencyProfile }, async () => {
  const home = profile();
  configure({ profile: home, enable: true, acknowledge: true });
  const { Server } = await runtimeImport("@modelcontextprotocol/sdk/server/index.js", dependencyProfile);
  const { Client } = await runtimeImport("@modelcontextprotocol/sdk/client/index.js", dependencyProfile);
  const { InMemoryTransport } = await runtimeImport("@modelcontextprotocol/sdk/inMemory.js", dependencyProfile);
  const types = await runtimeImport("@modelcontextprotocol/sdk/types.js", dependencyProfile);
  const tool = {
    name: "future_tool",
    description: "Synthetic cloud tool",
    inputSchema: { type: "object", properties: { value: { type: "string" } }, required: ["value"] },
    annotations: { readOnlyHint: true },
  };
  const expected = {
    content: [{ type: "text", text: "Synthetic evidence [1](https://example.test/evidence)" }],
    structuredContent: { source: "https://example.test/evidence", exactId: "A/B+==" },
    isError: true,
  };
  const remote = {
    client: null,
    denyRefresh: false,
    async connect() {
      if (this.denyRefresh) throw new LoginRequiredError("account_changed_refresh_mcp");
      this.client = {};
    },
    async listTools() { return [tool]; },
    async callTool(params) { assert.equal(params.arguments.value, "synthetic"); return expected; },
    async close() { this.client = null; },
  };
  const instance = await createWorkIqServer({ profile: home, identity: {}, upstream: remote, sdk: { Server, types } });
  const client = new Client({ name: "isolated-test", version: "1" }, { capabilities: {} });
  const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
  try {
    await instance.server.connect(serverTransport);
    await client.connect(clientTransport);
    const catalog = await client.listTools();
    assert.deepEqual(catalog.tools.map(t => t.name), [STATUS_TOOL, ACTION_STATUS_TOOL, CALL_TOOL, "future_tool"]);
    assert.deepEqual(catalog.tools[3].inputSchema, tool.inputSchema);
    assert.deepEqual(await client.callTool({ name: tool.name, arguments: { value: "synthetic" } }), expected);
    assert.deepEqual(await client.callTool({
      name: CALL_TOOL, arguments: { name: tool.name, arguments: { value: "synthetic" } },
    }), expected);
    remote.denyRefresh = true;
    const changed = JSON.parse((await client.callTool({ name: STATUS_TOOL, arguments: {} })).content[0].text);
    assert.equal(changed.connected, false);
    assert.equal(changed.authentication, "not_checked");
    assert.equal(changed.lastError.code, "account_changed_refresh_mcp");
    assert.deepEqual(changed.currentTools, []);
    configure({ profile: home, enable: false });
    const disabled = await client.callTool({ name: tool.name, arguments: { value: "synthetic" } });
    assert.equal(disabled.isError, true);
    assert.match(disabled.content[0].text, /selected model provider/);
  } finally {
    await client.close();
    await instance.close();
  }
});

test("real MCP initialization remains usable without login and does not expose inaccessible tool claims", { skip: !dependencyProfile }, async () => {
  const home = profile();
  configure({ profile: home, enable: true, acknowledge: true });
  const { Server } = await runtimeImport("@modelcontextprotocol/sdk/server/index.js", dependencyProfile);
  const { Client } = await runtimeImport("@modelcontextprotocol/sdk/client/index.js", dependencyProfile);
  const { InMemoryTransport } = await runtimeImport("@modelcontextprotocol/sdk/inMemory.js", dependencyProfile);
  const types = await runtimeImport("@modelcontextprotocol/sdk/types.js", dependencyProfile);
  const remote = {
    client: null,
    async connect() { throw new LoginRequiredError(); },
    async listTools() { throw new Error("must not list inaccessible tools"); },
    async close() {},
  };
  const instance = await createWorkIqServer({ profile: home, identity: {}, upstream: remote, sdk: { Server, types } });
  const client = new Client({ name: "isolated-test", version: "1" }, { capabilities: {} });
  const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
  try {
    await instance.server.connect(serverTransport);
    await client.connect(clientTransport);
    assert.deepEqual((await client.listTools()).tools.map(t => t.name), [STATUS_TOOL, ACTION_STATUS_TOOL, CALL_TOOL]);
    const response = await client.callTool({ name: STATUS_TOOL, arguments: {} });
    const status = JSON.parse(response.content[0].text);
    assert.equal(status.connected, false);
    assert.equal(status.lastError.code, "login_required");
    assert.deepEqual(status.currentTools, []);
  } finally {
    await client.close();
    await instance.close();
  }
});

test("real MCP write calls return an approval receipt even when the host itself preapproves tools", { skip: !dependencyProfile }, async () => {
  const home = profile();
  configure({ profile: home, enable: true, acknowledge: true });
  selectSyntheticIdentity(home);
  const { Server } = await runtimeImport("@modelcontextprotocol/sdk/server/index.js", dependencyProfile);
  const { Client } = await runtimeImport("@modelcontextprotocol/sdk/client/index.js", dependencyProfile);
  const { InMemoryTransport } = await runtimeImport("@modelcontextprotocol/sdk/inMemory.js", dependencyProfile);
  const types = await runtimeImport("@modelcontextprotocol/sdk/types.js", dependencyProfile);
  const queue = new ActionQueue(home, syntheticCodec);
  let calls = 0;
  const remote = {
    client: null,
    async connect() { this.client = {}; },
    async listTools() { return [{ name: "do_action", inputSchema: { type: "object", additionalProperties: true }, annotations: { readOnlyHint: false } }]; },
    async callTool() { calls++; return { content: [] }; },
    async close() {},
  };
  const instance = await createWorkIqServer({ profile: home, identity: {}, upstream: remote, sdk: { Server, types }, actions: queue });
  const client = new Client({ name: "preapproving-test-host", version: "1" }, { capabilities: {} });
  const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
  try {
    await instance.server.connect(serverTransport);
    await client.connect(clientTransport);
    await client.listTools();
    const result = await client.callTool(writeParams());
    assert.equal(result.isError, true);
    assert.equal(result.structuredContent.executed, false);
    assert.equal(result.structuredContent.status, "approval_required");
    assert.equal(calls, 0);
    const state = await client.callTool({ name: ACTION_STATUS_TOOL, arguments: { id: result.structuredContent.id } });
    assert.equal(state.structuredContent.status, "pending");
    assert.equal(calls, 0);
    const dispatched = await client.callTool({
      name: CALL_TOOL, arguments: { name: "do_action", arguments: writeParams().arguments },
    });
    assert.equal(dispatched.isError, true);
    assert.equal(dispatched.structuredContent.executed, false);
    assert.equal(dispatched.structuredContent.status, "approval_required");
    assert.equal(calls, 0, "The compatibility tool must not bypass the user-only write approval queue.");
  } finally {
    await client.close();
    await instance.close();
  }
});

test("the installed native ccodex core parses the shared MCP configuration in an isolated profile", {
  skip: !process.env.CCODEX_WORKIQ_NATIVE_CORE,
}, () => {
  const home = profile();
  configure({ profile: home });
  const result = spawnSync(process.env.CCODEX_WORKIQ_NATIVE_CORE, ["mcp", "list", "--json"], {
    env: { ...process.env, CODEX_HOME: home, CODEX_COPILOT_HOME: home, CODEX_COPILOT_AUTH_MODE: "saved" },
    cwd: home,
    windowsHide: true, encoding: "utf8", timeout: 20_000,
  });
  assert.equal(result.status, 0, result.stderr);
  const entry = JSON.parse(result.stdout).find(server => server.name === "workiq");
  assert.ok(entry, result.stdout);
  assert.equal(entry.enabled, false);
  assert.equal(entry.transport.command, process.execPath);
});

test("real Streamable HTTP transport carries cloud MCP results and progress without replaying actions", { skip: !dependencyProfile }, async () => {
  const home = profile();
  const { Server } = await runtimeImport("@modelcontextprotocol/sdk/server/index.js", dependencyProfile);
  const { StreamableHTTPServerTransport } = await runtimeImport("@modelcontextprotocol/sdk/server/streamableHttp.js", dependencyProfile);
  const types = await runtimeImport("@modelcontextprotocol/sdk/types.js", dependencyProfile);
  const cloud = new Server({ name: "synthetic-cloud", version: "test-only" }, {
    capabilities: { tools: {} }, instructions: "SYNTHETIC SERVICE; NOT MICROSOFT DATA.",
  });
  const transport = new StreamableHTTPServerTransport({ sessionIdGenerator: () => randomUUID() });
  const expected = {
    content: [{ type: "text", text: "Synthetic reference: https://example.test/source" }],
    structuredContent: { exact: "Opaque/A+B==" },
    isError: false,
  };
  let toolCalls = 0;
  cloud.setRequestHandler(types.ListToolsRequestSchema, async () => ({
    tools: [{ name: "fetch", inputSchema: { type: "object", properties: {}, additionalProperties: false } }],
  }));
  cloud.setRequestHandler(types.CallToolRequestSchema, async (request, extra) => {
    toolCalls++;
    if (request.params._meta?.progressToken !== undefined) {
      await extra.sendNotification({
        method: "notifications/progress",
        params: { progressToken: request.params._meta.progressToken, progress: 1, total: 2 },
      });
    }
    return expected;
  });
  await cloud.connect(transport);
  const listener = http.createServer(async (req, res) => {
    try {
      assert.equal(req.headers.authorization, "Bearer SYNTHETIC_TOKEN");
      let body;
      if (req.method === "POST") {
        const chunks = [];
        for await (const chunk of req) chunks.push(chunk);
        body = JSON.parse(Buffer.concat(chunks).toString());
      }
      await transport.handleRequest(req, res, body);
    } catch {
      if (!res.headersSent) res.writeHead(500);
      res.end();
    }
  });
  await new Promise(resolve => listener.listen(0, "127.0.0.1", resolve));
  const localUrl = `http://127.0.0.1:${listener.address().port}/mcp`;
  const { Client } = await runtimeImport("@modelcontextprotocol/sdk/client/index.js", dependencyProfile);
  const { StreamableHTTPClientTransport } = await runtimeImport("@modelcontextprotocol/sdk/client/streamableHttp.js", dependencyProfile);
  const remote = new WorkIqUpstream({ token: async () => "SYNTHETIC_TOKEN" }, home, {
    clientFactory: Client,
    transportFactory: StreamableHTTPClientTransport,
    fetchImpl: (_cloudUrl, init) => fetch(localUrl, init),
  });
  try {
    await remote.connect();
    const progress = [];
    assert.deepEqual(await remote.callTool({ name: "fetch", arguments: {} }, {
      onprogress: value => progress.push(value),
    }), expected);
    assert.equal(toolCalls, 1);
    assert.equal(progress[0]?.progress, 1);
    assert.equal(JSON.parse(fs.readFileSync(paths(home).capabilities)).server.name, "synthetic-cloud");
  } finally {
    await remote.close();
    await cloud.close();
    listener.closeAllConnections();
    await new Promise(resolve => listener.close(resolve));
  }
});

test("native Desktop app-server discovers read, write, and future tools through the same adapter without launching a GUI", {
  skip: !process.env.CCODEX_WORKIQ_NATIVE_CORE || !dependencyProfile,
}, async t => {
  const home = profile();
  writeConfig(home, [
    'model = "synthetic-model"',
    'model_provider = "synthetic-provider"',
    'check_for_update_on_startup = false',
    'cli_auth_credentials_store = "file"',
    'mcp_oauth_credentials_store = "file"',
    'approval_policy = "never"',
    'sandbox_mode = "danger-full-access"',
    '[model_providers.synthetic-provider]',
    'name = "Synthetic test provider"',
    'base_url = "http://127.0.0.1:1"',
    'wire_api = "responses"',
    'requires_openai_auth = false',
    "",
  ].join("\n"));
  configure({
    profile: home, enable: true, acknowledge: true,
    entry: path.join(root, "tests", "fixtures", "workiq", "mcp-server.mjs"),
  });
  const config = fs.readFileSync(paths(home).config, "utf8");
  writeConfig(home, config.replace(END_MARKER, [
    `WORKIQ_TEST_DEPENDENCY_PROFILE = ${JSON.stringify(dependencyProfile)}`,
    'WORKIQ_REQUIRE_RUNTIME_TESTS = "1"',
    END_MARKER,
  ].join("\n")));
  const env = { ...process.env, CODEX_HOME: home, CODEX_COPILOT_HOME: home, CODEX_COPILOT_AUTH_MODE: "saved" };
  for (const key of Object.keys(env)) {
    if (/(?:^|_)(?:TOKEN|SECRET|PASSWORD|API_KEY)(?:$|_)/i.test(key)) delete env[key];
  }
  const child = spawn(process.env.CCODEX_WORKIQ_NATIVE_CORE, ["app-server"], {
    env, cwd: home, windowsHide: true, stdio: ["pipe", "pipe", "pipe"],
  });
  t.diagnostic(`Isolated native Desktop app-server PID: ${child.pid}`);
  const pending = new Map();
  let buffer = "";
  let errors = "";
  let nextId = 0;
  let exitCode;
  const exited = new Promise(resolve => child.once("exit", code => {
    exitCode = code;
    for (const waiter of pending.values()) waiter.reject(new Error(`Isolated app-server exited (${code}): ${errors.slice(-4000)}`));
    resolve();
  }));
  const closed = new Promise(resolve => child.once("close", resolve));
  child.stderr.on("data", chunk => { errors = (errors + chunk).slice(-16_000); });
  child.stdout.setEncoding("utf8");
  child.stdout.on("data", chunk => {
    buffer += chunk;
    for (;;) {
      const end = buffer.indexOf("\n");
      if (end < 0) break;
      const line = buffer.slice(0, end);
      buffer = buffer.slice(end + 1);
      if (!line.trim()) continue;
      const message = JSON.parse(line);
      const waiter = pending.get(message.id);
      if (waiter) {
        pending.delete(message.id);
        if (message.error) waiter.reject(new Error(JSON.stringify(message.error)));
        else waiter.resolve(message.result);
      }
    }
  });
  const request = (method, params) => new Promise((resolve, reject) => {
    const id = ++nextId;
    const timeout = setTimeout(() => {
      pending.delete(id);
      reject(new Error(`Isolated app-server request timed out: ${method}. ${errors.slice(-2000)}`));
    }, 30_000);
    pending.set(id, {
      resolve: value => { clearTimeout(timeout); resolve(value); },
      reject: error => { clearTimeout(timeout); reject(error); },
    });
    child.stdin.write(`${JSON.stringify({ jsonrpc: "2.0", id, method, params })}\n`);
  });
  try {
    await request("initialize", {
      clientInfo: { name: "workiq-isolated-test", version: "0.1.0" },
      capabilities: { experimentalApi: true },
    });
    child.stdin.write(`${JSON.stringify({ jsonrpc: "2.0", method: "initialized" })}\n`);
    const effective = await request("config/read", { includeLayers: true, cwd: home });
    assert.ok(JSON.stringify(effective).includes("synthetic-provider"));
    const catalog = await request("mcpServerStatus/list", {});
    const workiq = catalog.data.find(server => server.name === "workiq");
    assert.ok(workiq, JSON.stringify(catalog));
    assert.deepEqual(Object.keys(workiq.tools).sort(), [STATUS_TOOL, ACTION_STATUS_TOOL, CALL_TOOL, "create_entity", "fetch", "future_workiq_tool"].sort());
    assert.match(workiq.tools.fetch.description, /SYNTHETIC/);
    t.diagnostic(`Verified native Desktop app-server PID ${child.pid} against isolated synthetic MCP, without a renderer or real enterprise data.`);
  } finally {
    const shutdownStarted = Date.now();
    child.stdin.end();
    let exitTimer;
    try {
      await Promise.race([
        closed,
        new Promise((_, reject) => {
          exitTimer = setTimeout(() => {
            // Only the process this test just created, never a live user's app.
            const stillRunning = child.exitCode === null;
            if (stillRunning) child.kill();
            reject(new Error(`Isolated app-server teardown exceeded its bound; processStillRunning=${stillRunning}.`));
          // BelowNormal workers share six job slots; wait for both process exit
          // and pipe closure, without running repository discovery in the source.
          }, 15_000);
        }),
      ]);
    } finally {
      clearTimeout(exitTimer);
    }
    await exited;
    assert.equal(exitCode, 0, errors);
    t.diagnostic(`Isolated native Desktop app-server PID ${child.pid} exited and closed its pipes in ${Date.now() - shutdownStarted} ms.`);
  }
});

test.after(async () => {
  const resolved = fs.realpathSync(testRoot);
  assert.equal(path.dirname(resolved).toLowerCase(), fs.realpathSync(os.tmpdir()).toLowerCase());
  assert.match(path.basename(resolved), /^ccodex-workiq-test-/);
  // Async cleanup lets Windows child-pipe/directory close callbacks drain.
  // Synchronous retries can prevent the very close events they are waiting for.
  await fs.promises.rm(resolved, { recursive: true, force: true, maxRetries: 12, retryDelay: 100 });
});

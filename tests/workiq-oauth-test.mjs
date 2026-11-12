import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import fs from "node:fs";
import http from "node:http";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { setTimeout as delay } from "node:timers/promises";
import { acquireByAuthorizationCode, OAuthCodeError } from "../bridge/workiq/oauth-code.mjs";
import { createIdentity, safeAuthError, safeWorkIqError } from "../bridge/workiq/auth.mjs";
import { CLIENT_ID, OAUTH_CALLBACK_PORT, SCOPES, configure, paths, readSettings, writeSettings, publicStatus } from "../bridge/workiq/settings.mjs";
import { createDesktopWorkIqHandler } from "../bridge/workiq/desktop.mjs";
import { runtimeImport } from "../bridge/workiq/dependencies.mjs";
import { runWorkIq } from "../bridge/workiq/main.mjs";

const TEST_TENANT = "00000000-0000-4000-8000-000000000001";
const OTHER_TENANT = "00000000-0000-4000-8000-000000000002";
const testRoot = fs.mkdtempSync(path.join(os.tmpdir(), "ccodex-workiq-oauth-test-"));
let sequence = 0;
function profile() {
  const directory = path.join(testRoot, `profile-${++sequence}`);
  fs.mkdirSync(directory);
  return directory;
}
function authorizationAddress(request) {
  const address = new URL(`https://login.microsoftonline.com/${TEST_TENANT}/oauth2/v2.0/authorize`);
  for (const [key, value] of Object.entries({
    client_id: CLIENT_ID,
    redirect_uri: request.redirectUri,
    response_type: "code",
    response_mode: "query",
    scope: [...request.scopes, "openid", "profile", "offline_access"].join(" "),
    state: request.state, nonce: request.nonce,
    code_challenge: request.codeChallenge, code_challenge_method: request.codeChallengeMethod,
  })) address.searchParams.set(key, value);
  return address.href;
}
function fixture(overrides = {}) {
  const calls = [];
  const app = {
    async getAuthCodeUrl(request) {
      calls.push(["url", request]);
      return authorizationAddress(request);
    },
    async acquireTokenByCode(request) {
      calls.push(["redeem", request]);
      return {
        accessToken: "SYNTHETIC_ONLY_NOT_A_REAL_ACCESS_TOKEN",
        idTokenClaims: { nonce: request.nonce, tid: TEST_TENANT },
        tenantId: TEST_TENANT,
        account: { homeAccountId: "synthetic-home", tenantId: TEST_TENANT },
      };
    },
    ...overrides,
  };
  return { app, calls };
}
function callbackUrl(address, parameters = {}) {
  const url = new URL(address.redirectUri);
  url.searchParams.set("state", new URL(address.authorizationUri).searchParams.get("state"));
  url.searchParams.set("code", "SYNTHETIC_AUTHORIZATION_CODE");
  for (const [key, value] of Object.entries(parameters)) url.searchParams.set(key, value);
  return url;
}
async function sendCallback(url, options = {}) {
  // Real loopback I/O, never an external identity-provider or model request.
  return new Promise((resolve, reject) => {
    const request = http.request(url, { method: options.method || "GET", headers: options.headers, agent: false }, response => {
      let body = "";
      response.on("data", chunk => { body += chunk; });
      response.on("end", () => resolve({ status: response.statusCode, headers: response.headers, body }));
    });
    request.on("error", reject);
    request.setTimeout(2000, () => request.destroy(new Error("Synthetic callback timed out.")));
    request.end();
  });
}
function initializeRuntimeMarkers(home) {
  for (const name of [["@azure", "msal-node"], ["@modelcontextprotocol", "sdk"]]) {
    const directory = path.join(paths(home).runtime, "node_modules", ...name);
    fs.mkdirSync(directory, { recursive: true });
    fs.writeFileSync(path.join(directory, "package.json"), "{}");
  }
}

test("authorization code flow uses loopback root, S256, nonce, exact scopes and one redemption", async () => {
  assert.equal(OAUTH_CALLBACK_PORT, 12798);
  const { app, calls } = fixture();
  let displayed;
  const result = await acquireByAuthorizationCode(app, {
    port: 0,
    onAuthorization: async address => {
      displayed = address;
      assert.match(address.redirectUri, /^http:\/\/127\.0\.0\.1:\d+\/$/);
      assert.equal(address.method, "authorization_code");
      const response = await sendCallback(callbackUrl(address));
      assert.equal(response.status, 200);
      assert.equal(response.headers["cache-control"], "no-store");
      assert.doesNotMatch(response.body, /SYNTHETIC_AUTHORIZATION_CODE|state=/);
    },
  });
  assert.equal(result.tenantId, TEST_TENANT);
  assert.deepEqual(calls.map(call => call[0]), ["url", "redeem"]);
  const request = calls[0][1];
  const redemption = calls[1][1];
  assert.equal(createHash("sha256").update(redemption.codeVerifier).digest("base64url"), request.codeChallenge);
  assert.equal(redemption.nonce, request.nonce);
  assert.equal(redemption.redirectUri, request.redirectUri);
  assert.deepEqual(redemption.scopes, SCOPES);
  assert.equal(redemption.code, "SYNTHETIC_AUTHORIZATION_CODE");
  assert.doesNotMatch(JSON.stringify(displayed), /SYNTHETIC_ONLY|codeVerifier|SYNTHETIC_AUTHORIZATION_CODE/);
  await assert.rejects(sendCallback(new URL(displayed.redirectUri)), /ECONNREFUSED/);
});

test("invalid state, callback host, method, path and duplicate code never redeem a credential", async () => {
  const { app, calls } = fixture();
  await acquireByAuthorizationCode(app, {
    port: 0,
    onAuthorization: async address => {
      assert.equal((await sendCallback(callbackUrl(address, { state: "ATTACKER_STATE" }))).status, 400);
      assert.equal((await sendCallback(callbackUrl(address), { headers: { host: "attacker.invalid" } })).status, 400);
      assert.equal((await sendCallback(callbackUrl(address), { method: "POST" })).status, 405);
      const wrongPath = callbackUrl(address);
      wrongPath.pathname = "/callback";
      assert.equal((await sendCallback(wrongPath)).status, 404);
      const duplicateCode = callbackUrl(address);
      duplicateCode.searchParams.append("code", "SECOND_CODE");
      assert.equal((await sendCallback(duplicateCode)).status, 400);
      const duplicateState = callbackUrl(address);
      duplicateState.searchParams.append("state", duplicateState.searchParams.get("state"));
      assert.equal((await sendCallback(duplicateState)).status, 400);
      assert.equal(calls.filter(call => call[0] === "redeem").length, 0);
      assert.equal((await sendCallback(callbackUrl(address))).status, 200);
      assert.equal((await sendCallback(callbackUrl(address))).status, 410);
    },
  });
  assert.equal(calls.filter(call => call[0] === "redeem").length, 1);
});

test("authorization denial is sanitized, terminal and never changes the requested grant or scope", async () => {
  const { app, calls } = fixture();
  const operation = acquireByAuthorizationCode(app, {
    port: 0,
    onAuthorization: async address => {
      const url = callbackUrl(address, { error: "access_denied", error_description: "PRIVATE_PROVIDER_DETAIL" });
      url.searchParams.delete("code");
      const response = await sendCallback(url);
      assert.equal(response.status, 400);
      assert.doesNotMatch(response.body, /PRIVATE_PROVIDER_DETAIL/);
    },
  });
  await assert.rejects(operation, error => {
    assert.equal(error.code, "oauth_authorization_denied");
    assert.doesNotMatch(JSON.stringify(safeAuthError(error)), /PRIVATE_PROVIDER_DETAIL/);
    assert.equal(safeWorkIqError(error).message, error.message);
    return true;
  });
  assert.deepEqual(calls.map(call => call[0]), ["url"]);
});

test("unexpected Microsoft authorization parameters are rejected before displaying an address", async () => {
  for (const mutation of [
    address => { address.hostname = "attacker.invalid"; },
    address => { address.pathname = "/adminconsent"; },
    address => { address.searchParams.set("client_id", "another-client"); },
    address => { address.searchParams.set("redirect_uri", "https://attacker.invalid/"); },
    address => { address.searchParams.set("state", "wrong-state"); },
    address => { address.searchParams.set("nonce", "wrong-nonce"); },
    address => { address.searchParams.set("code_challenge_method", "plain"); },
    address => { address.searchParams.set("response_type", "token"); },
    address => { address.searchParams.set("scope", `${SCOPES[0]} Directory.ReadWrite.All`); },
  ]) {
    const { app } = fixture({
      async getAuthCodeUrl(request) {
        const address = new URL(authorizationAddress(request));
        mutation(address);
        return address.href;
      },
      async acquireTokenByCode() { assert.fail("Unexpected address must never be redeemed."); },
    });
    await assert.rejects(acquireByAuthorizationCode(app, {
      port: 0, onAuthorization: () => assert.fail("Unexpected address must not be displayed."),
    }), error => error.code === "oauth_invalid_authorization_url");
  }
});

test("an ID-token nonce mismatch cannot complete sign-in", async () => {
  const { app } = fixture({
    async acquireTokenByCode() { return { idTokenClaims: { nonce: "WRONG_NONCE" } }; },
  });
  await assert.rejects(acquireByAuthorizationCode(app, {
    port: 0, onAuthorization: address => sendCallback(callbackUrl(address)),
  }), error => error.code === "oauth_nonce_mismatch");
});

test("a busy callback port is reported without stopping or interfering with its owner", async () => {
  const owner = http.createServer((_request, response) => response.end("SYNTHETIC_PORT_OWNER"));
  await new Promise(resolve => owner.listen(0, "127.0.0.1", resolve));
  const port = owner.address().port;
  try {
    await assert.rejects(acquireByAuthorizationCode(fixture().app, {
      port, onAuthorization: () => assert.fail("Port conflict must fail before an authorization address."),
    }), error => error.code === "oauth_callback_in_use");
    assert.equal((await sendCallback(new URL(`http://127.0.0.1:${port}/`))).body, "SYNTHETIC_PORT_OWNER");
  } finally { await new Promise(resolve => owner.close(resolve)); }
});

test("expiry includes metadata discovery and closes the listener without a background retry", async () => {
  const { app } = fixture({ getAuthCodeUrl: () => new Promise(() => {}) });
  await assert.rejects(acquireByAuthorizationCode(app, {
    port: 0, timeoutMs: 100,
    onAuthorization: () => assert.fail("No address exists while discovery is pending."),
  }), error => error.code === "oauth_login_expired");
});

test("cancellation before start or during callback wait never redeems a code", async () => {
  const before = new AbortController();
  before.abort();
  await assert.rejects(acquireByAuthorizationCode(fixture().app, {
    signal: before.signal, port: 0, onAuthorization: () => assert.fail("Cancelled."),
  }), error => error.code === "oauth_login_cancelled");
  const controller = new AbortController();
  const { app, calls } = fixture();
  let address;
  await assert.rejects(acquireByAuthorizationCode(app, {
    signal: controller.signal, port: 0,
    onAuthorization: value => { address = value; controller.abort(); },
  }), error => error.code === "oauth_login_cancelled");
  assert.equal(calls.filter(call => call[0] === "redeem").length, 0);
  await assert.rejects(sendCallback(new URL(address.redirectUri)), /ECONNREFUSED/);
});

test("identity commits only the successful authorization-code account and actual tenant", async () => {
  const home = profile();
  configure({ profile: home });
  const { app } = fixture();
  const identity = await createIdentity(home, {
    applicationFactory: () => app, cachePlugin: {},
    authorizationCodeFlow: (client, options) => acquireByAuthorizationCode(client, { ...options, port: 0 }),
  });
  const result = await identity.loginWithAuthorizationCode(address => sendCallback(callbackUrl(address)));
  assert.equal(result.method, "authorization_code");
  assert.equal(readSettings(home).selectedAccountId, "synthetic-home");
  assert.equal(readSettings(home).selectedTenantId, TEST_TENANT);
  assert.equal(publicStatus(home).lastAuthenticationMethod, "authorization_code");
  assert.equal(publicStatus(home).enabled, false, "Login does not silently enable model access.");
  assert.doesNotMatch(fs.readFileSync(paths(home).settings, "utf8"), /SYNTHETIC_ONLY|nonce|codeVerifier/);
});

test("authorization-code completion cannot replace a concurrent account/tenant selection", async () => {
  const home = profile();
  configure({ profile: home });
  const identity = await createIdentity(home, {
    applicationFactory: () => ({}), cachePlugin: {},
    authorizationCodeFlow: async () => {
      writeSettings({ ...readSettings(home), selectedAccountId: "concurrent-account", selectedTenantId: OTHER_TENANT }, home);
      return { accessToken: "SYNTHETIC", tenantId: TEST_TENANT, account: { homeAccountId: "stale-account", tenantId: TEST_TENANT } };
    },
  });
  await assert.rejects(identity.loginWithAuthorizationCode(() => {}), error => error.code === "account_changed_refresh_mcp");
  assert.equal(readSettings(home).selectedAccountId, "concurrent-account");
  assert.equal(readSettings(home).selectedTenantId, OTHER_TENANT);
});

test("authorization-code completion rejects a mismatched configured tenant", async () => {
  const home = profile();
  configure({ profile: home, tenant: TEST_TENANT });
  const identity = await createIdentity(home, {
    applicationFactory: () => ({}), cachePlugin: {},
    authorizationCodeFlow: async () => ({
      accessToken: "SYNTHETIC", tenantId: OTHER_TENANT,
      account: { homeAccountId: "wrong-tenant-account", tenantId: OTHER_TENANT },
    }),
  });
  await assert.rejects(identity.loginWithAuthorizationCode(() => {}), error => error.code === "token_identity_mismatch");
  assert.equal(readSettings(home).selectedAccountId, null);
});

test("cancellation during token exchange cannot bind the later returned result", async () => {
  const home = profile();
  const controller = new AbortController();
  const identity = await createIdentity(home, {
    applicationFactory: () => ({}), cachePlugin: {},
    authorizationCodeFlow: async () => {
      controller.abort();
      return { accessToken: "SYNTHETIC", tenantId: TEST_TENANT, account: { homeAccountId: "late-account", tenantId: TEST_TENANT } };
    },
  });
  await assert.rejects(identity.loginWithAuthorizationCode(() => {}, { signal: controller.signal }),
    error => error.code === "oauth_login_cancelled");
  assert.equal(readSettings(home).selectedAccountId, null);
});

test("CLI defaults to authorization code, keeps device code explicit, and validates before mutation", async () => {
  const home = profile();
  const methods = [];
  const output = [];
  const identityFactory = async () => ({
    async loginWithAuthorizationCode(callback) {
      methods.push("authorization-code");
      callback({ method: "authorization_code", authorizationUri: "https://login.microsoftonline.com/synthetic", redirectUri: "http://127.0.0.1:12798/", expiresInSeconds: 900 });
      return { authentication: "authenticated", method: "authorization_code" };
    },
    async login(callback) {
      methods.push("device-code");
      callback({ verificationUri: "https://microsoft.com/devicelogin", userCode: "SYNTHETIC", deviceCode: "PRIVATE_SECRET", expiresIn: 900 });
      return { authentication: "authenticated", method: "device_code" };
    },
  });
  const listenerCount = process.listenerCount("SIGINT");
  await runWorkIq(["login"], { profile: home, identityFactory, output: value => output.push(value) });
  await runWorkIq(["login", "--method", "device-code"], { profile: home, identityFactory, output: value => output.push(value) });
  assert.deepEqual(methods, ["authorization-code", "device-code"]);
  assert.equal(process.listenerCount("SIGINT"), listenerCount);
  assert.doesNotMatch(output.join(""), /PRIVATE_SECRET/);
  const untouched = profile();
  await assert.rejects(runWorkIq(["login", "--method", "unsupported"], { profile: untouched, identityFactory }), /Use --method/);
  assert.equal(fs.existsSync(paths(untouched).settings), false);
});

test("Desktop defaults to authorization code and publishes only its user-facing address", async () => {
  const home = profile();
  initializeRuntimeMarkers(home);
  const methods = [];
  const handler = createDesktopWorkIqHandler(home, {
    identityFactory: async () => ({
      async loginWithAuthorizationCode(callback, { signal }) {
        methods.push("authorization-code");
        callback({
          authorizationUri: "https://login.microsoftonline.com/synthetic",
          expiresInSeconds: 900,
          codeVerifier: "PRIVATE_PKCE_VERIFIER", accessToken: "PRIVATE_TOKEN",
        });
        await new Promise(resolve => signal.addEventListener("abort", resolve, { once: true }));
        throw new OAuthCodeError("oauth_login_cancelled");
      },
      async login() { assert.fail("No device-code fallback."); },
    }),
  });
  const session = await handler({ operation: "login-start" });
  await delay(0);
  const pending = await handler({ operation: "login-status", sessionId: session.id });
  assert.equal(pending.method, "authorization-code");
  assert.equal(pending.status, "pending");
  assert.equal(pending.authorizationUri, "https://login.microsoftonline.com/synthetic");
  assert.doesNotMatch(JSON.stringify(pending), /PRIVATE_|codeVerifier|accessToken/);
  assert.equal((await handler({ operation: "login-start" })).id, session.id);
  const cancelled = await handler({ operation: "login-cancel", sessionId: session.id });
  assert.equal(cancelled.authorizationUri, undefined);
  assert.deepEqual(methods, ["authorization-code"]);
  assert.equal(publicStatus(home).enabled, false);
});

const dependencyProfile = process.env.WORKIQ_TEST_DEPENDENCY_PROFILE;
test("real pinned MSAL generates the compatible PKCE URL and validates nonce before caching", { skip: !dependencyProfile }, async () => {
  const { PublicClientApplication } = await runtimeImport("@azure/msal-node", dependencyProfile);
  const metadata = {
    authorization_endpoint: `https://login.microsoftonline.com/${TEST_TENANT}/oauth2/v2.0/authorize`,
    token_endpoint: `https://login.microsoftonline.com/${TEST_TENANT}/oauth2/v2.0/token`,
    issuer: `https://login.microsoftonline.com/${TEST_TENANT}/v2.0`,
    end_session_endpoint: `https://login.microsoftonline.com/${TEST_TENANT}/oauth2/v2.0/logout`,
    jwks_uri: `https://login.microsoftonline.com/${TEST_TENANT}/discovery/v2.0/keys`,
  };
  let nonce;
  let incorrectNonce = false;
  const posts = [];
  const encode = value => Buffer.from(JSON.stringify(value)).toString("base64url");
  const app = new PublicClientApplication({
    auth: {
      clientId: CLIENT_ID,
      authority: `https://login.microsoftonline.com/${TEST_TENANT}`,
      authorityMetadata: JSON.stringify(metadata),
      cloudDiscoveryMetadata: JSON.stringify({
        tenant_discovery_endpoint: `https://login.microsoftonline.com/${TEST_TENANT}/v2.0/.well-known/openid-configuration`,
        metadata: [{ preferred_network: "login.microsoftonline.com", preferred_cache: "login.windows.net", aliases: ["login.microsoftonline.com", "login.windows.net"] }],
      }),
    },
    system: {
      loggerOptions: { piiLoggingEnabled: false, loggerCallback: () => {} },
      networkClient: {
        async sendGetRequestAsync() { assert.fail("Synthetic MSAL test must not use the network."); },
        async sendPostRequestAsync(url, options) {
          const destination = new URL(url);
          assert.equal(`${destination.origin}${destination.pathname}`, metadata.token_endpoint);
          const request = new URLSearchParams(options.body);
          posts.push(request);
          const now = Math.floor(Date.now() / 1000);
          const claims = {
            aud: CLIENT_ID, iss: metadata.issuer, iat: now, nbf: now, exp: now + 3600,
            oid: "00000000-0000-4000-8000-000000000003", sub: "synthetic-user",
            tid: TEST_TENANT, preferred_username: "synthetic@example.invalid",
            nonce: incorrectNonce ? "WRONG_NONCE" : nonce,
          };
          return { status: 200, headers: {}, body: {
            token_type: "Bearer", scope: SCOPES.join(" "), expires_in: 3600,
            access_token: "SYNTHETIC_TOKEN_NEVER_SENT_TO_A_SERVICE",
            id_token: `${encode({ alg: "RS256", typ: "JWT" })}.${encode(claims)}.SYNTHETIC_SIGNATURE`,
            client_info: encode({ uid: claims.oid, utid: TEST_TENANT }),
          } };
        },
      },
    },
  });
  const options = {
    port: 0,
    onAuthorization: async address => {
      nonce = new URL(address.authorizationUri).searchParams.get("nonce");
      assert.equal((await sendCallback(callbackUrl(address))).status, 200);
    },
  };
  const result = await acquireByAuthorizationCode(app, options);
  assert.equal(result.tenantId, TEST_TENANT);
  assert.equal(posts[0].get("grant_type"), "authorization_code");
  assert.ok(posts[0].get("code_verifier"));
  const before = app.getTokenCache().serialize();
  incorrectNonce = true;
  await assert.rejects(acquireByAuthorizationCode(app, options), error => error.errorCode === "nonce_mismatch");
  assert.equal(app.getTokenCache().serialize(), before, "Invalid nonce must be rejected before credential-cache mutation.");
});

test.after(async () => {
  const resolved = fs.realpathSync(testRoot);
  assert.equal(path.dirname(resolved).toLowerCase(), fs.realpathSync(os.tmpdir()).toLowerCase());
  assert.match(path.basename(resolved), /^ccodex-workiq-oauth-test-/);
  await fs.promises.rm(resolved, { recursive: true, force: true, maxRetries: 12, retryDelay: 100 });
});

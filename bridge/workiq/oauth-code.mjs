import http from "node:http";
import { createHash, randomBytes, timingSafeEqual } from "node:crypto";
import { CLIENT_ID, OAUTH_CALLBACK_PORT, SCOPES } from "./settings.mjs";

const MESSAGES = Object.freeze({
  oauth_callback_in_use: "Work IQ's registered callback port is in use. Finish the other sign-in and retry; no other process was stopped.",
  oauth_callback_failed: "The local Work IQ callback could not be started. No browser was opened.",
  oauth_login_expired: "This Work IQ sign-in expired. Start a new sign-in when convenient; no automatic retry occurred.",
  oauth_login_cancelled: "Work IQ sign-in was cancelled. No account selection was changed.",
  oauth_authorization_denied: "Microsoft did not authorize this sign-in. No alternate account, scope, or consent request was attempted.",
  oauth_invalid_authorization_url: "Microsoft returned an unexpected authorization address. It was not opened.",
  oauth_nonce_mismatch: "The sign-in response did not match this authorization request. No account was selected.",
});

export class OAuthCodeError extends Error {
  constructor(code) {
    super(MESSAGES[code] || "Work IQ authorization-code sign-in did not complete.");
    this.code = code;
  }
}

function raceAbort(promise, signal) {
  if (signal.aborted) {
    Promise.resolve(promise).catch(() => {});
    return Promise.reject(signal.reason);
  }
  return new Promise((resolve, reject) => {
    const abort = () => reject(signal.reason);
    signal.addEventListener("abort", abort, { once: true });
    Promise.resolve(promise).then(resolve, reject).finally(() => {
      signal.removeEventListener("abort", abort);
    });
  });
}

function equalState(actual, expected) {
  if (typeof actual !== "string") return false;
  const left = Buffer.from(actual);
  const right = Buffer.from(expected);
  return left.length === right.length && timingSafeEqual(left, right);
}

function reply(response, status, message) {
  response.writeHead(status, {
    "content-type": "text/plain; charset=utf-8",
    "cache-control": "no-store",
    "pragma": "no-cache",
    "referrer-policy": "no-referrer",
    "content-security-policy": "default-src 'none'; frame-ancestors 'none'",
    "x-content-type-options": "nosniff",
    "connection": "close",
  });
  response.end(message);
}

// This is an explicit user-started flow, not an HTTP/MCP authentication retry.
// The caller displays the address; this module never launches a browser, WAM,
// a shell, an admin-consent endpoint, or another application's credential store.
export async function acquireByAuthorizationCode(app, {
  onAuthorization,
  signal,
  port = OAUTH_CALLBACK_PORT,
  timeoutMs = 15 * 60_000,
} = {}) {
  if (typeof onAuthorization !== "function") throw new TypeError("An authorization-address callback is required.");
  if (!Number.isInteger(port) || port < 0 || port > 65535) throw new TypeError("Invalid loopback callback port.");
  if (!Number.isInteger(timeoutMs) || timeoutMs < 1 || timeoutMs > 15 * 60_000) throw new TypeError("Invalid sign-in timeout.");
  if (signal?.aborted) throw new OAuthCodeError("oauth_login_cancelled");

  const state = randomBytes(32).toString("base64url");
  const nonce = randomBytes(32).toString("base64url");
  const codeVerifier = randomBytes(48).toString("base64url");
  const codeChallenge = createHash("sha256").update(codeVerifier).digest("base64url");
  const controller = new AbortController();
  const expiresAt = Date.now() + timeoutMs;
  const cancel = () => controller.abort(new OAuthCodeError("oauth_login_cancelled"));
  signal?.addEventListener("abort", cancel, { once: true });
  const timer = setTimeout(() => controller.abort(new OAuthCodeError("oauth_login_expired")), timeoutMs);
  timer.unref();
  let redirectUri;
  let consumed = false;
  let closed = false;
  let resolveCode;
  let rejectCode;
  const callback = new Promise((resolve, reject) => { resolveCode = resolve; rejectCode = reject; });
  // A callback or cancellation can arrive while MSAL is discovering metadata.
  callback.catch(() => {});

  const server = http.createServer({ maxHeaderSize: 16 * 1024 }, (request, response) => {
    if (closed || consumed || controller.signal.aborted) return reply(response, 410, "This sign-in is no longer waiting for a response.");
    if (request.method !== "GET") return reply(response, 405, "Only the Microsoft authorization callback is accepted.");
    if (!redirectUri || request.headers.host !== new URL(redirectUri).host ||
        !request.url?.startsWith("/") || request.url.startsWith("//") || request.url.length > 16 * 1024) {
      return reply(response, 400, "Invalid callback address.");
    }
    const incoming = new URL(request.url, redirectUri);
    if (incoming.pathname !== "/") return reply(response, 404, "Not found.");
    const states = incoming.searchParams.getAll("state");
    if (states.length !== 1 || !equalState(states[0], state)) {
      return reply(response, 400, "This response does not match the pending sign-in.");
    }
    const codes = incoming.searchParams.getAll("code");
    const errors = incoming.searchParams.getAll("error");
    if (errors.length) {
      consumed = true;
      // Never reflect provider query strings, codes or error_description into HTML/logs.
      reply(response, 400, "Microsoft did not complete authorization. Return to ccodex for status.");
      rejectCode(new OAuthCodeError("oauth_authorization_denied"));
      return;
    }
    if (codes.length !== 1 || !codes[0] || codes[0].length > 12 * 1024) {
      return reply(response, 400, "The authorization response is incomplete.");
    }
    consumed = true;
    reply(response, 200, "Authorization response received. Return to ccodex to check whether sign-in completed.");
    resolveCode(codes[0]);
  });
  server.requestTimeout = 5000;
  server.headersTimeout = 5000;
  server.keepAliveTimeout = 1000;
  server.maxHeadersCount = 30;
  server.on("error", error => {
    controller.abort(new OAuthCodeError(error.code === "EADDRINUSE" ? "oauth_callback_in_use" : "oauth_callback_failed"));
  });
  try {
    const listening = new Promise(resolve => server.listen(port, "127.0.0.1", resolve));
    await raceAbort(listening, controller.signal);
    const boundPort = server.address()?.port;
    if (!boundPort) throw new OAuthCodeError("oauth_callback_failed");
    // GitHub Copilot's public-client MCP flow uses the loopback root, not
    // Codex 0.145's /callback/<server-id>. Production always uses the plugin's
    // registered port; port=0 exists only for isolated loopback tests.
    redirectUri = `http://127.0.0.1:${boundPort}/`;
    const address = await raceAbort(app.getAuthCodeUrl({
      scopes: SCOPES,
      redirectUri,
      responseMode: "query",
      codeChallenge,
      codeChallengeMethod: "S256",
      state,
      nonce,
      prompt: "select_account",
    }), controller.signal);
    let authorization;
    try { authorization = new URL(address); }
    catch { throw new OAuthCodeError("oauth_invalid_authorization_url"); }
    const allowedScopes = new Set([...SCOPES, "openid", "profile", "offline_access"].map(value => value.toLowerCase()));
    const requestedScopes = (authorization.searchParams.get("scope") || "").split(/\s+/).filter(Boolean).map(value => value.toLowerCase());
    if (authorization.origin !== "https://login.microsoftonline.com" ||
        authorization.username || authorization.password ||
        !/\/oauth2\/v2\.0\/authorize$/.test(authorization.pathname) ||
        requestedScopes.some(scope => !allowedScopes.has(scope)) ||
        SCOPES.some(scope => !requestedScopes.includes(scope.toLowerCase())) ||
        authorization.searchParams.get("client_id") !== CLIENT_ID ||
        authorization.searchParams.get("redirect_uri") !== redirectUri ||
        authorization.searchParams.get("state") !== state ||
        authorization.searchParams.get("nonce") !== nonce ||
        authorization.searchParams.get("code_challenge") !== codeChallenge ||
        authorization.searchParams.get("code_challenge_method") !== "S256" ||
        authorization.searchParams.get("response_type") !== "code") {
      throw new OAuthCodeError("oauth_invalid_authorization_url");
    }
    await raceAbort(Promise.resolve(onAuthorization({
      authorizationUri: authorization.href,
      expiresInSeconds: Math.max(0, Math.ceil((expiresAt - Date.now()) / 1000)),
      redirectUri,
      method: "authorization_code",
    })), controller.signal);
    const code = await raceAbort(callback, controller.signal);
    const result = await raceAbort(app.acquireTokenByCode({
      code,
      codeVerifier,
      redirectUri,
      scopes: SCOPES,
      // MSAL 6 validates the nonce before persisting the response to its cache.
      nonce,
    }), controller.signal);
    if (!equalState(result?.idTokenClaims?.nonce, nonce)) {
      throw new OAuthCodeError("oauth_nonce_mismatch");
    }
    return result;
  } finally {
    closed = true;
    clearTimeout(timer);
    signal?.removeEventListener("abort", cancel);
    server.closeAllConnections();
    await new Promise(resolve => server.close(() => resolve()));
  }
}

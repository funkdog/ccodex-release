import { runtimeImport } from "./dependencies.mjs";
import * as cacheModule from "./cache.mjs";
import { acquireByAuthorizationCode, OAuthCodeError } from "./oauth-code.mjs";
import {
  CLIENT_ID, SCOPES, canonicalTenantId, identityBindingFingerprint,
  paths, readSettings, writeSettings,
} from "./settings.mjs";

const { SecureCachePlugin } = cacheModule;
// Keep startup compatible with installations whose cache module predates typed
// cache errors; newer cache implementations retain their precise diagnostics.
const isCacheAccessError = error => typeof cacheModule.CacheAccessError === "function" &&
  error instanceof cacheModule.CacheAccessError;

export class LoginRequiredError extends Error {
  constructor(code = "login_required") {
    super(code === "account_changed_refresh_mcp"
      ? "The selected Microsoft account or tenant changed. Refresh the MCP server before using the new account; no automatic account substitution occurred."
      : code === "selected_tenant_required"
      ? "Work IQ needs an explicit sign-in to bind the actual Entra tenant, not only the account ID. Run 'ccodex workiq login'; no account or tenant was guessed."
      : code === "stale_cache_lock"
      ? "Work IQ has an abandoned credential-cache lock. Verify its recorded process has exited before removing only this profile's .lock file; do not delete the encrypted cache or sign in again just to clear the lock."
      : "Work IQ needs an explicit sign-in. Run 'ccodex workiq login' when convenient. No browser or Windows account dialog was opened.");
    this.code = code;
  }
}

export function safeAuthError(error) {
  const code = String(error?.errorCode || error?.code || "authentication_failed").replace(/[^a-zA-Z0-9_-]/g, "").slice(0, 100);
  return {
    code,
    message: error instanceof LoginRequiredError || error instanceof OAuthCodeError || isCacheAccessError(error)
      ? error.message
      : "Microsoft sign-in or consent is required, or tenant policy denied access. No automatic broker/browser fallback was attempted.",
  };
}

export function safeWorkIqError(error) {
  if (error instanceof LoginRequiredError || error instanceof OAuthCodeError || isCacheAccessError(error) || error?.errorCode) return safeAuthError(error);
  const status = Number(error?.code || error?.status || error?.statusCode);
  if (status === 401 || error?.name === "UnauthorizedError") {
    return { code: "reauthentication_required", message: "Work IQ rejected the credential. Sign in explicitly; no automatic browser or account fallback was attempted." };
  }
  if (status === 403) {
    return { code: "access_denied", message: "The service denied access. Check tenant policy, consent and licensing; do not try alternative paths or accounts to bypass the denial." };
  }
  if (status === 429) {
    return { code: "rate_limited", message: "Work IQ is throttling requests. Respect the service retry interval; no action was replayed." };
  }
  return {
    code: Number.isInteger(status) && status !== 0 ? `service_error_${status}` : "service_or_transport_error",
    message: "Work IQ did not return a confirmed result. If this was a write, its outcome may be unknown: verify the target before retrying. No request content or credential was logged.",
  };
}

function selectionKey(settings) {
  return JSON.stringify([settings.tenant, settings.selectedAccountId, settings.selectedTenantId]);
}

function resultIdentity(result) {
  // MSAL validates the authentication response. Check its structured identity
  // fields; access tokens may be opaque and must not be decoded by this client.
  try {
    const tenantId = canonicalTenantId(result?.tenantId);
    if (!result?.accessToken || !result?.account?.homeAccountId ||
        canonicalTenantId(result.account.tenantId) !== tenantId ||
        (result.idTokenClaims?.tid && canonicalTenantId(result.idTokenClaims.tid) !== tenantId) ||
        (result.account.idTokenClaims?.tid && canonicalTenantId(result.account.idTokenClaims.tid) !== tenantId)) {
      throw new Error("inconsistent MSAL identity");
    }
    return { accountId: result.account.homeAccountId, tenantId };
  } catch {
    throw new LoginRequiredError("token_identity_mismatch");
  }
}

export async function createIdentity(profile, { applicationFactory, cachePlugin, authorizationCodeFlow = acquireByAuthorizationCode } = {}) {
  const settings = readSettings(profile);
  const cache = cachePlugin || new SecureCachePlugin(paths(profile).cache);
  const configuration = {
    auth: {
      clientId: CLIENT_ID,
      authority: `https://login.microsoftonline.com/${settings.tenant}`,
    },
    cache: { cachePlugin: cache },
    system: {
      loggerOptions: {
        piiLoggingEnabled: false,
        loggerCallback: () => {},
      },
    },
  };
  const app = applicationFactory
    ? applicationFactory(configuration)
    : new (await runtimeImport("@azure/msal-node", profile)).PublicClientApplication(configuration);
  let pinnedBinding = identityBindingFingerprint(settings);

  const assertCurrentSelection = () => {
    const current = readSettings(profile);
    const binding = identityBindingFingerprint(current);
    if (current.tenant !== settings.tenant ||
        (pinnedBinding && binding !== pinnedBinding)) {
      throw new LoginRequiredError("account_changed_refresh_mcp");
    }
    if (!current.selectedAccountId) throw new LoginRequiredError();
    if (!current.selectedTenantId) throw new LoginRequiredError("selected_tenant_required");
    // A server started before the first explicit login may adopt that first
    // selection. Once bound, it never substitutes another account or tenant.
    pinnedBinding ||= binding;
    return current;
  };

  const selectAccount = async () => {
    const current = assertCurrentSelection();
    const accounts = await app.getTokenCache().getAllAccounts();
    assertCurrentSelection();
    // One homeAccountId can have multiple guest/home tenant profiles in MSAL.
    // Cache order is not an account/tenant selection policy.
    const selected = accounts.find(account =>
      account.homeAccountId === current.selectedAccountId &&
      typeof account.tenantId === "string" &&
      account.tenantId.toLowerCase() === current.selectedTenantId);
    if (!selected) throw new LoginRequiredError("selected_account_missing");
    return selected;
  };

  const commitLogin = (result, before, method) => {
    const resolved = resultIdentity(result);
    const current = readSettings(profile);
    if (current.tenant !== settings.tenant) throw new LoginRequiredError("tenant_changed_during_login");
    if (selectionKey(current) !== selectionKey(before)) {
      throw new LoginRequiredError("account_changed_refresh_mcp");
    }
    if (/^[0-9a-f-]{36}$/i.test(current.tenant) && canonicalTenantId(current.tenant) !== resolved.tenantId) {
      throw new LoginRequiredError("token_identity_mismatch");
    }
    const selected = {
      ...current, selectedAccountId: resolved.accountId, selectedTenantId: resolved.tenantId,
      lastAuthenticationMethod: method,
    };
    writeSettings(selected, profile);
    pinnedBinding = identityBindingFingerprint(selected);
    return { authentication: "authenticated", method, tenant: resolved.tenantId };
  };

  return {
    assertCurrentSelection,
    bindingFingerprint() {
      return identityBindingFingerprint(assertCurrentSelection());
    },
    async token({ forceRefresh = false, claims } = {}) {
      try {
        const account = await selectAccount();
        const current = assertCurrentSelection();
        const result = await app.acquireTokenSilent({
          account,
          authority: `https://login.microsoftonline.com/${current.selectedTenantId}`,
          scopes: SCOPES,
          forceRefresh,
          ...(claims ? { claims } : {}),
        });
        assertCurrentSelection();
        const resolved = resultIdentity(result);
        if (resolved.accountId !== current.selectedAccountId || resolved.tenantId !== current.selectedTenantId) {
          throw new LoginRequiredError("token_identity_mismatch");
        }
        return result.accessToken;
      } catch (error) {
        if (error instanceof LoginRequiredError || isCacheAccessError(error)) throw error;
        throw new LoginRequiredError(safeAuthError(error).code);
      }
    },
    async status() {
      try {
        await this.token();
        return { authentication: "authenticated", method: "msal_silent", policyAndLicenseVerified: false };
      } catch (error) {
        return { authentication: isCacheAccessError(error) ? "cache_unavailable" : "login_required", ...safeAuthError(error) };
      }
    },
    async loginWithAuthorizationCode(onAuthorization, { signal } = {}) {
      const before = readSettings(profile);
      if (before.tenant !== settings.tenant) throw new LoginRequiredError("account_changed_refresh_mcp");
      const result = await authorizationCodeFlow(app, { onAuthorization, signal });
      if (signal?.aborted) throw new OAuthCodeError("oauth_login_cancelled");
      return commitLogin(result, before, "authorization_code");
    },
    async login(deviceCodeCallback, { signal } = {}) {
      // Deliberately no acquireTokenInteractive, WAM picker, shell-open, or browser.
      // Device-code entry is performed by the user, never by UI automation.
      const before = readSettings(profile);
      if (before.tenant !== settings.tenant) throw new LoginRequiredError("account_changed_refresh_mcp");
      const request = {
        scopes: SCOPES,
        deviceCodeCallback,
        timeout: 900,
        cancel: Boolean(signal?.aborted),
      };
      const cancel = () => { request.cancel = true; };
      signal?.addEventListener("abort", cancel, { once: true });
      try {
        if (request.cancel) throw new LoginRequiredError("login_cancelled");
        const result = await app.acquireTokenByDeviceCode(request);
        if (request.cancel) throw new LoginRequiredError("login_cancelled");
        return commitLogin(result, before, "device_code");
      } finally {
        signal?.removeEventListener("abort", cancel);
      }
    },
    async logout() {
      const before = readSettings(profile);
      const account = await selectAccount().catch(error => {
        if (error instanceof LoginRequiredError && error.code !== "account_changed_refresh_mcp") return null;
        throw error;
      });
      if (account) await app.getTokenCache().removeAccount(account);
      const current = readSettings(profile);
      if (selectionKey(current) !== selectionKey(before)) throw new LoginRequiredError("account_changed_refresh_mcp");
      writeSettings({ ...current, selectedAccountId: null, selectedTenantId: null, enabled: false }, profile);
      pinnedBinding = null;
      return { authentication: "signed_out", enabled: false };
    },
  };
}

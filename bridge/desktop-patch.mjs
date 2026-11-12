/**
 * Unlocks the full GitHub Copilot model list in the Codex desktop model picker.
 *
 * The desktop app decides which models it will offer from a remote configuration
 * (`use_hidden_models` plus an `available_models` allowlist of eight OpenAI slugs).
 * When that flag is off - which is also the app's own built-in default - it falls back
 * to showing every model the local Codex app-server reports that is not marked hidden,
 * which is exactly the Copilot catalog the bridge generates.
 *
 * So this attaches to the window the launcher started, flips that single field back to
 * its default, and lets the app's normal code path list all the models. Nothing is
 * written to the app, its package, or its data; the change lives only in the memory of
 * the process we launched and disappears when it exits. The stock Codex desktop app,
 * started any other way, is untouched.
 */
import fs from "node:fs";
import path from "node:path";
import { pathToFileURL } from "node:url";
import { FileValidationCache, withFileValidation } from "./file-validation-cache.mjs";
import { CODEX_COPILOT_HOME } from "./auth.mjs";
import { readAccountGeneration } from "./account-store.mjs";
import { quotaSnapshotFreshness, quotaSnapshotText } from "./copilot-account.mjs";
import { openSystemBrowser } from "./desktop-actions.mjs";
import { selectedBridgePort } from "./port-selection.mjs";
import { CdpTargetSessions, connectCdp, evaluate, reloadPage } from "./desktop-cdp.mjs";
import {
  buildDesktopModelControlsPatch,
  desktopModelGroups,
} from "./desktop-model-controls.mjs";
import { createDesktopWorkIqHandler } from "./workiq/desktop.mjs";
import { assertPrivateDesktopHome } from "./desktop-runtime.mjs";
import { bindDesktopInstance, readDesktopInstance } from "./desktop-instance.mjs";
import { createDesktopUpdateService } from "./desktop-update-service.mjs";
import { buildDesktopUpdateUiPatch } from "./desktop-update-ui.mjs";
import { buildDesktopReleaseNoticePatch } from "./release-update.mjs";
import { createDesktopOwnershipGuard, inspectWindowsDesktopOwnership } from "./desktop-ownership.mjs";
import { readProcessIdentity } from "./desktop-process.mjs";
import { buildDesktopSessionsPatch } from "./desktop-sessions.mjs";
import { createDesktopSessionApi } from "./desktop-session-reader.mjs";
import { createDesktopIconController } from "../tools/desktop-icons.mjs";
import { buildDesktopDisplayConfigPatch } from "./desktop-display-config.mjs";

const LOG_FILE = path.join(CODEX_COPILOT_HOME, "desktop-patch.log");
const BRIDGE_PORT = selectedBridgePort({ home: CODEX_COPILOT_HOME });
const BRIDGE_ENDPOINT = `http://127.0.0.1:${BRIDGE_PORT}`;
const handleWorkIqDesktop = createDesktopWorkIqHandler(CODEX_COPILOT_HOME);
const requestSessions = createDesktopSessionApi({ home: CODEX_COPILOT_HOME, port: BRIDGE_PORT });

const POLL_MS = 2000;
const MISS_LIMIT = 8; // ~16s with no debug endpoint means the window is gone.
const CATALOG_GENERATION_FILE = path.join(
  CODEX_COPILOT_HOME,
  "catalog-generation.json",
);
const SELECTION_GENERATION_FILE = path.join(
  CODEX_COPILOT_HOME,
  "desktop-selection-generation.json",
);

function formatContextTokens(tokens) {
  if (tokens >= 1_000_000) {
    const millions = tokens / 1_000_000;
    return `${Number.isInteger(millions) ? millions.toFixed(0) : millions.toFixed(1)}M`;
  }
  return `${Math.round(tokens / 1000).toLocaleString()}K`;
}

function loadContextLabels() {
  try {
    const catalog = JSON.parse(
      fs.readFileSync(path.join(CODEX_COPILOT_HOME, "models.json"), "utf8"),
    );
    const labels = {};
    for (const model of catalog.models || []) {
      const defaultTokens = model.copilot?.default_context_window_tokens;
      const longTokens = model.copilot?.long_context_window_tokens;
      if (!defaultTokens || !longTokens) continue;
      const value = {
        default: formatContextTokens(defaultTokens),
        long: formatContextTokens(longTokens),
      };
      for (const key of [model.slug, model.display_name]) {
        const normalized = String(key || "")
          .replace(/\u200B/g, "")
          .trim()
          .toLowerCase()
          .replace(/[^\p{L}\p{N}]+/gu, "");
        if (normalized) labels[normalized] = value;
      }
    }
    return labels;
  } catch {
    return {};
  }
}

function loadDesktopModelGroups() {
  try {
    const catalog = JSON.parse(
      fs.readFileSync(path.join(CODEX_COPILOT_HOME, "models-desktop.json"), "utf8"),
    );
    return desktopModelGroups(catalog);
  } catch {
    return [];
  }
}

function readCatalogGeneration() {
  try {
    return JSON.parse(fs.readFileSync(CATALOG_GENERATION_FILE, "utf8")).generation || null;
  } catch {
    return null;
  }
}

function readSelectionGeneration() {
  try {
    return JSON.parse(fs.readFileSync(SELECTION_GENERATION_FILE, "utf8")).generation || null;
  } catch {
    return null;
  }
}

function log(message) {
  const line = `${new Date().toISOString()} ${message}\n`;
  try {
    assertPrivateDesktopHome(CODEX_COPILOT_HOME);
    fs.mkdirSync(CODEX_COPILOT_HOME, { recursive: true });
    fs.appendFileSync(LOG_FILE, line, "utf8");
  } catch {
    /* diagnostics must never break the launcher */
  }
  if (process.env.CODEX_COPILOT_PATCH_VERBOSE === "1") process.stderr.write(line);
}

/** Runs inside the app window. Idempotent: safe to evaluate on every poll. */
const PATCH_SOURCE = buildDesktopDisplayConfigPatch();

function cdpUrl(port, route) {
  return `http://127.0.0.1:${port}${route}`;
}

async function listTargets(port) {
  const res = await fetch(cdpUrl(port, "/json/list"), {
    signal: AbortSignal.timeout(4000), redirect: "error",
  });
  if (!res.ok) throw new Error(`HTTP ${res.status}`);
  const all = await res.json();
  const targets = all.filter(
    (target) =>
      target.type === "page" &&
      target.webSocketDebuggerUrl &&
      String(target.url || "").startsWith("app://-/"),
  );
  for (const target of targets) {
    const endpoint = new URL(target.webSocketDebuggerUrl);
    if (endpoint.protocol !== "ws:" || !["127.0.0.1", "localhost"].includes(endpoint.hostname) ||
        Number(endpoint.port) !== port || endpoint.username || endpoint.password) {
      throw new Error("Renderer endpoint escaped the private Desktop listener.");
    }
  }
  return targets;
}

// Account management is attached to Codex's existing profile button and rendered
// inside the app's own document with its theme variables. It is never a separate
// top-level or always-on-top window.
export function buildAccountUiPatch() {
  return `(() => {
    if (globalThis.__codexCopilotAccountUiV5) return 'active';
    if (globalThis.__codexCopilotAccountUiV3 && !globalThis.__codexCopilotAccountUiV4) return 'reload-required';
    const rootId = 'codex-copilot-account-root';
    const styleId = 'codex-copilot-account-style';
    const legacy = document.getElementById(rootId);
    if (legacy) {
      legacy.querySelector('.cc-account-close')?.click();
      legacy.remove();
      document.getElementById(styleId)?.remove();
    }
    globalThis.__codexCopilotAccountUiV5 = true;
    let switchId = null;
    let pollTimer = null;
    let accountTimer = null;
    let accountView = 0;
    const pendingRequests = new Map();
    const quotaText = ${quotaSnapshotText.toString()};
    const quotaFreshness = ${quotaSnapshotFreshness.toString()};

    const create = (tag, className, text) => {
      const element = document.createElement(tag);
      if (className) element.className = className;
      if (text !== undefined) element.textContent = text;
      return element;
    };
    const onAccountResponse = (event) => {
      const response = event.detail || {};
      const pending = pendingRequests.get(response.id);
      if (!pending) return;
      pendingRequests.delete(response.id);
      clearTimeout(pending.timer);
      if (response.ok) pending.resolve(response.body || {});
      else pending.reject(new Error(response.body?.error || 'Request failed'));
    };
    globalThis.addEventListener('codex-copilot-account-response', onAccountResponse);
    const bridgeRequest = (payload) => new Promise((resolve, reject) => {
      if (typeof globalThis.__codexCopilotAccountRequest !== 'function') {
        reject(new Error('Desktop account bridge is unavailable'));
        return;
      }
      const id = crypto.randomUUID();
      const timer = setTimeout(() => {
        if (!pendingRequests.has(id)) return;
        pendingRequests.delete(id);
        reject(new Error('Account request timed out'));
      }, 30000);
      pendingRequests.set(id, { resolve, reject, timer });
      try {
        globalThis.__codexCopilotAccountRequest(JSON.stringify({ id, ...payload }));
      } catch (error) {
        clearTimeout(timer);
        pendingRequests.delete(id);
        reject(error);
      }
    });
    const request = (path, options = {}) => bridgeRequest({
      action: 'account-request',
      path,
      method: options.method || 'GET',
    });
    const openExternal = (url) => bridgeRequest({
      action: 'open-external',
      url,
    });
    const profileButton = () => Array.from(document.querySelectorAll('button')).find((button) => {
      const label = button.getAttribute('aria-label') || '';
      return /(?:profile menu|个人资料菜单)/i.test(label) ||
        button.textContent?.trim() === 'GitHub Copilot';
    });
    const clearPoll = () => {
      if (pollTimer !== null) clearInterval(pollTimer);
      pollTimer = null;
    };

    if (!document.getElementById(styleId)) {
      const style = document.createElement('style');
      style.id = styleId;
      style.textContent = \`
        #\${rootId} { position: fixed; inset: 0; z-index: 2147483646; display: none; }
        #\${rootId}[data-open="true"] { display: block; }
        #\${rootId} .cc-account-backdrop {
          position: absolute; inset: 0; background: rgba(0,0,0,.48); backdrop-filter: blur(2px);
        }
        #\${rootId} .cc-account-panel {
          position: absolute; left: 18px; bottom: 54px; width: 340px; max-width: calc(100vw - 36px);
          max-height: calc(100vh - 90px); overflow-y: auto;
          padding: 18px; border-radius: 14px; background: var(--main-surface-primary, #242424);
          color: var(--text-primary, #f2f2f2); box-shadow: 0 18px 55px rgba(0,0,0,.38);
          border: 1px solid rgba(255,255,255,.12); font: 14px/1.45 system-ui, sans-serif;
        }
        #\${rootId} .cc-account-header { display: flex; align-items: center; gap: 10px; margin-bottom: 14px; }
        #\${rootId} .cc-account-title { flex: 1; font-size: 16px; font-weight: 650; }
        #\${rootId} .cc-account-close {
          border: 0; background: transparent; color: inherit; cursor: pointer; font-size: 20px;
        }
        #\${rootId} .cc-account-row { display: flex; gap: 12px; margin: 7px 0; }
        #\${rootId} .cc-account-label { width: 82px; color: var(--text-tertiary, #aaa); }
        #\${rootId} .cc-account-value { flex: 1; overflow-wrap: anywhere; }
        #\${rootId} .cc-account-identity { display: flex; align-items: center; gap: 12px; margin: 6px 0 16px; }
        #\${rootId} .cc-account-avatar { width: 44px; height: 44px; flex-shrink: 0; border-radius: 50%; object-fit: cover; }
        #\${rootId} .cc-account-name { font-weight: 650; }
        #\${rootId} .cc-account-handle { color: var(--text-tertiary, #aaa); }
        #\${rootId} .cc-account-quota { margin: 14px 0; }
        #\${rootId} .cc-account-quota-label { margin-bottom: 5px; font-weight: 550; }
        #\${rootId} progress { display: block; width: 100%; height: 7px; margin-top: 7px; accent-color: var(--accent-blue, #4b80e9); }
        #\${rootId} .cc-account-code {
          margin: 14px 0 8px; padding: 12px; border-radius: 10px; text-align: center;
          font: 700 24px/1.2 ui-monospace, Consolas, monospace; letter-spacing: .12em;
          background: rgba(255,255,255,.08); user-select: all;
        }
        #\${rootId} .cc-account-note { color: var(--text-tertiary, #aaa); margin: 8px 0 14px; }
        #\${rootId} .cc-account-error { color: #ff8f8f; margin: 10px 0; }
        #\${rootId} .cc-account-actions { display: flex; flex-wrap: wrap; gap: 8px; margin-top: 16px; }
        #\${rootId} .cc-account-button {
          border: 1px solid rgba(255,255,255,.14); border-radius: 9px; padding: 8px 11px;
          background: rgba(255,255,255,.08); color: inherit; cursor: pointer; text-decoration: none;
        }
        #\${rootId} .cc-account-button:hover { background: rgba(255,255,255,.14); }
        #\${rootId} .cc-account-primary { background: #fff; color: #111; }
        [data-codex-copilot-account-button="true"] { position: relative; }
      \`;
      document.head.appendChild(style);
    }

    const root = create('div');
    root.id = rootId;
    root.dataset.open = 'false';
    const backdrop = create('div', 'cc-account-backdrop');
    const panel = create('div', 'cc-account-panel');
    panel.setAttribute('role', 'dialog');
    panel.setAttribute('aria-modal', 'true');
    panel.setAttribute('aria-label', 'GitHub Copilot Account');
    const header = create('div', 'cc-account-header');
    const title = create('div', 'cc-account-title', 'GitHub Copilot Account');
    const closeButton = create('button', 'cc-account-close', '×');
    const content = create('div');
    const actions = create('div', 'cc-account-actions');
    header.append(title, closeButton);
    panel.append(header, content, actions);
    root.append(backdrop, panel);
    document.body.appendChild(root);

    const close = () => {
      clearPoll();
      if (accountTimer !== null) clearInterval(accountTimer);
      accountTimer = null;
      accountView += 1;
      root.dataset.open = 'false';
    };
    closeButton.addEventListener('click', close);
    backdrop.addEventListener('click', close);

    const addRow = (label, value) => {
      const row = create('div', 'cc-account-row');
      row.append(
        create('div', 'cc-account-label', label),
        create('div', 'cc-account-value', value || '—'),
      );
      content.appendChild(row);
    };
    const actionButton = (label, handler, primary = false) => {
      const button = create(
        'button',
        'cc-account-button' + (primary ? ' cc-account-primary' : ''),
        label,
      );
      button.addEventListener('click', () => {
        if (accountTimer !== null) clearInterval(accountTimer);
        accountTimer = null;
        accountView += 1;
        handler();
      });
      actions.appendChild(button);
      return button;
    };
    const refreshSharedAccount = (generation) => {
      const storageKey = 'codex-copilot-account-generation';
      if (generation) sessionStorage.setItem(storageKey, generation);
      if (globalThis.__codexCopilotAccountRefreshPending) {
        return 'restarting';
      }
      globalThis.__codexCopilotAccountRefreshPending = true;
      close();

      let finished = false;
      const finish = () => {
        if (finished) return;
        finished = true;
        globalThis.__codexCopilotAccountRefreshPending = false;
        globalThis.removeEventListener('message', onHostMessage);
      };
      const onHostMessage = (event) => {
        const message = event.data;
        if (
          message?.type === 'codex-app-server-initialized' &&
          (!message.hostId || message.hostId === 'local')
        ) {
          finish();
        }
      };
      globalThis.addEventListener('message', onHostMessage);
      setTimeout(finish, 6000);

      const send = globalThis.electronBridge?.sendMessageFromView;
      if (typeof send !== 'function') {
        finish();
        location.reload();
        return 'reloading';
      }
      Promise.resolve(send({
        type: 'codex-app-server-restart',
        hostId: 'local',
        intent: 'restart',
        errorMessage: null,
      })).catch(finish);
      return 'restarting';
    };
    globalThis.__codexCopilotRefreshSharedAccount = refreshSharedAccount;
    const desktopSettings = () => {
      close();
      const destination = '/settings/general-settings';
      dispatchEvent(new MessageEvent('message', {
        data: {
          type: 'navigate-to-route',
          path: destination,
          replace: true,
        },
        origin: location.origin,
        source: window,
      }));
    };

    const workIqRequest = (operation, extra = {}) => bridgeRequest({
      action: 'workiq-request', operation, ...extra,
    });
    const showWorkIqAction = async (actionId) => {
      clearPoll();
      actions.replaceChildren();
      content.replaceChildren(create('div', 'cc-account-note', 'Loading encrypted action for review…'));
      try {
        const action = await workIqRequest('action-show', { actionId });
        content.replaceChildren();
        addRow('Action', action.tool);
        addRow('State', action.status);
        addRow('Expires', action.expiresAt);
        const preview = create('pre', 'cc-account-code',
          JSON.stringify(action.result || action.arguments, null, 2));
        preview.style.cssText = 'max-height:45vh;overflow:auto;white-space:pre-wrap;font-size:12px;text-align:left;';
        content.appendChild(preview);
        if (action.status === 'pending') {
          content.appendChild(create('div', 'cc-account-note',
            'Review the exact target, recipients and content. Confirm executes this action once. Timeout/disconnect outcomes are not retried automatically.'));
          actionButton('Confirm and execute', async () => {
            actions.replaceChildren();
            content.appendChild(create('div', 'cc-account-note',
              'Executing once. If this view times out, check status; do not repeat the action.'));
            try {
              await workIqRequest('action-approve', { actionId, requestHash: action.requestHash, confirmed: true });
              await showWorkIqAction(actionId);
            } catch (error) {
              content.appendChild(create('div', 'cc-account-error', error.message));
              actionButton('Check status', () => showWorkIqAction(actionId));
            }
          }, true);
          actionButton('Reject', async () => {
            await workIqRequest('action-reject', { actionId });
            await showWorkIqActions();
          });
        }
        if (action.error) content.appendChild(create('div', 'cc-account-error', action.error.message));
        actionButton('Back', showWorkIqActions);
      } catch (error) {
        content.replaceChildren(create('div', 'cc-account-error', error.message));
        actionButton('Back', showWorkIqActions);
      }
    };
    const showWorkIqActions = async () => {
      clearPoll();
      content.replaceChildren(create('div', 'cc-account-note', 'Queued Work IQ actions; nothing executes by opening this list.'));
      actions.replaceChildren();
      try {
        const result = await workIqRequest('actions-list');
        if (!result.actions.length) content.appendChild(create('div', 'cc-account-note', 'No queued actions.'));
        for (const action of result.actions.slice(0, 25)) {
          actionButton(action.tool + ' · ' + action.status + ' · ' + action.id.slice(0, 8),
            () => showWorkIqAction(action.id));
        }
      } catch (error) {
        content.appendChild(create('div', 'cc-account-error', error.message));
      }
      actionButton('Back', showWorkIq);
    };
    const showWorkIqLogin = async (login) => {
      clearPoll();
      content.replaceChildren();
      actions.replaceChildren();
      addRow('Microsoft 365', 'Work IQ sign-in');
      if (login.status === 'complete') {
        content.appendChild(create('div', 'cc-account-note',
          'Signed in. Enable Work IQ separately after reviewing the enterprise data-processing notice.'));
        actionButton('Work IQ status', showWorkIq, true);
        return;
      }
      if (login.status === 'error' || login.status === 'cancelled') {
        content.appendChild(create('div', 'cc-account-error', login.error || 'Sign-in cancelled.'));
        actionButton('Back', showWorkIq);
        return;
      }
      content.appendChild(create('div', 'cc-account-note',
        'Open the Microsoft sign-in address yourself when convenient. This app does not open or activate a browser.'));
      if (login.method === 'authorization-code') {
        addRow('Method', 'Authorization code + PKCE');
        if (login.authorizationUri) {
          const address = create('div', 'cc-account-code', login.authorizationUri);
          address.style.cssText = 'max-height:25vh;overflow:auto;overflow-wrap:anywhere;white-space:normal;font-size:12px;text-align:left;user-select:text;';
          content.appendChild(address);
          actionButton('Copy Microsoft sign-in address', async () => {
            try { await navigator.clipboard.writeText(login.authorizationUri); }
            catch (error) { content.appendChild(create('div', 'cc-account-error', error.message)); }
          });
        } else {
          addRow('Address', 'Preparing Microsoft sign-in…');
        }
      } else {
        addRow('Address', login.verificationUri || 'Requesting device code…');
        if (login.userCode) content.appendChild(create('div', 'cc-account-code', login.userCode));
      }
      content.appendChild(create('div', 'cc-account-note',
        'Closing this panel does not cancel sign-in. Use Cancel to stop polling.'));
      actionButton('Cancel', async () => {
        await workIqRequest('login-cancel', { sessionId: login.id });
        await showWorkIq();
      });
      pollTimer = setTimeout(async () => {
        try { await showWorkIqLogin(await workIqRequest('login-status', { sessionId: login.id })); }
        catch (error) {
          clearPoll();
          content.replaceChildren(create('div', 'cc-account-error', error.message));
          actions.replaceChildren();
          actionButton('Back', showWorkIq);
        }
      }, 1500);
    };
    const showWorkIq = async () => {
      clearPoll();
      content.replaceChildren(create('div', 'cc-account-note', 'Loading Work IQ status…'));
      actions.replaceChildren();
      try {
        const workiq = await workIqRequest('status');
        content.replaceChildren();
        addRow('Work IQ', workiq.enabled ? 'Enabled' : 'Disabled');
        addRow('Runtime', workiq.runtimeInstalled ? 'Installed' : 'Not installed');
        addRow('Sign-in', workiq.credentialCachePresent && workiq.identityBindingPresent ? 'Cache present; access not verified' : 'Sign-in required');
        addRow('Selected Entra tenant', workiq.selectedTenantId || 'Not yet bound by sign-in');
        addRow('Last sign-in method', workiq.lastAuthenticationMethod || 'Not yet verified');
        addRow('Live tools', workiq.lastToolDiscovery ? String(workiq.lastDiscoveredTools.length) + ' last observed' : 'Not yet verified');
        content.appendChild(create('div', 'cc-account-note',
          'Microsoft 365 data returned by tools enters this conversation and may be processed by the selected model provider. Existing M365 protections do not automatically cover that downstream processing. Enable only if your organization permits it.'));
        if (!workiq.runtimeInstalled) {
          content.appendChild(create('div', 'cc-account-code', 'ccodex workiq install'));
        } else {
          actionButton('Sign in (authorization code)', async () => {
            try { await showWorkIqLogin(await workIqRequest('login-start', { method: 'authorization-code' })); }
            catch (error) { content.appendChild(create('div', 'cc-account-error', error.message)); }
          }, true);
          actionButton('Sign in (device code)', async () => {
            try { await showWorkIqLogin(await workIqRequest('login-start', { method: 'device-code' })); }
            catch (error) { content.appendChild(create('div', 'cc-account-error', error.message)); }
          });
        }
        if (workiq.enabled) {
          actionButton('Disable Work IQ', async () => { await workIqRequest('disable'); await showWorkIq(); });
        } else {
          actionButton('I understand; enable Work IQ', async () => {
            try { await workIqRequest('enable', { acknowledge: true }); await showWorkIq(); }
            catch (error) { content.appendChild(create('div', 'cc-account-error', error.message)); }
          }, true);
        }
        content.appendChild(create('div', 'cc-account-note',
          'CLI and Desktop share this connection. Refresh MCP servers or start a new thread after enabling.'));
        actionButton('Desktop settings', desktopSettings);
        actionButton('Review queued actions', showWorkIqActions);
        actionButton('Back', showAccount);
      } catch (error) {
        content.replaceChildren(create('div', 'cc-account-error', error.message));
        actionButton('Back', showAccount);
      }
    };

    const showAccount = async (force = false, quiet = false) => {
      const view = ++accountView;
      if (!quiet) {
        content.replaceChildren(create('div', 'cc-account-note', 'Loading account…'));
        actions.replaceChildren();
      }
      try {
        const account = await request(force ? '/account/refresh' : '/account',
          force ? { method: 'POST' } : {});
        if (view !== accountView || root.dataset.open !== 'true') return;
        content.replaceChildren();
        actions.replaceChildren();
        const identity = create('div', 'cc-account-identity');
        const profile = account.profile || {};
        try {
          const url = new URL(profile.avatarUrl);
          if (url.protocol === 'https:' && url.hostname === 'avatars.githubusercontent.com'
              && !url.username && !url.password && (!url.port || url.port === '443')) {
            const avatar = create('img', 'cc-account-avatar');
            avatar.src = url.href;
            avatar.alt = (profile.name || account.login || 'GitHub') + ' avatar';
            avatar.referrerPolicy = 'no-referrer';
            avatar.addEventListener('error', () => avatar.remove());
            identity.appendChild(avatar);
          }
        } catch { /* No image is preferable to an untrusted or invented avatar. */ }
        const identityText = create('div');
        identityText.append(
          create('div', 'cc-account-name', profile.name || account.login || 'Not signed in'),
          create('div', 'cc-account-handle', account.login ? '@' + account.login : 'GitHub Copilot'),
        );
        identity.appendChild(identityText);
        content.appendChild(identity);
        addRow('Plan', account.plan || 'Not reported');
        addRow('Credential', account.source || '—');
        addRow('Models', String(account.models || 0));
        const quota = account.quota;
        if (account.credits?.schemaVersion === 1) {
          addRow('AI credits', account.credits.statusText);
          addRow('Credit data', account.credits.detailText);
        }
        if (quota?.snapshots?.length) {
          for (const snapshot of quota.snapshots) {
            if (snapshot.unit === 'credits') continue;
            const freshness = quotaFreshness(snapshot);
            const row = create('div', 'cc-account-quota');
            row.append(
              create('div', 'cc-account-quota-label', snapshot.label || snapshot.id),
              create('div', 'cc-account-value', freshness === 'unavailable'
                ? 'Quota unavailable (expired or not timestamped)' : quotaText(snapshot)),
            );
            if (freshness !== 'unavailable' && !snapshot.unlimited
                && typeof snapshot.percentRemaining === 'number') {
              const used = Math.max(0, Math.min(100, 100 - snapshot.percentRemaining));
              const progress = create('progress');
              progress.max = 100;
              progress.value = used;
              progress.setAttribute('aria-label', (snapshot.label || snapshot.id) + ': ' + used.toFixed(1) + '% used');
              row.appendChild(progress);
            }
            if (freshness !== 'unavailable' && snapshot.overageCount > 0) row.appendChild(create('div', 'cc-account-note',
              'Additional usage: ' + snapshot.overageCount));
            if (freshness === 'stale') {
              row.appendChild(create('div', 'cc-account-note',
                'Last known, not live: ' + new Date(snapshot.updatedAt).toLocaleString()));
            }
            content.appendChild(row);
          }
          if (quota.resetAt) addRow('Resets', new Date(quota.resetAt).toLocaleString());
          if (quota.updatedAt) addRow('Checked', new Date(quota.updatedAt).toLocaleString());
          if (quota.status === 'stale') content.appendChild(create('div', 'cc-account-note',
            'Last known quota. Refresh is temporarily unavailable; these values are not live.'));
        } else content.appendChild(create('div', 'cc-account-note',
          'Quota unavailable' + (quota?.reason ? ': ' + quota.reason : '. Not yet reported by GitHub.')));
        const button = profileButton();
        if (button) {
          button.title = account.login
            ? 'GitHub Copilot account: ' + account.login
            : 'GitHub Copilot account';
        }
        actionButton('Refresh quota', () => showAccount(true), false);
        actionButton('Switch GitHub account', startSwitch, true);
        actionButton('Microsoft 365 / Work IQ', showWorkIq);
        if (globalThis.__codexCopilotDesktopUpdatesV1) actionButton('Desktop updates',
          () => globalThis.__codexCopilotDesktopUpdatesV1.open());
        actionButton('Desktop settings', desktopSettings);
        actionButton('Close', close);
        if (accountTimer === null) accountTimer = setInterval(() => showAccount(false, true), 60000);
      } catch (error) {
        if (view !== accountView || root.dataset.open !== 'true') return;
        content.replaceChildren(create('div', 'cc-account-error', error.message));
        actionButton('Retry', showAccount, true);
        actionButton('Close', close);
      }
    };

    const finishSwitch = (state) => {
      clearPoll();
      content.replaceChildren();
      addRow('GitHub', state.login || 'Signed in');
      addRow('Models', String(state.models || 0));
      addRow('Selected', state.selectedModel || '—');
      content.appendChild(
        create('div', 'cc-account-note', 'Account switched. Refreshing Codex…'),
      );
      actions.replaceChildren();
      setTimeout(
        () => refreshSharedAccount(state.accountGeneration),
        100,
      );
    };
    const renderSwitch = (state) => {
      if (state.status === 'complete') {
        finishSwitch(state);
        return;
      }
      if (state.status === 'error' || state.status === 'cancelled') {
        clearPoll();
        content.replaceChildren(
          create(
            'div',
            state.status === 'error' ? 'cc-account-error' : 'cc-account-note',
            state.error || (state.status === 'cancelled' ? 'Account switch cancelled.' : 'Account switch failed.'),
          ),
        );
        actions.replaceChildren();
        actionButton('Try again', startSwitch, true);
        actionButton('Close', close);
        return;
      }
      if (!state.userCode) return;
      content.replaceChildren(
        create('div', 'cc-account-note', 'Open GitHub and enter this device code:'),
        create('div', 'cc-account-code', state.userCode),
      );
      actions.replaceChildren();
      actionButton('Open GitHub', async () => {
        try {
          await openExternal(state.verificationUriComplete || state.verificationUri);
        } catch (error) {
          content.appendChild(create('div', 'cc-account-error', error.message));
        }
      }, true);
      actionButton('Copy code', () => navigator.clipboard?.writeText(state.userCode));
      actionButton('Cancel', async () => {
        if (!switchId) return;
        const cancelled = await request('/account/switch/' + switchId + '/cancel', {
          method: 'POST',
        });
        renderSwitch(cancelled);
      });
    };
    const pollSwitch = async () => {
      if (!switchId) return;
      try {
        renderSwitch(await request('/account/switch/' + switchId));
      } catch (error) {
        clearPoll();
        content.replaceChildren(create('div', 'cc-account-error', error.message));
      }
    };
    async function startSwitch() {
      clearPoll();
      content.replaceChildren(
        create('div', 'cc-account-note', 'Requesting a GitHub device code…'),
      );
      actions.replaceChildren();
      try {
        const state = await request('/account/switch', { method: 'POST' });
        switchId = state.id;
        renderSwitch(state);
        if (state.status === 'starting' || state.status === 'pending') {
          pollTimer = setInterval(pollSwitch, 2000);
        }
      } catch (error) {
        content.replaceChildren(create('div', 'cc-account-error', error.message));
        actionButton('Try again', startSwitch, true);
        actionButton('Close', close);
      }
    }

    const open = () => {
      if (root.dataset.open === 'true') return;
      root.dataset.open = 'true';
      showAccount();
    };
    const onProfileEvent = (event) => {
      if (event.type === 'keydown' && root.dataset.open === 'true' && event.key === 'Escape') {
        event.preventDefault(); event.stopImmediatePropagation(); close(); return;
      }
      const button = event.target?.closest?.('button');
      if (!button || button !== profileButton()) return;
      if (event.type === 'pointerdown' && event.button !== 0) return;
      if (event.type === 'keydown' && !['Enter', ' ', 'ArrowDown'].includes(event.key)) return;
      event.preventDefault();
      event.stopImmediatePropagation();
      open();
    };
    for (const type of ['pointerdown', 'click', 'keydown']) {
      document.addEventListener(type, onProfileEvent, true);
    }
    const refreshQuietly = () => {
      if (root.dataset.open === 'true') {
        showAccount(false, true);
        return;
      }
      request('/account').then((account) => {
        const button = profileButton();
        if (button && account?.login) {
          button.title = 'GitHub Copilot account: ' + account.login + ' (' + (account.models || 0) + ' models)';
        }
      }).catch(() => {});
    };
    globalThis.__codexCopilotAccountUiV5 = {
      open, close, refreshQuietly, revision: 5, requestTimeoutMs: 30000,
      dispose: () => {
        close();
        for (const type of ['pointerdown', 'click', 'keydown']) {
          document.removeEventListener(type, onProfileEvent, true);
        }
        globalThis.removeEventListener('codex-copilot-account-response', onAccountResponse);
        for (const operation of pendingRequests.values()) {
          clearTimeout(operation.timer);
          operation.reject(new Error('Account UI disposed'));
        }
        pendingRequests.clear();
        root.remove();
        document.getElementById(styleId)?.remove();
        delete globalThis.__codexCopilotAccountUiV5;
      },
    };
    return 'active';
  })()`;
}

function buildContextLabelPatch() {
  return `(() => {
  if (globalThis.__codexCopilotContextLabels) return;
  globalThis.__codexCopilotContextLabels = true;
  const labelsByModel = ${JSON.stringify(loadContextLabels())};
  const normalize = (value) => String(value || '')
    .replace(/\\u200B/g, '')
    .trim()
    .toLowerCase()
    .replace(/[^\\p{L}\\p{N}]+/gu, '');
  const leaves = (root) => Array.from(root.querySelectorAll('span, div, p')).filter(
    (element) => element.children.length === 0 && element.textContent?.trim()
  );
  const contextItem = (menu) => Array.from(menu.querySelectorAll('[role="menuitem"]')).find(
    (item) => leaves(item).some(
    (element) => /^(?:Context|Speed|速度)$/i.test(element.textContent.trim())
    )
  );
  const labelEntries = Object.entries(labelsByModel).sort(
    ([left], [right]) => right.length - left.length
  );
  const labelsForMenu = (menu) => {
    const text = normalize(menu.textContent);
    for (const [key, labels] of labelEntries) {
    if (text.includes(key)) return labels;
    }
    return undefined;
  };
  const markReplacement = (element, label) => {
    if (!element) return;
    element.setAttribute('data-codex-copilot-context-replace', '');
    element.setAttribute('data-codex-copilot-context-label', label);
  };
  const markOption = (item, label) => {
    const row = item.firstElementChild;
    if (!row) return;
    row.setAttribute('data-codex-copilot-context-option-row', '');
    row.setAttribute('data-codex-copilot-context-label', label);
    item.setAttribute('aria-label', label);
  };
  const labelsFromOptions = (items) => {
    if (items.length < 2) return undefined;
    const tokenLabel = /^\\d+(?:\\.\\d+)?[KM]$/i;
    const longLeaves = leaves(items[1]).map((element) => element.textContent.trim());
    const long = longLeaves.find(tokenLabel.test.bind(tokenLabel));
    const defaultLabel = longLeaves.findLast(
    (label) => tokenLabel.test(label) && label !== long
    );
    return long && defaultLabel ? { default: defaultLabel, long } : undefined;
  };

  const style = document.createElement('style');
  style.id = 'codex-copilot-context-label-style';
  style.textContent = \`
    [data-codex-copilot-context-replace] {
    font-size: 0 !important;
    }
    [data-codex-copilot-context-replace]::after {
    content: attr(data-codex-copilot-context-label);
    font-size: 0.875rem;
    line-height: 1.25rem;
    }
    [data-codex-copilot-context-option-row] > :first-child {
    display: none !important;
    }
    [data-codex-copilot-context-option-row]::before {
    content: attr(data-codex-copilot-context-label);
    flex: 1 1 auto;
    min-width: 0;
    font-size: 0.875rem;
    line-height: 1.25rem;
    }
  \`;
  document.head.appendChild(style);

  let activeLabels;
  const fix = () => {
    const menus = Array.from(document.querySelectorAll('[role="menu"]'));
    for (const menu of menus) {
    const item = contextItem(menu);
    if (!item) continue;
    const labels = labelsForMenu(menu);
    if (!labels) continue;
    activeLabels = labels;
    const itemLeaves = leaves(item);
    const title = itemLeaves.find(
      (element) => /^(?:Context|Speed|速度)$/i.test(element.textContent.trim())
    );
    const value = itemLeaves.findLast((element) => element !== title);
    markReplacement(title, 'Context');
    if (value) {
      const rawValue = value.textContent.trim();
      const selected = rawValue === labels.long || /Long context/i.test(rawValue)
        ? labels.long
        : labels.default;
      markReplacement(value, selected);
      item.setAttribute('aria-label', 'Context ' + selected);
    }
    }
    for (const menu of menus) {
    if (contextItem(menu)) continue;
    const heading = leaves(menu).find((element) =>
      /^(?:Context|Speed|速度)$/i.test(element.textContent.trim())
    );
    const items = Array.from(menu.querySelectorAll('[role="menuitem"]'));
    if (!heading || items.length < 2) continue;
    const labels = activeLabels || labelsFromOptions(items);
    if (!labels) continue;
    markReplacement(heading, 'Context');
    markOption(items[0], labels.default);
    markOption(items[1], labels.long);
    }
  };
  new MutationObserver(fix).observe(document.documentElement, {
    subtree: true,
    childList: true,
  });
  fix();
})()`;
}

function catalogReloadPatch(generation) {
  return `(() => {
    const generation = ${JSON.stringify(generation)};
    const storageKey = 'codex-copilot-catalog-generation';
    if (sessionStorage.getItem(storageKey) === generation) return 'active';
    const visible = (element) => {
      if (!element) return false;
      const style = getComputedStyle(element);
      return style.display !== 'none' && style.visibility !== 'hidden';
    };
    const modalOpen = Array.from(
      document.querySelectorAll('[role="dialog"], [role="menu"]')
    ).some(visible);
    const editor = Array.from(
      document.querySelectorAll('textarea, [contenteditable="true"]')
    ).find(visible);
    const draft = String(editor?.value ?? editor?.innerText ?? '').trim();
    const busy = Array.from(document.querySelectorAll('button')).some((button) => {
      if (!visible(button)) return false;
      const label = [button.getAttribute('aria-label'), button.textContent]
        .filter(Boolean)
        .join(' ');
      return /(?:stop|cancel|停止|取消)/i.test(label);
    });
    if (
      (document.visibilityState === 'visible' && document.hasFocus()) ||
      modalOpen ||
      draft ||
      busy
    ) {
      return 'deferred';
    }

    sessionStorage.setItem(storageKey, generation);
    location.reload();
    return 'reloading';
  })()`;
}

function catalogHotReloadPatch(generation) {
  return `(() => {
    const generation = ${JSON.stringify(generation)};
    const storageKey = 'codex-copilot-catalog-generation';
    if (sessionStorage.getItem(storageKey) === generation) return 'active';
    const visible = (element) => {
      if (!element) return false;
      const style = getComputedStyle(element);
      return style.display !== 'none' && style.visibility !== 'hidden';
    };
    const busy = Array.from(document.querySelectorAll('button')).some((button) => {
      if (!visible(button)) return false;
      const aria = String(button.getAttribute('aria-label') || '').trim();
      return /^(?:stop|stop generating|stop streaming|停止|停止生成)$/i.test(aria);
    });
    try { globalThis.__codexCopilotAccountUiV5?.refreshQuietly?.(); } catch {}
    if (busy) return 'deferred';
    sessionStorage.setItem(storageKey, generation);
    const send = globalThis.electronBridge?.sendMessageFromView;
    if (typeof send === 'function') {
      Promise.resolve(send({
        type: 'codex-app-server-restart',
        hostId: 'local',
        intent: 'restart',
        errorMessage: null,
      })).catch(() => {});
      return 'restarting';
    }
    return 'active';
  })()`;
}

function accountReloadPatch(generation) {
  return `(() => {
    const generation = ${JSON.stringify(generation)};
    const storageKey = 'codex-copilot-account-generation';
    if (sessionStorage.getItem(storageKey) === generation) return 'active';
    const refresh = globalThis.__codexCopilotRefreshSharedAccount;
    if (typeof refresh === 'function') return refresh(generation);
    sessionStorage.setItem(storageKey, generation);
    location.reload();
    return 'reloading';
  })()`;
}

/**
 * Installs Context/Account without changing native Model/Effort controls or
 * native Speed authorization and eligibility decisions.
 */
export async function installContextControls(
  wsUrl,
  { WebSocketImpl = globalThis.WebSocket, timeoutMs = 15000, commandTimeoutMs = 10000,
    accountTimeoutMs = 25000, assertOwned = () => {}, desktopUpdates,
    sessionRequest = requestSessions } = {},
) {
  const installation = new AbortController();
  const timer = setTimeout(() => {
    installation.abort(new Error("context control timeout"));
  }, timeoutMs);
  let connection;
  const accountResponse = async (session, result) => {
    await assertOwned();
    return session.dispatchResponse("codex-copilot-account-response", result);
  };
  const handleAccountRequest = async (payload, session) => {
    let request = null;
    let responseAttempted = false;
    const respond = result => {
      responseAttempted = true;
      return accountResponse(session, result);
    };
    try {
      await assertOwned();
      request = JSON.parse(payload);
      if (!request?.id) {
        throw new Error("Invalid Desktop account request");
      }
      if (request.action === "workiq-request") {
        const body = await handleWorkIqDesktop(request);
        await respond({ id: request.id, ok: true, status: 200, body });
        return;
      }
      if (request.action === "open-external") {
        const href = openSystemBrowser(request.url);
        await respond({
          id: request.id,
          ok: true,
          status: 200,
          body: { opened: true, href },
        });
        return;
      }
      if (request.action === "release-update-request") {
        const op = request.operation || "status";
        const route = op === "check" ? "/release-update/check"
          : op === "install" ? "/release-update/install" : "/release-update";
        const method = op === "status" ? "GET" : "POST";
        const response = await fetch(BRIDGE_ENDPOINT + route, {
          method,
          headers: { origin: "app://-", "content-type": "application/json" },
          signal: AbortSignal.any([session.signal, AbortSignal.timeout(accountTimeoutMs)]),
        });
        const body = await response.json().catch(() => ({}));
        await respond({
          id: request.id,
          ok: response.ok,
          status: response.status,
          body,
        });
        return;
      }
      if (
        request.action !== "account-request" ||
        !/^(?:\/account(?:\/refresh|\/switch(?:\/[^/]+(?:\/cancel)?)?)?|\/models\/policy)$/.test(request.path || "") ||
        !["GET", "POST"].includes(request.method)
      ) {
        throw new Error("Invalid Desktop account request");
      }
      const response = await fetch(BRIDGE_ENDPOINT + request.path, {
        method: request.method,
        headers: { origin: "app://-", "content-type": "application/json" },
        ...(request.method === "POST" && request.body !== undefined
          ? { body: typeof request.body === "string" ? request.body : JSON.stringify(request.body) }
          : {}),
        signal: AbortSignal.any([session.signal, AbortSignal.timeout(accountTimeoutMs)]),
      });
      const body = await response.json().catch(() => ({}));
      await respond({
        id: request.id,
        ok: response.ok,
        status: response.status,
        body,
      });
    } catch (error) {
      if (request?.id && session.active && !responseAttempted) {
        await respond({
          id: request.id,
          ok: false,
          status: 500,
          body: { error: error.message },
        });
      } else if (responseAttempted) throw error;
    }
  };

  try {
    await assertOwned();
    connection = await connectCdp(wsUrl, {
      WebSocketImpl,
      timeoutMs: commandTimeoutMs,
      signal: installation.signal,
      onEvent(message, session) {
        if (
          message.method === "Runtime.executionContextsCleared") {
          session.close(new Error("renderer context changed"));
        } else if (message.method === "Runtime.bindingCalled" &&
            message.params?.name === "__codexCopilotSessionRequest") {
          Promise.resolve().then(async () => {
            await assertOwned();
            const payload = message.params.payload;
            if (typeof payload !== "string" || payload.length > 256 * 1024) return;
            const request = JSON.parse(payload);
            if (typeof request.id !== "string" || !/^[a-f0-9-]{36}$/i.test(request.id)) return;
            let result;
            try {
              if (Object.keys(request).some(key => !["id", "operation", "args"].includes(key))) {
                throw new Error("Invalid session-management request.");
              }
              result = { id: request.id, ok: true, body: await sessionRequest(request.operation, request.args) };
            } catch (error) { result = { id: request.id, ok: false,
              code: error.code || null, error: error.message }; }
            await assertOwned();
            if (session.active) await session.dispatchResponse("codex-copilot-session-response", result);
          }).catch(error => log(`Desktop session binding failed: ${error.message}`));
        } else if (message.method === "Runtime.bindingCalled" &&
            message.params?.name === "__codexCopilotDesktopUpdateRequest") {
          Promise.resolve().then(async () => {
            await assertOwned();
            const payload = message.params.payload;
            if (typeof payload !== "string" || payload.length > 8192) return;
            const request = JSON.parse(payload);
            if (typeof request.id !== "string" ||
                !/^[a-f0-9-]{36}$/i.test(request.id)) return;
            let result;
            try {
              if (!desktopUpdates) throw new Error("Private Desktop updater is unavailable.");
              if (Object.keys(request).some(key => !["id", "operation"].includes(key))) {
                throw new Error("Invalid private Desktop update request.");
              }
              const body = await desktopUpdates.request({ operation: request.operation });
              result = { id: request.id, ok: true, body };
            } catch (error) { result = { id: request.id, ok: false, body: { error: error.message } }; }
            await assertOwned();
            if (session.active) await session.dispatchResponse("codex-copilot-desktop-update-response", result);
          }).catch(error => log(`Desktop update binding failed: ${error.message}`));
        } else if (
          message.method === "Runtime.bindingCalled" &&
          message.params?.name === "__codexCopilotAccountRequest"
        ) {
          handleAccountRequest(message.params.payload, session).catch((error) => {
            log(`Desktop account binding failed: ${error.message}`);
          });
        }
      },
    });
    await assertOwned();
    await connection.send("Runtime.enable");
    await connection.send("Runtime.addBinding", {
      name: "__codexCopilotAccountRequest",
    });
    if (desktopUpdates) {
      await assertOwned();
      await connection.send("Runtime.addBinding", { name: "__codexCopilotDesktopUpdateRequest" });
      connection.desktopUpdatesState = await connection.evaluate(buildDesktopUpdateUiPatch());
      connection.releaseNoticeState = await connection.evaluate(buildDesktopReleaseNoticePatch());
    }
    await connection.evaluate(buildAccountUiPatch());
    await connection.send("Runtime.addBinding", { name: "__codexCopilotSessionRequest" });
    connection.sessionsState = await connection.evaluate(buildDesktopSessionsPatch());
    connection.creditsState = await connection.evaluate(`(() => {
      globalThis.__codexCopilotCreditsV1?.dispose?.();
      document.getElementById('codex-copilot-credits')?.remove();
      document.getElementById('codex-copilot-credits-style')?.remove();
      return 'account-only';
    })()`);
    // The app's model callback owns the active thread. Keep both native Context
    // aliases, but present Model, Effort and Context as independent controls.
    connection.modelControlsState =
      await connection.evaluate(buildDesktopModelControlsPatch(loadDesktopModelGroups()));
    // "active" means installed, not necessarily bound to the current React tree.
    // Preserve reload-required without refreshing an active user renderer.
    connection.modelControlsAvailable = connection.modelControlsState === "active";
    connection.modelControlsReloadRequired = connection.modelControlsState === "reload-required";
    connection.modelControlsInspection = connection.modelControlsAvailable
      ? await connection.evaluate("globalThis.__codexCopilotModelControlsV1?.inspect?.() ?? null")
      : null;
    const modelBound = connection.modelControlsInspection?.bound;
    connection.modelControlsBound = typeof modelBound === "boolean" ? modelBound : null;
    await assertOwned();
    connection.signal.throwIfAborted();
    if (!connection.active) throw new Error("CDP connection is not open");
    connection.contextControlsAvailable = false; // No legacy Speed permission hook.
    connection.contextExtensionBound = connection.modelControlsBound;
    return connection;
  } catch (error) {
    connection?.close(error);
    throw error;
  } finally {
    clearTimeout(timer);
  }
}

async function mainOwned() {
  assertPrivateDesktopHome(CODEX_COPILOT_HOME);
  const args = process.argv.slice(2);
  const receiptFile = path.resolve(CODEX_COPILOT_HOME, "desktop-instance.json");
  if (args.length !== 4 || args[0] !== "--instance" ||
      path.resolve(args[1]) !== receiptFile || args[2] !== "--token") {
    throw new Error("Desktop extension requires a verified private instance receipt; bare ports and stock windows are not accepted.");
  }
  const receipt = readDesktopInstance(CODEX_COPILOT_HOME);
  const initialOwnership = process.platform === "win32" &&
    fs.existsSync(path.resolve(import.meta.dirname, "../bin/ccodex-process-probe.exe"))
    ? readProcessIdentity(receipt.pid, { expectedLifetime: receipt.identity?.lifetime })
    : process.platform === "win32" ? await inspectWindowsDesktopOwnership(receipt) : null;
  let initialOwnershipConsumed = false;
  const binding = bindDesktopInstance({
    root: path.resolve(import.meta.dirname, ".."), home: CODEX_COPILOT_HOME,
    ...(initialOwnership ? {
      receipt, inspectProcess: pid => {
        if (!initialOwnershipConsumed && pid === receipt.pid) {
          initialOwnershipConsumed = true;
          return initialOwnership;
        }
        return readProcessIdentity(pid);
      },
    } : {}),
  });
  if (!binding || binding.receipt.helperToken !== args[3]) {
    throw new Error("Desktop extension token/lifetime does not match this private instance.");
  }
  const assertUpdateOwned = () => {
    const current = readDesktopInstance(CODEX_COPILOT_HOME);
    if (current?.instanceToken !== binding.receipt.instanceToken || current?.helperToken !== args[3]) {
      throw new Error("The private Desktop helper was superseded; no other instance was used.");
    }
    binding.assertOwned();
  };
  const assertOwned = createDesktopOwnershipGuard(binding, {
    home: CODEX_COPILOT_HOME, helperToken: args[3],
  });
  const port = binding.receipt.debugPort;
  await assertOwned();
  const desktopUpdates = createDesktopUpdateService({
    root: binding.receipt.installRoot, home: CODEX_COPILOT_HOME,
    runningSnapshot: binding.receipt.snapshotVersion, assertOwned: assertUpdateOwned,
  });
  if (typeof globalThis.WebSocket !== "function") {
    log("this Node.js build has no WebSocket support (Node 22+ required); the picker keeps its built-in model list");
    return;
  }
  // bindDesktopInstance already verified the snapshot hashes and contract. Reuse
  // that exact core, rather than hashing the whole application on the first click.
  const sessionRequest = createDesktopSessionApi({
    home: CODEX_COPILOT_HOME, port: binding.receipt.bridgePort,
    core: path.join(binding.runtime.resources, process.platform === "win32" ? "codex.exe" : "codex"),
  });

  let misses = 0;
  let sawApp = false;
  const announced = new Set();
  const contextSessions = new CdpTargetSessions();
  let observedCatalogGeneration = readCatalogGeneration();
  let pendingCatalogGeneration = null;
  let observedSelectionGeneration = readSelectionGeneration();
  let pendingSelectionGeneration = null;
  let observedAccountGeneration = readAccountGeneration();
  let pendingAccountGeneration = null;
  const windowIcons = createDesktopIconController({
    root: binding.receipt.installRoot, home: CODEX_COPILOT_HOME,
    helperToken: args[3], assertOwned, log,
  });

  try {
    for (;;) {
      try {
        await assertOwned();
      } catch (error) {
        if (error.code !== "ETIMEDOUT" && !error.killed) throw error;
        log("Private Desktop verification temporarily timed out; retrying without mutating an unverified renderer.");
        await new Promise(resolve => setTimeout(resolve, POLL_MS));
        continue;
      }
      await windowIcons.refresh();

      let targets;
      try {
        targets = await listTargets(port);
        misses = 0;
        sawApp = true;
      } catch (error) {
        misses += 1;
        if (misses >= MISS_LIMIT) {
          log(sawApp ? "app window closed; stopping" : `debug endpoint never came up on ${port}: ${error.message}`);
          return;
        }
        await new Promise((r) => setTimeout(r, POLL_MS));
        continue;
      }
      contextSessions.retain(targets);

      const currentCatalogGeneration = readCatalogGeneration();
      if (
        currentCatalogGeneration &&
        observedCatalogGeneration &&
        currentCatalogGeneration !== observedCatalogGeneration
      ) {
        observedCatalogGeneration = currentCatalogGeneration;
        pendingCatalogGeneration = currentCatalogGeneration;
        log(`catalog generation changed ${currentCatalogGeneration}`);
      } else if (!observedCatalogGeneration && currentCatalogGeneration) {
        observedCatalogGeneration = currentCatalogGeneration;
      }
      const currentSelectionGeneration = readSelectionGeneration();
      if (
        currentSelectionGeneration &&
        observedSelectionGeneration &&
        currentSelectionGeneration !== observedSelectionGeneration
      ) {
        observedSelectionGeneration = currentSelectionGeneration;
        pendingSelectionGeneration = currentSelectionGeneration;
        log(`selection generation changed ${currentSelectionGeneration}`);
      } else if (!observedSelectionGeneration && currentSelectionGeneration) {
        observedSelectionGeneration = currentSelectionGeneration;
      }
      const currentAccountGeneration = readAccountGeneration();
      if (
        currentAccountGeneration &&
        observedAccountGeneration &&
        currentAccountGeneration !== observedAccountGeneration
      ) {
        observedAccountGeneration = currentAccountGeneration;
        pendingAccountGeneration = currentAccountGeneration;
        log(`account generation changed ${currentAccountGeneration}`);
      } else if (!observedAccountGeneration && currentAccountGeneration) {
        observedAccountGeneration = currentAccountGeneration;
      }

      for (const target of targets) {
        await assertOwned();
        try {
          const state = await evaluate(target.webSocketDebuggerUrl, PATCH_SOURCE);
          const key = `${target.id}:${state}`;
          if (state === "patched" || (state === "active" && !announced.has(key))) {
            announced.add(key);
            log(`${state} ${target.url}`);
          }
        } catch (error) {
          log(`could not patch ${target.url}: ${error.message}`);
        }
        // Runtime.executionContextsCleared, socket closure and target pruning
        // already retire dead bindings. An independent background-page probe
        // can time out while the owning binding is healthy; do not discard its
        // pending account or history responses on that unrelated observation.
        if (!contextSessions.has(target.id)) {
          try {
            const session = await installContextControls(target.webSocketDebuggerUrl, {
              assertOwned, desktopUpdates, sessionRequest,
            });
            contextSessions.set(target.id, session);
            log(`Desktop controls: model-install=${session.modelControlsState}, ` +
              `model-binding=${session.modelControlsBound === true ? "bound" :
                session.modelControlsBound === false ? "unbound" : "unverified"}, ` +
              `model-reload=${session.modelControlsReloadRequired ? "required" : "not-required"}, ` +
              `service-tier-labels=${session.contextControlsAvailable ? "active" : "unavailable"} ${target.url}`);
          } catch (error) {
            log(`could not patch context controls ${target.url}: ${error.message}`);
          }
        }
        if (
          pendingAccountGeneration &&
          target.url.startsWith("app://-/") &&
          !target.url.includes("initialRoute=%2Favatar-overlay")
        ) {
          try {
            const refreshState = await evaluate(
              target.webSocketDebuggerUrl,
              accountReloadPatch(pendingAccountGeneration),
            );
            if (
              refreshState === "restarting" ||
              refreshState === "reloading" ||
              refreshState === "active"
            ) {
              await new Promise((resolveWait) => setTimeout(resolveWait, 4000));
              contextSessions.delete(target.id);
              await reloadPage(target.webSocketDebuggerUrl);
              log(`account page reload after ${refreshState} ${target.url}`);
              pendingAccountGeneration = null;
              pendingCatalogGeneration = null;
            }
          } catch (error) {
            log(`could not refresh account in ${target.url}: ${error.message}`);
          }
        }
        if (pendingCatalogGeneration && target.url === "app://-/index.html") {
          try {
            const groups = loadDesktopModelGroups();
            const existingSession = contextSessions.get(target.id);
            if (existingSession?.active) {
              await existingSession.evaluate(buildDesktopModelControlsPatch(groups));
            } else {
              await evaluate(target.webSocketDebuggerUrl, buildDesktopModelControlsPatch(groups));
            }
            const refreshState = await evaluate(
              target.webSocketDebuggerUrl,
              catalogHotReloadPatch(pendingCatalogGeneration),
            );
            if (refreshState === "restarting" || refreshState === "active") {
              if (refreshState === "restarting") {
                await new Promise((resolveWait) => setTimeout(resolveWait, 2000));
                const refreshedSession = contextSessions.get(target.id);
                if (refreshedSession?.active) {
                  await refreshedSession.evaluate(buildDesktopModelControlsPatch(groups));
                }
              }
              log(`catalog hot reload ${refreshState} ${target.url} (${pendingCatalogGeneration})`);
              pendingCatalogGeneration = null;
            }
          } catch (error) {
            log(`could not hot-reload catalog in ${target.url}: ${error.message}`);
          }
        }
        if (pendingSelectionGeneration && target.url === "app://-/index.html") {
          try {
            const refreshState = await evaluate(
              target.webSocketDebuggerUrl,
              catalogReloadPatch(pendingSelectionGeneration),
            );
            if (refreshState === "reloading" || refreshState === "active") {
              log(`selection state reload ${refreshState} ${target.url}`);
              pendingSelectionGeneration = null;
            }
          } catch (error) {
            log(`could not refresh model state in ${target.url}: ${error.message}`);
          }
        }
      }

      await new Promise((r) => setTimeout(r, POLL_MS));
    }
  } finally {
    contextSessions.close();
    windowIcons.close();
    await sessionRequest.close();
  }
}

async function main() {
  const root = path.resolve(import.meta.dirname, "..");
  const releaseFile = path.join(root, "release.json");
  let generation;
  if (fs.existsSync(releaseFile)) {
    const metadata = JSON.parse(fs.readFileSync(releaseFile, "utf8"));
    generation = `${metadata.releaseId}:${metadata.fileManifestSha256}`;
  } else {
    const { bridgeSourceGeneration } = await import("./runtime-generation.mjs");
    generation = bridgeSourceGeneration(import.meta.dirname);
  }
  const cache = new FileValidationCache({ root, home: CODEX_COPILOT_HOME, generation });
  return withFileValidation(cache, mainOwned);
}

if (process.argv[1] && pathToFileURL(path.resolve(process.argv[1])).href === import.meta.url) {
  main().catch((error) => {
    log(`stopped: ${error.message}`);
    process.exitCode = 1;
  });
}

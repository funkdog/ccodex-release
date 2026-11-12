/** Add private update controls without remounting the native Model/Effort UI. */
export function buildDesktopUpdateUiPatch() {
  return `(() => {
    const previous = globalThis.__codexCopilotDesktopUpdatesV1;
    if (previous) return 'active';
    if (!document.documentElement) return 'waiting';
    const pending = new Map();
    let timer = null;
    let view = 0;
    let disposed = false;
    const root = document.createElement('section');
    root.id = 'codex-copilot-desktop-update-panel';
    root.setAttribute('role', 'dialog');
    root.setAttribute('aria-label', 'Codex (Copilot) Desktop updates');
    root.hidden = true;
    const style = document.createElement('style');
    style.id = 'codex-copilot-desktop-update-style';
    style.textContent = \`
      #codex-copilot-desktop-update-panel {
        position: fixed; z-index: 2147483646; bottom: 20px; left: 20px;
        width: min(390px, calc(100vw - 40px)); box-sizing: border-box;
        max-height: calc(100vh - 40px); overflow: auto; padding: 18px;
        border: 1px solid var(--border-light, #555); border-radius: 12px;
        background: var(--main-surface-primary, #242424);
        color: var(--text-primary, #eee); box-shadow: 0 12px 36px rgba(0,0,0,.25);
        font: inherit;
      }
      #codex-copilot-desktop-update-panel[hidden] { display: none; }
      #codex-copilot-desktop-update-panel h2 { font: inherit; font-weight: 600; margin: 0 0 12px; }
      #codex-copilot-desktop-update-panel p { margin: 8px 0; overflow-wrap: anywhere; }
      #codex-copilot-desktop-update-panel footer { display: flex; flex-wrap: wrap; gap: 8px; margin-top: 16px; }
      #codex-copilot-desktop-update-panel button {
        font: inherit; color: inherit; border: 1px solid var(--border-light, #555);
        border-radius: 7px; padding: 6px 10px; cursor: pointer;
        background: var(--main-surface-secondary, #333);
      }
      #codex-copilot-desktop-update-panel button:disabled { opacity: .5; cursor: default; }
    \`;
    const create = (tag, text) => {
      const element = document.createElement(tag);
      if (text !== undefined) element.textContent = text;
      return element;
    };
    const heading = create('h2', 'Codex (Copilot) Desktop updates');
    const content = create('div');
    content.setAttribute('aria-live', 'polite');
    const actions = create('footer');
    root.append(heading, content, actions);
    document.head.appendChild(style);
    document.body.appendChild(root);
    const respond = event => {
      const result = event.detail || {};
      const waiter = pending.get(result.id);
      if (!waiter) return;
      pending.delete(result.id); clearTimeout(waiter.timer);
      if (result.ok) waiter.resolve(result.body);
      else waiter.reject(new Error(result.body?.error || 'Private update request failed.'));
    };
    const request = operation => new Promise((resolve, reject) => {
      if (disposed || typeof globalThis.__codexCopilotDesktopUpdateRequest !== 'function') {
        reject(new Error('Private Desktop updater is unavailable.')); return;
      }
      const id = crypto.randomUUID();
      const timeout = setTimeout(() => {
        pending.delete(id); reject(new Error('Private update request timed out.'));
      }, 15000);
      pending.set(id, { resolve, reject, timer: timeout });
      globalThis.__codexCopilotDesktopUpdateRequest(JSON.stringify({ id, operation }));
    });
    const close = () => {
      view++; root.hidden = true; clearTimeout(timer); timer = null;
    };
    const button = (label, operation, disabled = false) => {
      const element = create('button', label);
      element.type = 'button'; element.disabled = disabled;
      element.addEventListener('click', () => operation ? refresh(operation) : close());
      actions.appendChild(element);
    };
    const render = state => {
      content.replaceChildren();
      actions.replaceChildren();
      content.appendChild(create('p', 'Selected: ' + (state.selectedSnapshot || 'Not selected')));
      const operation = state.operation || {};
      if (operation.candidate) content.appendChild(create('p', 'Candidate: ' + operation.candidate));
      content.appendChild(create('p', state.busy ? 'Update work is queued or running in the background.'
        : operation.status === 'promoted' ? 'Update selected. Close and reopen this enhanced Desktop when idle.'
        : operation.status === 'needs-validation' ? 'Candidate still needs native UI and extension verification.'
        : operation.status === 'validated' ? 'Candidate validation passed. The private update can be applied.'
        : operation.status === 'prepared' ? 'Official package verified. Validate the retained extensions next.'
        : operation.status === 'metadata-checked' ? 'Official download metadata checked. Download to verify the version.'
        : operation.status === 'rejected' ? 'Update was not applied.'
        : 'Updates use a private official-package snapshot and retain the Copilot extensions.'));
      if (operation.message) content.appendChild(create('p', operation.message));
      button('Check for updates', 'check', state.busy);
      button('Download official update', 'prepare', state.busy);
      if (operation.candidate && operation.status !== 'promoted') {
        button(operation.status === 'validated' ? 'Apply private update' : 'Validate candidate',
          operation.status === 'validated' ? 'apply' : 'validate', state.busy);
      }
      button('Close');
    };
    async function refresh(operation = 'status') {
      const current = ++view;
      clearTimeout(timer); timer = null;
      try {
        const result = await request(operation);
        if (disposed || current !== view || root.hidden) return;
        render(result);
        if (result.busy) timer = setTimeout(() => refresh(), 2000);
      } catch (error) {
        if (disposed || current !== view || root.hidden) return;
        content.replaceChildren(create('p', error.message));
        actions.replaceChildren(); button('Retry', 'status'); button('Close');
      }
    }
    const open = () => { root.hidden = false; refresh(); };
    const nativeUpdateClick = event => {
      const target = event.target?.closest?.('button, [role="menuitem"]');
      if (!target || root.contains(target) ||
          target.closest('.markdown, [data-message-author-role], [data-testid="conversation-turn"]')) return;
      const label = (target.getAttribute('aria-label') || target.textContent || '').trim();
      if (!/^(?:Check for [Uu]pdates(?:\\u2026|\\.{3})?|Restart to update|Update (?:ChatGPT|Codex)|\u68c0\u67e5\u66f4\u65b0(?:\\u2026|\\.{3})?|\u6aa2\u67e5\u66f4\u65b0(?:\\u2026|\\.{3})?|\u91cd\u542f\u4ee5\u66f4\u65b0|\u91cd\u65b0\u542f\u52a8\u4ee5\u66f4\u65b0|\u91cd\u65b0\u555f\u52d5\u4ee5\u66f4\u65b0)$/.test(label)) return;
      event.preventDefault(); event.stopImmediatePropagation(); open();
    };
    const keydown = event => {
      if (!root.hidden && event.key === 'Escape') { event.preventDefault(); close(); }
    };
    globalThis.addEventListener('codex-copilot-desktop-update-response', respond);
    globalThis.addEventListener('click', nativeUpdateClick, true);
    globalThis.addEventListener('keydown', keydown);
    globalThis.__codexCopilotDesktopUpdatesV1 = {
      revision: 1, open, inspect: () => ({ installed: true, nativeControlsRemounted: false }),
      dispose: () => {
        disposed = true; close(); root.remove(); style.remove();
        globalThis.removeEventListener('codex-copilot-desktop-update-response', respond);
        globalThis.removeEventListener('click', nativeUpdateClick, true);
        globalThis.removeEventListener('keydown', keydown);
        for (const waiter of pending.values()) {
          clearTimeout(waiter.timer); waiter.reject(new Error('Private updater disposed.'));
        }
        pending.clear(); delete globalThis.__codexCopilotDesktopUpdatesV1;
      },
    };
    return 'active';
  })()`;
}

import { CREDITS_RULES } from "./copilot-credits.mjs";

export function buildDesktopCreditsPatch() {
  return `(() => {
    const rules = ${JSON.stringify(CREDITS_RULES)};
    const previous = globalThis.__codexCopilotCreditsV1;
    if (previous) return 'active';
    if (!document.documentElement) return 'unavailable';
    const root = document.createElement('div');
    root.id = 'codex-copilot-credits';
    root.setAttribute('role', 'status');
    root.setAttribute('aria-live', 'polite');
    const ring = document.createElementNS('http://www.w3.org/2000/svg', 'svg');
    ring.setAttribute('viewBox', '0 0 40 40');
    ring.setAttribute('width', '36'); ring.setAttribute('height', '36');
    ring.setAttribute('aria-hidden', 'true');
    const circle = (name) => {
      const node = document.createElementNS('http://www.w3.org/2000/svg', 'circle');
      node.setAttribute('cx', '20'); node.setAttribute('cy', '20'); node.setAttribute('r', '16');
      node.setAttribute('fill', 'none'); node.setAttribute('stroke-width', '3');
      node.setAttribute('class', name); ring.appendChild(node); return node;
    };
    circle('cc-credits-track');
    const arc = circle('cc-credits-arc');
    arc.setAttribute('pathLength', '100'); arc.setAttribute('stroke-dasharray', '100');
    arc.setAttribute('stroke-dashoffset', '100');
    const text = document.createElement('span');
    const usage = document.createElement('span');
    const detail = document.createElement('small');
    usage.textContent = rules.unavailable;
    text.append(usage, detail); root.append(ring, text);
    const style = document.createElement('style');
    style.id = 'codex-copilot-credits-style';
    style.textContent = \`
      #codex-copilot-credits {
        display: flex; align-items: center; gap: 8px; padding: 6px 8px;
        font: 12px/18px system-ui,sans-serif; color: var(--text-secondary, #aaa);
      }
      #codex-copilot-credits svg { flex: 0 0 auto; }
      #codex-copilot-credits span span, #codex-copilot-credits small { display: block; }
      #codex-copilot-credits small { opacity: .75; }
      #codex-copilot-credits .cc-credits-track { stroke: var(--border-light, #7774); }
      #codex-copilot-credits .cc-credits-arc {
        transform: rotate(-90deg); transform-origin: 20px 20px; stroke-linecap: round;
        transition: stroke-dashoffset \${rules.transitionMs}ms cubic-bezier(.33,1,.68,1),
          stroke \${rules.transitionMs}ms ease-out;
      }
      @media(prefers-reduced-motion:reduce) {
        #codex-copilot-credits .cc-credits-arc { transition: none; }
      }
    \`;
    document.head.appendChild(style);
    let disposed = false, refreshing = false, last = null, generation = null;
    const pending = new Map();
    const response = event => {
      const value = event.detail || {}, operation = pending.get(value.id);
      if (!operation) return;
      pending.delete(value.id); clearTimeout(operation.timer);
      if (value.ok) operation.resolve(value.body);
      else operation.reject(new Error(value.body?.error || 'AI credit refresh failed.'));
    };
    globalThis.addEventListener('codex-copilot-account-response', response);
    const request = () => new Promise((resolve, reject) => {
      if (typeof globalThis.__codexCopilotAccountRequest !== 'function') {
        reject(new Error('The local account bridge is unavailable.')); return;
      }
      const id = crypto.randomUUID();
      const timer = setTimeout(() => { pending.delete(id); reject(new Error('AI credit refresh timed out.')); }, 15000);
      pending.set(id, { resolve, reject, timer });
      globalThis.__codexCopilotAccountRequest(JSON.stringify({
        id, action: 'account-request', path: '/account', method: 'GET'
      }));
    });
    const paint = view => {
      const expired = view && Date.parse(view.expiresAt) <= Date.now();
      if (!view || expired) {
        usage.textContent = rules.unavailable; detail.textContent = expired ? 'Data expired' : 'Not reported by GitHub';
        arc.setAttribute('stroke', rules.colors.unavailable.hex); arc.setAttribute('stroke-dashoffset', '100');
        root.setAttribute('data-status', 'unavailable'); return;
      }
      usage.textContent = view.usageText;
      detail.textContent = [view.percentText, view.detailText].filter(Boolean).join(' · ');
      arc.setAttribute('stroke', view.color.hex);
      arc.setAttribute('stroke-dashoffset', String(100 * (1 - (view.progress ?? 0))));
      root.setAttribute('data-status', view.status); root.setAttribute('aria-label', view.statusText);
    };
    const attach = () => {
      if (disposed) return;
      const button = Array.from(document.querySelectorAll('button')).find(node =>
        /profile menu|个人资料菜单/i.test(node.getAttribute('aria-label') || '')
          || node.textContent?.trim() === 'GitHub Copilot');
      const parent = button?.parentElement;
      if (parent && root.parentElement !== parent && !parent.closest('button')) parent.insertBefore(root, button);
    };
    const refresh = async () => {
      if (disposed || refreshing) return;
      refreshing = true; attach();
      try {
        const account = await request();
        if (disposed) return;
        if (generation !== account.accountGeneration) { last = null; paint(null); generation = account.accountGeneration; }
        if (account.status !== 'authenticated') { last = null; paint(null); return; }
        const view = account.credits;
        if (view?.schemaVersion !== 1 || view.unit !== 'credits' || view.accountGeneration !== account.accountGeneration) {
          throw new Error('AI credits do not match the current account.');
        }
        last = view; paint(view);
      } catch (error) {
        if (!disposed) {
          paint(last);
          if (last && Date.parse(last.expiresAt) > Date.now()) {
            detail.textContent = rules.stale + ': ' + error.message;
            arc.setAttribute('stroke', rules.colors.unavailable.hex);
            root.setAttribute('data-status', 'stale');
          } else detail.textContent = error.message;
        }
      } finally { refreshing = false; }
    };
    const timer = setInterval(refresh, rules.refreshMs);
    const expiry = setInterval(() => { attach(); if (last && Date.parse(last.expiresAt) <= Date.now()) paint(last); }, 1000);
    globalThis.__codexCopilotCreditsV1 = {
      refresh, inspect: () => ({ attached: root.isConnected, status: root.getAttribute('data-status'),
        generation, unit: 'credits', refreshMs: rules.refreshMs, transitionMs: rules.transitionMs }),
      dispose: () => {
        if (disposed) return; disposed = true; clearInterval(timer); clearInterval(expiry);
        globalThis.removeEventListener('codex-copilot-account-response', response);
        for (const operation of pending.values()) { clearTimeout(operation.timer); operation.reject(new Error('Credits renderer disposed.')); }
        pending.clear(); root.remove(); style.remove();
        delete globalThis.__codexCopilotCreditsV1;
      },
    };
    refresh(); return 'active';
  })()`;
}

/**
 * An in-panel Context extension of the vendor's model picker. The original trigger,
 * model popover, effort slider, animations and their event handlers remain
 * mounted. No substitute Effort UI and no hidden native trigger are installed.
 */
export function buildDesktopNativeContextPatch(groups, functions) {
  return `(() => {
    let groups = ${JSON.stringify(groups)};
    if (!groups.length || !document.documentElement) return 'unavailable';
    const previous = globalThis.__codexCopilotModelControlsV1;
    if (previous?.revision === 6) {
      if (typeof previous.setGroups === 'function') previous.setGroups(groups);
      previous.refresh();
      return 'active';
    }
    if (previous) {
      if (typeof previous.dispose !== 'function') return 'reload-required';
      previous.dispose();
    }
    ${functions.join("\n")}
    const style = document.createElement('style');
    style.id = 'codex-copilot-context-extension-style';
    style.textContent = \`
      #codex-copilot-context-trigger {
        appearance: none; display: inline-flex; align-items: center; gap: 5px;
        padding: 3px 6px; border: 0; border-radius: 7px; background: transparent;
        color: var(--text-secondary, #aaa); cursor: pointer; font: inherit;
        flex: 0 0 auto; white-space: nowrap; font-size: 12px; line-height: 20px;
      }
      #codex-copilot-context-trigger:hover {
        background: var(--main-surface-secondary, rgba(128,128,128,.16));
      }
      #codex-copilot-context-trigger:focus-visible {
        outline: 2px solid var(--ring, #6f8eff); outline-offset: 1px;
      }
      #codex-copilot-context-trigger:disabled { opacity: .45; cursor: default; }
      #codex-copilot-context-menu {
        position: fixed; z-index: 2147483645; min-width: 200px; padding: 7px;
        margin: 0; inset: auto;
        border-radius: 12px; border: 1px solid var(--border-light, #555);
        background: var(--main-surface-primary, #242424);
        color: var(--text-primary, #eee); box-shadow: 0 12px 36px rgba(0,0,0,.25);
      }
      #codex-copilot-context-menu[hidden] { display: none; }
      #codex-copilot-context-menu button {
        display: flex; width: 100%; gap: 12px; justify-content: space-between;
        appearance: none; padding: 8px 10px; border: 0; border-radius: 7px;
        background: transparent; color: inherit; cursor: pointer; font: inherit;
      }
      #codex-copilot-context-menu button:hover,
      #codex-copilot-context-menu button:focus-visible {
        outline: none; background: var(--main-surface-secondary, #444);
      }
      #codex-copilot-context-menu button:disabled { opacity: .45; cursor: default; }
      #codex-copilot-context-menu [role="alert"] { padding: 8px; color: var(--text-danger, #e66); }
      [data-cc-context-model-alias-hidden] { display: none !important; }
      [data-cc-context-popover] {
        min-width: min(340px, calc(100vw - 24px));
        max-width: calc(100vw - 24px);
      }
      [data-cc-context-panel-row] {
        display: flex; align-items: center; justify-content: space-between;
        gap: 8px; min-width: 0; width: 100%;
      }
      [data-cc-context-panel-row] > [data-model-picker-view-toggle] {
        flex: 1 1 auto; min-width: 0;
      }
      [data-cc-context-panel-row] [class*="ViewToggleModelLabel"] {
        max-width: none; white-space: normal; overflow: visible; text-overflow: clip;
        overflow-wrap: anywhere; line-height: 1.3;
      }
    \`;
    const button = document.createElement('button');
    button.id = 'codex-copilot-context-trigger';
    button.type = 'button';
    button.setAttribute('aria-haspopup', 'menu');
    button.setAttribute('aria-controls', 'codex-copilot-context-menu');
    button.setAttribute('aria-expanded', 'false');
    button.setAttribute('role', 'menuitem');
    const menu = document.createElement('div');
    menu.id = 'codex-copilot-context-menu';
    menu.setAttribute('role', 'menu');
    menu.setAttribute('aria-label', 'Context window');
    menu.hidden = true;
    document.head.appendChild(style);
    document.body.appendChild(menu);
    const listeners = [];
    const marked = new Set();
    const textEdits = new Map();
    const panelRows = new Set();
    const popovers = new Set();
    let owner = null;
    let operation = null;
    let disposed = false;
    let scheduled = false;
    let error = '';
    let placement = null;
    let previewState = null;
    const listen = (target, event, callback, options) => {
      target.addEventListener(event, callback, options);
      listeners.push([target, event, callback, options]);
    };
    const current = () => {
      const triggers = Array.from(document.querySelectorAll('[data-codex-intelligence-trigger]'));
      triggers.sort((a, b) => Number(b.getAttribute('aria-expanded') === 'true') -
        Number(a.getAttribute('aria-expanded') === 'true'));
      for (const trigger of triggers) {
        if (trigger.disabled || trigger.getAttribute('aria-disabled') === 'true') continue;
        let hidden = false;
        for (let node = trigger; node; node = node.parentElement) {
          if (node.hidden || node.getAttribute?.('aria-hidden') === 'true') { hidden = true; break; }
        }
        if (hidden || (typeof trigger.getClientRects === 'function' && !trigger.getClientRects().length)) continue;
        const active = desktopPickerBinding(groups, trigger);
        if (active && !active.props.disabled) return active;
      }
      return null;
    };
    const close = () => {
      if (operation?.timer) clearTimeout(operation.timer);
      operation = null; owner = null; error = '';
      menu.hidden = true;
      if (typeof menu.hidePopover === 'function' && menu.matches(':popover-open')) menu.hidePopover();
      button.setAttribute('aria-expanded', 'false');
      const active = current();
      button.disabled = Boolean(!active || active.props.modelOptionsDisabled ||
        active.props.daybreak?.disabled || active.props.daybreak?.isSaving || active.state.contexts.length < 2 ||
        (previewState && active && (previewState.model !== active.state.model ||
          previewState.effort !== active.state.effort)));
    };
    const position = () => {
      const rect = button.getBoundingClientRect();
      const height = menu.getBoundingClientRect().height;
      menu.style.left = Math.max(8, Math.min(rect.left, innerWidth - 240)) + 'px';
      menu.style.top = Math.max(8, Math.min(innerHeight - height - 8, rect.top - height - 6)) + 'px';
    };
    const renderMenu = (active) => {
      if (menu.hidden) return;
      menu.replaceChildren();
      for (const context of active.state.contexts) {
        const option = document.createElement('button');
        option.type = 'button';
        option.setAttribute('role', 'menuitemradio');
        option.setAttribute('aria-checked', String(context.selected));
        option.setAttribute('data-cc-context-tier', context.id);
        option.textContent = context.label + (context.selected ? ' ✓' : '');
        option.disabled = Boolean(context.disabled || operation || active.props.modelOptionsDisabled ||
          active.props.daybreak?.disabled || active.props.daybreak?.isSaving);
        option.addEventListener('click', () => choose(context.id, active));
        menu.appendChild(option);
      }
      if (error) {
        const message = document.createElement('div');
        message.setAttribute('role', 'alert'); message.textContent = error;
        menu.appendChild(message);
      }
      position();
    };
    const nativeMenuFor = (active) => {
      const id = active.trigger.getAttribute('aria-controls');
      const controlled = id && document.querySelector('[id="' + id.replace(/["\\\\]/g, '\\\\$&') + '"]');
      if (controlled && controlled !== menu && controlled.isConnected) return controlled;
      const content = active.props.contentRef?.current;
      if (content?.isConnected && content !== menu) return content;
      for (const candidate of document.querySelectorAll('[data-model-picker-view]')) {
        const binding = desktopPickerBinding(groups, candidate);
        if (binding && binding.scope === active.scope &&
          (binding.fiber === active.fiber || binding.fiber.alternate === active.fiber) &&
          binding.props.onSelectModel === active.props.onSelectModel) {
          return candidate.closest('[role="menu"]') || candidate;
        }
      }
      return null;
    };
    const nativeText = (node) => {
      const edit = textEdits.get(node);
      return edit && node.textContent === edit.rendered ? edit.original : node.textContent;
    };
    const label = value => String(value || '').replace(/\\u200B/g, '').trim();
    const setLeafText = (node, value) => {
      if (node.children.length || node.textContent === value) return;
      const edit = textEdits.get(node);
      const original = edit && node.textContent === edit.rendered ? edit.original : node.textContent;
      textEdits.set(node, { original, rendered: value });
      node.textContent = value;
    };
    const restoreText = () => {
      for (const [node, edit] of textEdits) {
        if (!node.children.length && node.textContent === edit.rendered) node.textContent = edit.original;
      }
      textEdits.clear();
    };
    const cleanModelLabels = (root, group, nativeNames) => {
      for (const leaf of root.querySelectorAll('span, div')) {
        if (leaf.children.length) continue;
        const text = label(nativeText(leaf));
        if (nativeNames.some(name => label(name) === text ||
          label(name).replace(/^GPT[- ]/i, '') === text)) setLeafText(leaf, group.name);
      }
    };
    const englishEfforts = (root, effort) => {
      for (const node of root.querySelectorAll('[data-reasoning-effort], span, div')) {
        const advertised = node.getAttribute('data-reasoning-effort');
        const value = formatDesktopEffort(advertised || (String(node.className || '')
          .includes('ViewToggleEffortLabel') ? effort : null));
        if (!value) continue;
        if (!node.children.length) setLeafText(node, value);
        else {
          const leaves = Array.from(node.querySelectorAll('span, div')).filter(leaf => !leaf.children.length);
          if (leaves.length === 1) setLeafText(leaves[0], value);
        }
      }
    };
    const updateTriggerSummary = (active) => {
      const group = groups.find(candidate => candidate.id === active.state.model);
      if (!group) return;
      const names = active.props.modelOptions.filter(option =>
        Object.values(group.options).some(context => context.slug === option.model?.model))
        .map(option => option.model.displayName);
      cleanModelLabels(active.trigger, group, [...names, group.name]);
      englishEfforts(active.trigger, active.state.effort);
      const summary = group.name + (formatDesktopEffort(active.state.effort)
        ? ' · ' + formatDesktopEffort(active.state.effort) : '');
      for (const leaf of active.trigger.querySelectorAll('span, div')) {
        if (leaf.children.length) continue;
        if (/^(?:Select intensity|Choose intensity|Select effort|Choose effort|Select model|\\u9009\\u62e9\\u5f3a\\u5ea6|\\u9078\\u64c7\\u5f37\\u5ea6|\\u9009\\u62e9\\u6a21\\u578b|\\u9078\\u64c7\\u6a21\\u578b)$/i.test(label(nativeText(leaf)))) {
          setLeafText(leaf, summary);
        }
      }
    };
    const attachInsidePanel = (active, nativeMenu) => {
      const toggle = nativeMenu?.querySelector('[data-model-picker-view-toggle]');
      const slider = nativeMenu?.querySelector('[data-reasoning-slider]');
      const genericSlider = nativeMenu?.querySelector('[role="slider"]');
      const parent = toggle && slider ? toggle.parentElement : genericSlider?.parentElement;
      if (!parent || parent === active.trigger.parentElement || parent.closest('button')) {
        button.remove(); placement = null; previewState = null;
        if (!menu.hidden) close();
        return;
      }
      if (button.parentElement !== parent) parent.appendChild(button);
      if (nativeMenu && !nativeMenu.hasAttribute('data-cc-context-popover')) {
        nativeMenu.setAttribute('data-cc-context-popover', ''); popovers.add(nativeMenu);
      }
      if (toggle && !parent.hasAttribute('data-cc-context-panel-row')) {
        parent.setAttribute('data-cc-context-panel-row', ''); panelRows.add(parent);
      }
      // Keeping the submenu in the native popover also preserves its outside-click boundary.
      if (menu.parentElement !== parent) parent.appendChild(menu);
      if (typeof menu.showPopover === 'function') menu.setAttribute('popover', 'manual');
      placement = toggle ? 'native-model-effort-panel' : 'native-effort-row';
      const preview = toggle && desktopPickerBinding(groups, toggle, desktopNativePowerState);
      const presented = preview?.scope === active.scope ? preview.state : active.state;
      previewState = presented;
      const group = groups.find(candidate => candidate.id === presented.model);
      if (group && toggle) {
        const names = active.props.modelOptions.filter(option => option.model?.model === group.id ||
          Object.values(group.options).some(context => context.slug === option.model?.model))
          .map(option => option.model.displayName);
        cleanModelLabels(toggle, group, [...names, group.name]);
      }
      englishEfforts(nativeMenu, presented.effort);
    };
    const choose = async (tier, expected) => {
      if (operation) return;
      const active = current();
      if (!sameDesktopPickerOwner(active, expected) || !sameDesktopPickerOwner(active, owner)) {
        close(); return;
      }
      const power = nativeMenuFor(active)?.querySelector('[data-model-picker-view-toggle]');
      const powerBinding = power && desktopPickerBinding(groups, power, desktopNativePowerState);
      if (powerBinding?.scope === active.scope && (powerBinding.state.model !== active.state.model ||
        powerBinding.state.effort !== active.state.effort)) {
        close(); return;
      }
      const selection = desktopPickerSelection(groups, active.props, 'context', tier);
      if (!selection) { error = 'This Context is unavailable.'; renderMenu(active); return; }
      if (selection.slug === active.state.slug) { close(); button.focus(); return; }
      const pending = { owner: active, timer: null, deadline: Date.now() + 8000 };
      operation = pending;
      const fail = (message) => {
        if (operation !== pending) return;
        const latest = current();
        if (!sameDesktopPickerOwner(latest, pending.owner)) { close(); return; }
        clearTimeout(pending.timer); operation = null; error = message; renderMenu(latest);
      };
      const confirm = () => {
        if (operation !== pending) return;
        const latest = current();
        if (!sameDesktopPickerOwner(latest, pending.owner)) { close(); return; }
        if (latest.state.slug === selection.slug && latest.state.effort === selection.effort) {
          const focused = menu.contains(document.activeElement);
          close(); refresh();
          if (focused && button.isConnected) button.focus({ preventScroll: true });
        } else if (Date.now() >= pending.deadline) {
          fail('Context was not confirmed. Check the current selection before retrying.');
        } else pending.timer = setTimeout(confirm, 100);
      };
      pending.timer = setTimeout(() => fail(
        'Context was not confirmed. Check the current selection before retrying.'), 8000);
      renderMenu(active);
      try {
        const allowed = await active.props.onBeforeSelectModel?.(selection.slug);
        if (operation !== pending) return;
        if (!sameDesktopPickerOwner(current(), pending.owner)) { close(); return; }
        if (allowed === false) { fail('The app did not allow this Context.'); return; }
        const latest = current();
        if (latest?.state.model !== active.state.model) { close(); return; }
        const applied = desktopPickerSelection(groups, latest.props, 'context', tier);
        if (!applied) { fail('The current model no longer supports this Context.'); return; }
        // A native slider change while permission handling was pending is newer
        // than the menu observation. Preserve it instead of restoring old effort.
        selection.effort = applied.effort;
        const accepted = await latest.props.onSelectModel(selection.slug, selection.effort);
        if (operation !== pending) return;
        if (accepted === false) { fail('The app did not apply this Context.'); return; }
        if (!sameDesktopPickerOwner(current(), pending.owner)) { close(); return; }
        clearTimeout(pending.timer);
        latest.props.onSelectModelOption?.();
        confirm();
      } catch (cause) { fail(cause?.message || 'Context could not be updated.'); }
    };
    const restoreAliases = () => {
      for (const row of marked) row.removeAttribute('data-cc-context-model-alias-hidden');
      marked.clear();
    };
    const deduplicateNativeMenu = (active) => {
      restoreAliases();
      const nativeMenu = nativeMenuFor(active);
      if (!nativeMenu || nativeMenu === menu) return;
      const available = new Map(active.props.modelOptions.map(option => [option.model?.model, option]));
      for (const group of groups) {
        const preferred = [group.options[active.state.tier], group.options.default, group.options.long_context]
          .find(option => option && available.has(option.slug) && available.get(option.slug)?.disabledReason == null);
        if (!preferred) continue;
        for (const option of Object.values(group.options)) {
          const name = available.get(option.slug)?.model?.displayName;
          if (typeof name !== 'string') continue;
          const distinctName = Object.values(group.options).filter(context =>
            available.get(context.slug)?.model?.displayName === name).length === 1;
          const rows = nativeMenu.querySelectorAll('[role="menuitem"], [role="menuitemradio"], [role="option"]');
          for (const row of rows) {
            const rowBinding = desktopPickerBinding(groups, row, desktopNativeModelRowState);
            const exactKey = rowBinding?.scope === active.scope && rowBinding.state.slug === option.slug;
            const leaves = Array.from(row.querySelectorAll('span, div'))
              .filter(element => !element.children.length);
            if (exactKey || (distinctName && (row.getAttribute('aria-label') === name ||
              leaves.some(element => nativeText(element) === name)))) {
              if (option.slug !== preferred.slug) {
                row.setAttribute('data-cc-context-model-alias-hidden', ''); marked.add(row);
              }
              cleanModelLabels(row, group, [name, group.name]);
            }
          }
        }
      }
    };
    const refresh = () => {
      if (disposed) return;
      const active = current();
      if (!active) { close(); button.remove(); placement = null; restoreAliases(); restoreText(); return; }
      if (!menu.hidden && !sameDesktopPickerOwner(active, owner)) close();
      updateTriggerSummary(active);
      attachInsidePanel(active, nativeMenuFor(active));
      if (!menu.hidden && previewState && (previewState.model !== active.state.model ||
        previewState.effort !== active.state.effort)) close();
      const previewGroup = previewState && groups.find(group => group.id === previewState.model);
      const window = previewGroup && (previewGroup.options[active.state.tier] ||
        previewGroup.options.default || previewGroup.options.long_context)?.window;
      const displayedWindow = window ? formatDesktopWindow(window) : active.state.window;
      const summary = 'Context ' + displayedWindow + ' ⌄';
      if (button.textContent !== summary) button.textContent = summary;
      button.setAttribute('aria-label', 'Context window ' + displayedWindow);
      button.disabled = Boolean(active.props.modelOptionsDisabled ||
        active.props.daybreak?.disabled || active.props.daybreak?.isSaving ||
        active.state.contexts.length < 2 || operation ||
        (previewState && (previewState.model !== active.state.model ||
          previewState.effort !== active.state.effort)));
      if (!menu.hidden) renderMenu(active);
      deduplicateNativeMenu(active);
    };
    const queue = () => {
      if (disposed || scheduled) return;
      scheduled = true;
      requestAnimationFrame(() => { scheduled = false; refresh(); });
    };
    listen(button, 'click', () => {
      const active = current();
      if (!active || button.disabled) return;
      if (!menu.hidden) { close(); return; }
      owner = active; menu.hidden = false;
      if (typeof menu.showPopover === 'function') menu.showPopover();
      button.setAttribute('aria-expanded', 'true');
      renderMenu(active); menu.querySelector('button:not(:disabled)')?.focus();
    });
    listen(document, 'click', event => {
      const path = event.composedPath?.() || [];
      // Selection refresh may replace the clicked menu item before bubbling.
      // The original event path, not the now-detached target, owns that click.
      if (!menu.hidden && !path.includes(menu) && !path.includes(button) &&
        !menu.contains(event.target) && !button.contains(event.target)) close();
    });
    listen(menu, 'keydown', event => {
      if (event.key === 'Escape') { event.preventDefault(); close(); button.focus(); }
    });
    const observer = new MutationObserver(records => {
      if (records.some(record => {
        const target = record.target.nodeType === 3 ? record.target.parentElement : record.target;
        return target !== menu && target !== button && !menu.contains(target) && !button.contains(target) &&
          target !== style && !(textEdits.has(target) && target.textContent === textEdits.get(target).rendered);
      })) queue();
    });
    observer.observe(document.documentElement, { subtree: true, childList: true, characterData: true,
      attributes: true, attributeFilter: ['aria-controls', 'aria-expanded', 'disabled', 'aria-disabled',
        'aria-valuenow', 'data-selected-reasoning-effort', 'data-model-picker-view'] });
    globalThis.__codexCopilotModelControlsV1 = {
      revision: 6, mode: 'native-context-only', refresh,
      setGroups: (nextGroups) => {
        if (Array.isArray(nextGroups) && nextGroups.length) {
          groups = nextGroups;
          refresh();
        }
      },
      getGroups: () => groups.map(group => group.id),
      inspect: () => {
        const active = current();
        return { revision: 6, mode: 'native-context-only', bound: Boolean(active),
          placement, contextControlAttached: button.isConnected,
          nativeTriggerPreserved: Boolean(active && !active.trigger.hasAttribute('data-codex-copilot-native-model')),
          model: active?.state.model || null, effort: active?.state.effort || null,
          context: active?.state.tier || null };
      },
      dispose: () => {
        if (disposed) return;
        disposed = true; close(); observer.disconnect(); restoreAliases(); restoreText();
        for (const row of panelRows) row.removeAttribute('data-cc-context-panel-row');
        panelRows.clear();
        for (const popover of popovers) popover.removeAttribute('data-cc-context-popover');
        popovers.clear();
        for (const [target, name, callback, options] of listeners) target.removeEventListener(name, callback, options);
        button.remove(); menu.remove(); style.remove();
        if (globalThis.__codexCopilotModelControlsV1?.revision === 6) delete globalThis.__codexCopilotModelControlsV1;
      },
    };
    refresh(); return 'active';
  })()`;
}

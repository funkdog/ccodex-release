import { buildDesktopNativeContextPatch } from "./desktop-native-context.mjs";

/**
 * The Desktop app needs distinct model slugs for real Context windows, but
 * those implementation details must not become duplicate user-facing models.
 * This module groups the catalog and drives the app's own model-change callback.
 * It never sends a second app-server request. Unsupported renderer state leaves
 * the native picker alone.
 */
export function desktopModelGroups(catalog) {
  const entries = catalog?.models || [];
  const names = new Map();
  for (const entry of entries) {
    const base = entry.copilot?.base_model;
    if (base && entry.slug === base) {
      names.set(base, String(entry.display_name || base).replace(/\u200B/g, ""));
    }
  }

  const groups = new Map();
  for (const entry of entries) {
    if (entry.visibility !== "list") continue;
    const base = entry.copilot?.base_model;
    if (!base) continue;
    if (entry.copilot?.context_tier !== undefined &&
      !["default", "long_context"].includes(entry.copilot.context_tier)) continue;
    const tier = entry.copilot?.context_tier === "long_context"
      ? "long_context" : "default";
    const fallbackName = String(entry.display_name || base)
      .replace(/\u200B/g, "")
      .replace(/ · (?:Standard|Long) \([^)]*\)$/, "");
    if (!groups.has(base)) {
      groups.set(base, { id: base, name: names.get(base) || fallbackName, options: {} });
    }
    const tokens = tier === "long_context"
      ? entry.copilot?.long_context_window_tokens
      : entry.copilot?.default_context_window_tokens;
    const window = Number.isSafeInteger(tokens) && tokens > 0 ? tokens : entry.context_window;
    if (!Number.isSafeInteger(window) || window <= 0) continue;
    groups.get(base).options[tier] = {
      slug: entry.slug,
      window,
    };
  }
  return [...groups.values()].filter(group => Object.keys(group.options).length);
}

export function formatDesktopEffort(effort) {
  return ({
    none: "None", minimal: "Minimal", low: "Low", medium: "Medium",
    high: "High", xhigh: "Extra high", max: "Max", ultra: "Ultra",
  })[effort] || (typeof effort === "string" && /^[a-z][a-z0-9_-]{0,31}$/.test(effort)
    ? effort : null);
}

export function desktopNativePowerState(groups, props) {
  const selection = props?.selectedPowerSelection;
  const group = groups.find(candidate => candidate.id === selection?.model
    || Object.values(candidate.options).some(option => option.slug === selection?.model));
  if (!group || !formatDesktopEffort(selection.reasoningEffort)) return null;
  return { model: group.id, modelName: group.name, effort: selection.reasoningEffort };
}

export function desktopNativeModelRowState(groups, _props, fiber) {
  const key = fiber?.key;
  return typeof key === "string" && groups.some(group =>
    Object.values(group.options).some(option => option.slug === key)) ? { slug: key } : null;
}

export function formatDesktopWindow(tokens) {
  if (!Number.isFinite(tokens) || tokens <= 0) return "—";
  if (tokens >= 1_000_000) {
    const millions = tokens / 1_000_000;
    return `${Number.isInteger(millions) ? millions.toFixed(0) : millions.toFixed(1)}M`;
  }
  return `${Math.round(tokens / 1000).toLocaleString("en-US")}K`;
}

export function desktopPickerState(groups, props) {
  if (!props || typeof props.model !== "string" ||
      !Array.isArray(props.modelOptions) || typeof props.onSelectModel !== "function") {
    return null;
  }
  const available = new Map(props.modelOptions
    .filter(option => typeof option?.model?.model === "string")
    .map(option => [option.model.model, option]));
  const current = groups.find(group => group.id === props.model ||
    Object.values(group.options).some(option => option.slug === props.model));
  if (!current) return null;
  const tier = current.options.long_context?.slug === props.model
    ? "long_context" : "default";
  const contexts = Object.entries(current.options)
    .filter(([, option]) => available.has(option.slug))
    .map(([key, option]) => ({
      id: key,
      label: formatDesktopWindow(option.window),
      disabled: available.get(option.slug)?.disabledReason != null,
      selected: key === tier,
    }));
  const model = (props.models || []).find(entry => entry.model === props.model) ||
    available.get(props.model)?.model;
  const efforts = (model?.supportedReasoningEfforts || [])
    .map(level => level.reasoningEffort)
    .filter((effort, index, all) => typeof effort === "string" &&
      /^[a-z][a-z0-9_-]{0,31}$/.test(effort) &&
      all.indexOf(effort) === index);
  const models = groups.flatMap(group => {
    const options = Object.values(group.options).map(option => available.get(option.slug))
      .filter(Boolean);
    if (!options.length) return [];
    return [{
      id: group.id,
      label: group.name,
      disabled: options.every(option => option.disabledReason != null),
      selected: group.id === current.id,
    }];
  });
  return {
    model: current.id,
    modelName: current.name,
    slug: props.model,
    tier,
    window: formatDesktopWindow(
      (current.options[tier] || current.options.default || current.options.long_context)?.window,
    ),
    effort: efforts.length ? props.reasoningEffort || null : null,
    efforts,
    contexts,
    models,
  };
}

export function desktopPickerSelection(groups, props, kind, value) {
  const state = desktopPickerState(groups, props);
  if (!state || props.disabled || props.daybreak?.disabled || props.daybreak?.isSaving ||
      (kind !== "effort" && props.modelOptionsDisabled) ||
      (kind === "effort" && props.reasoningEffortDisabled)) return null;
  const available = new Map(props.modelOptions
    .filter(option => typeof option?.model?.model === "string" &&
      option.disabledReason == null)
    .map(option => [option.model.model, option.model]));
  let slug = state.slug;
  let effort = state.effort;
  if (kind === "model") {
    const group = groups.find(item => item.id === value);
    if (!group) return null;
    slug = [group.options[state.tier], group.options.default, group.options.long_context]
      .find(option => option && available.has(option.slug))?.slug;
    if (!slug) return null;
  } else if (kind === "context") {
    const group = groups.find(item => item.id === state.model);
    slug = group?.options[value]?.slug;
    if (!slug || !available.has(slug)) return null;
  } else if (kind === "effort") {
    if (!state.efforts.includes(value)) return null;
    effort = value;
  } else {
    return null;
  }
  const target = available.get(slug);
  if (!target) return null;
  const supported = (target.supportedReasoningEfforts || [])
    .map(level => level.reasoningEffort)
    .filter(effort => typeof effort === "string" && /^[a-z][a-z0-9_-]{0,31}$/.test(effort));
  if (!supported.includes(effort)) {
    effort = supported.includes(target.defaultReasoningEffort)
      ? target.defaultReasoningEffort
      : supported.includes("medium") ? "medium" : supported[0] || null;
  }
  return { slug, effort };
}

/** Resolve the committed path, not the stale Fiber retained on a DOM element. */
export function desktopPickerBinding(groups, trigger, stateReader = desktopPickerState) {
  if (!trigger || trigger.isConnected === false) return null;
  const key = Object.keys(trigger).find(name => name.startsWith("__reactFiber$"));
  const attached = key && trigger[key];
  if (!attached) return null;
  // The real Desktop can have hundreds of nested layout, menu and provider
  // Fibers on each buffer. Queue each ancestor once; a 512-node limit rejected
  // ordinary committed trees before ever reaching HostRoot.
  const maximumAncestors = 4096;
  const lineage = new Set([attached]);
  const roots = new Set();
  const queue = [attached];
  for (let cursor = 0; cursor < queue.length; cursor++) {
    const fiber = queue[cursor];
    if (fiber.tag === 3 && fiber.stateNode?.current) roots.add(fiber.stateNode.current);
    for (const ancestor of [fiber.return, fiber.alternate]) {
      if (!ancestor || lineage.has(ancestor)) continue;
      if (lineage.size >= maximumAncestors) return null;
      lineage.add(ancestor);
      queue.push(ancestor);
    }
  }
  if (roots.size !== 1) return null;
  const root = [...roots][0];
  const work = [{ fiber: root, binding: null, scope: null }];
  const visited = new Set();
  let inspected = 0;
  while (work.length && inspected < 4096) {
    const { fiber, binding, scope } = work.pop();
    if (!fiber || visited.has(fiber)) continue;
    visited.add(fiber);
    inspected++;
    const props = fiber.memoizedProps;
    const state = stateReader(groups, props, fiber);
    let owner = scope;
    if (props && (Object.hasOwn(props, "conversationId") || Object.hasOwn(props, "threadId"))) {
      const identity = [
        props.conversationId ?? props.threadId ?? null,
        props.hostId ?? props.permissionsHostId ?? null,
        props.cwd ?? props.permissionsCwdOverride ?? null,
      ];
      if (identity.some(value => value !== null && typeof value !== "string")) return null;
      owner = identity.some(value => value !== null) ? JSON.stringify(identity) : null;
    }
    const next = state ? { fiber, props, state, scope: owner } : binding;
    if (fiber.stateNode === trigger) {
      return next ? { ...next, trigger, scope: owner } : null;
    }
    // React may share a bailed-out child whose return pointer still points to
    // the other parent. Actual committed child/sibling links are authoritative.
    const siblings = new Set();
    for (let child = fiber.child; child; child = child.sibling) {
      if (siblings.has(child) || ++inspected >= 4096) return null;
      siblings.add(child);
      if (lineage.has(child)) work.push({ fiber: child, binding: next, scope: owner });
    }
  }
  return null;
}

export function sameDesktopPickerOwner(left, right) {
  return Boolean(left && right && left.trigger === right.trigger &&
    (left.fiber === right.fiber || left.fiber.alternate === right.fiber) &&
    left.scope === right.scope &&
    (left.scope !== null || left.props.onSelectModel === right.props.onSelectModel));
}

export function buildDesktopModelControlsPatch(groups) {
  return buildDesktopNativeContextPatch(groups, [
    formatDesktopWindow.toString(), formatDesktopEffort.toString(),
    desktopNativePowerState.toString(), desktopPickerState.toString(),
    desktopNativeModelRowState.toString(),
    desktopPickerSelection.toString(), desktopPickerBinding.toString(),
    sameDesktopPickerOwner.toString(),
  ]);
}

// Retained solely for old renderer-fixture regressions during the migration.
// Production installs only the Context extension above, never this substitute UI.
export function buildLegacyDesktopModelControlsPatch(groups) {
  // Keep the pure selection functions identical in the renderer and tests.
  return `(() => {
    const groups = ${JSON.stringify(groups)};
    if (!groups.length || !document.documentElement) return 'unavailable';
    const installed = globalThis.__codexCopilotModelControlsV1;
    if (installed?.revision === 3) { installed.refresh(); return 'active'; }
    if (installed) {
      // Old patches did not retain their listeners/observer for disposal.
      // Layering another picker over them would create competing callbacks.
      if (typeof installed.dispose !== 'function') return 'reload-required';
      installed.dispose();
    }
    ${formatDesktopWindow.toString()}
    ${desktopPickerState.toString()}
    ${desktopPickerSelection.toString()}
    ${desktopPickerBinding.toString()}
    ${sameDesktopPickerOwner.toString()}

    const root = document.createElement('div');
    root.id = 'codex-copilot-model-menu';
    root.setAttribute('role', 'menu');
    root.setAttribute('aria-label', 'Model settings');
    root.setAttribute('tabindex', '-1');
    root.hidden = true;
    const toolbar = document.createElement('span');
    toolbar.id = 'codex-copilot-model-toolbar';
    toolbar.setAttribute('role', 'group');
    toolbar.setAttribute('aria-label', 'Model settings');
    const settingButtons = new Map();
    const settingTitles = { model: 'Model', effort: 'Effort', context: 'Context window' };
    for (const kind of ['model', 'effort', 'context']) {
      const button = document.createElement('button');
      button.type = 'button';
      button.className = 'cc-model-setting no-drag';
      button.setAttribute('data-cc-model-setting', kind);
      button.setAttribute('aria-haspopup', 'menu');
      button.setAttribute('aria-controls', root.id);
      button.setAttribute('aria-expanded', 'false');
      if (kind !== 'model') {
        const label = document.createElement('span');
        label.className = 'cc-model-setting-label';
        label.textContent = kind === 'context' ? 'Context' : 'Effort';
        button.appendChild(label);
      }
      const value = document.createElement('span');
      value.className = 'cc-model-setting-value';
      value.setAttribute('data-cc-setting-value', '');
      const arrow = document.createElement('span');
      arrow.className = 'cc-model-setting-arrow';
      arrow.setAttribute('aria-hidden', 'true');
      arrow.textContent = '⌄';
      button.append(value, arrow);
      toolbar.appendChild(button);
      settingButtons.set(kind, { button, value });
    }
    const style = document.createElement('style');
    style.id = 'codex-copilot-model-menu-style';
    style.textContent = \`
      [data-codex-copilot-native-model] { display: none !important; }
      #codex-copilot-model-toolbar {
        display: inline-flex; align-items: center; gap: 2px; flex-wrap: wrap;
        max-width: 100%; vertical-align: middle;
        font: 12px/18px system-ui, sans-serif;
      }
      #codex-copilot-model-toolbar .cc-model-setting {
        appearance: none; display: inline-flex; align-items: center; gap: 5px;
        min-width: 0; min-height: 28px; padding: 2px 6px;
        border: 1px solid transparent; border-radius: 7px;
        background: transparent; color: var(--text-primary, #f2f2f2);
        cursor: pointer; font: inherit; white-space: nowrap;
      }
      #codex-copilot-model-toolbar .cc-model-setting:hover,
      #codex-copilot-model-toolbar .cc-model-setting[aria-expanded="true"] {
        background: var(--main-surface-secondary, rgba(128,128,128,.16));
      }
      #codex-copilot-model-toolbar .cc-model-setting:focus-visible {
        outline: 2px solid var(--ring, #6f8eff); outline-offset: 1px;
      }
      #codex-copilot-model-toolbar .cc-model-setting:disabled {
        opacity: .45; cursor: default;
      }
      #codex-copilot-model-toolbar .cc-model-setting:disabled:hover { background: transparent; }
      #codex-copilot-model-toolbar .cc-model-setting-value {
        overflow: hidden; text-overflow: ellipsis; max-width: min(28vw, 180px);
      }
      #codex-copilot-model-toolbar .cc-model-setting-label,
      #codex-copilot-model-toolbar .cc-model-setting-arrow {
        color: var(--text-tertiary, #888);
      }
      @media (max-width: 640px) {
        #codex-copilot-model-toolbar .cc-model-setting-label { display: none; }
      }
      #codex-copilot-model-menu {
        position: fixed; z-index: 2147483645; box-sizing: border-box;
        padding: 7px; border-radius: 14px;
        background: var(--main-surface-primary, #242424);
        color: var(--text-primary, #f2f2f2);
        border: 1px solid var(--border-light, rgba(128,128,128,.25));
        box-shadow: 0 16px 48px rgba(0,0,0,.28);
        font: 14px/1.35 system-ui, sans-serif;
      }
      #codex-copilot-model-menu[hidden] { display: none !important; }
      #codex-copilot-model-menu .cc-model-row {
        appearance: none; border: 0; background: transparent; color: inherit;
        width: 100%; min-height: 38px; padding: 8px 10px;
        border-radius: 8px; display: flex; align-items: center;
        gap: 12px; text-align: left; cursor: pointer; font: inherit;
      }
      #codex-copilot-model-menu .cc-model-row:hover,
      #codex-copilot-model-menu .cc-model-row:focus-visible {
        background: var(--main-surface-secondary, rgba(128,128,128,.16));
        outline: none;
      }
      #codex-copilot-model-menu .cc-model-row:disabled {
        opacity: .45; cursor: default;
      }
      #codex-copilot-model-menu .cc-model-row:disabled:hover { background: transparent; }
      #codex-copilot-model-menu .cc-model-name {
        min-width: 0; flex: 1; overflow: hidden; text-overflow: ellipsis;
        white-space: nowrap;
      }
      #codex-copilot-model-menu .cc-model-value {
        color: var(--text-secondary, #aaa); max-width: 58%;
        overflow: hidden; text-overflow: ellipsis; white-space: nowrap;
      }
      #codex-copilot-model-menu .cc-model-arrow { color: var(--text-tertiary, #888); }
      #codex-copilot-model-menu .cc-model-options {
        max-height: min(55vh, 440px); overflow-y: auto; overscroll-behavior: contain;
      }
      #codex-copilot-model-menu .cc-model-divider {
        height: 1px; margin: 5px 6px;
        background: var(--border-light, rgba(128,128,128,.2));
      }
      #codex-copilot-model-menu .cc-model-error {
        padding: 8px 10px; color: var(--text-danger, #e66);
      }
      #codex-copilot-model-menu .cc-model-heading {
        padding: 5px 10px; color: var(--text-secondary, #aaa); font-size: 12px;
      }
    \`;
    document.head.appendChild(style);
    document.body.appendChild(root);
    let view = 'main';
    let error = '';
    let lastKey = '';
    let lastTrigger = null;
    let lastAnchor = null;
    let directMenu = false;
    let menuOwner = null;
    let operation = null;
    let disposed = false;
    const listeners = [];
    const listen = (target, type, listener, options) => {
      target.addEventListener(type, listener, options);
      listeners.push([target, type, listener, options]);
    };
    const originalAttributes = new WeakMap();
    let refreshQueued = false;
    let submitting = false;
    const effortLabel = (effort) => ({
      none: 'None', minimal: 'Minimal', low: 'Low', medium: 'Medium',
      high: 'High', xhigh: 'X-High', max: 'Max', ultra: 'Ultra',
    })[effort] || effort || 'Default';
    const current = (preferred) => {
      const trigger = preferred || document.querySelector('[data-codex-intelligence-trigger]');
      if (!trigger || trigger.disabled || trigger.getAttribute('aria-disabled') === 'true') return null;
      const binding = desktopPickerBinding(groups, trigger);
      return binding?.props.disabled ? null : binding;
    };
    const position = (trigger) => {
      const rect = trigger.getBoundingClientRect();
      const width = Math.max(0, Math.min(380, innerWidth - 16));
      root.style.width = width + 'px';
      root.style.left = Math.max(8, Math.min(rect.left, innerWidth - width - 8)) + 'px';
      const height = root.getBoundingClientRect().height;
      const below = innerHeight - rect.bottom;
      root.style.top = (below >= height + 12 || below >= rect.top
        ? Math.min(innerHeight - height - 8, rect.bottom + 6)
        : Math.max(8, rect.top - height - 6)) + 'px';
    };
    const close = () => {
      if (operation?.timer) clearTimeout(operation.timer);
      operation = null;
      menuOwner = null;
      submitting = false;
      root.hidden = true;
      view = 'main';
      error = '';
      lastKey = '';
      lastTrigger?.setAttribute('aria-expanded', 'false');
      for (const { button } of settingButtons.values()) button.setAttribute('aria-expanded', 'false');
    };
    const restoreTrigger = (trigger) => {
      if (!trigger) return;
      trigger.removeAttribute('data-codex-copilot-model-summary');
      trigger.removeAttribute('data-codex-copilot-native-model');
      const attributes = originalAttributes.get(trigger);
      if (!attributes) return;
      for (const [name, value] of Object.entries(attributes)) {
        if (value === null) trigger.removeAttribute(name);
        else trigger.setAttribute(name, value);
      }
    };
    const syncToolbar = ({ trigger, props, state }) => {
      const parent = trigger.parentElement;
      if (!parent) return;
      if (toolbar.parentElement !== parent || trigger.nextSibling !== toolbar) {
        parent.insertBefore(toolbar, trigger.nextSibling);
      }
      const values = { model: state.modelName, effort: effortLabel(state.effort), context: state.window };
      for (const [kind, { button, value }] of settingButtons) {
        if (value.textContent !== values[kind]) value.textContent = values[kind];
        const label = settingTitles[kind] + ' ' + values[kind];
        if (button.getAttribute('aria-label') !== label) button.setAttribute('aria-label', label);
        if (button.getAttribute('title') !== label) button.setAttribute('title', label);
        button.disabled = Boolean(submitting || props.daybreak?.disabled || props.daybreak?.isSaving ||
          (kind === 'effort' ? props.reasoningEffortDisabled || !state.efforts.length
            : props.modelOptionsDisabled || (kind === 'context' && state.contexts.length < 2)));
      }
    };
    const row = (label, value, { id, disabled = false, checked, action } = {}) => {
      const button = document.createElement('button');
      button.type = 'button';
      button.className = 'cc-model-row';
      button.setAttribute('role', checked === undefined ? 'menuitem' : 'menuitemradio');
      if (id) button.dataset.ccControl = id;
      if (checked !== undefined) button.setAttribute('aria-checked', String(checked));
      button.disabled = disabled || submitting;
      const left = document.createElement('span');
      left.className = 'cc-model-name';
      left.textContent = label;
      const right = document.createElement('span');
      right.className = 'cc-model-value';
      right.textContent = value || '';
      button.append(left, right);
      if (checked === undefined && value && !disabled) {
        const arrow = document.createElement('span');
        arrow.className = 'cc-model-arrow';
        arrow.setAttribute('aria-hidden', 'true');
        arrow.textContent = '›';
        button.appendChild(arrow);
      }
      if (action) button.addEventListener('click', action);
      return button;
    };
    const choose = async (kind, value, expectedOwner) => {
      if (submitting) return;
      const active = current(expectedOwner?.trigger);
      if (!sameDesktopPickerOwner(active, expectedOwner) ||
          !sameDesktopPickerOwner(active, menuOwner)) { close(); return; }
      const selection = active && desktopPickerSelection(groups, active.props, kind, value);
      if (!selection) { error = 'This selection is unavailable'; render(true); return; }
      if (selection.slug === active.state.slug &&
          selection.effort === active.state.effort) {
        const anchor = lastAnchor;
        close();
        if (anchor?.isConnected) anchor.focus({ preventScroll: true });
        return;
      }
      const update = { owner: active, selection, timer: null, deadline: Date.now() + 8000 };
      operation = update;
      const fail = (message) => {
        if (operation !== update) return;
        if (!sameDesktopPickerOwner(current(active.trigger), update.owner)) { close(); return; }
        clearTimeout(update.timer);
        operation = null;
        submitting = false;
        error = message;
        render(true);
      };
      const confirm = () => {
        if (operation !== update) return;
        const latest = current(active.trigger);
        if (!sameDesktopPickerOwner(latest, update.owner)) { close(); return; }
        if (latest.state.slug === selection.slug &&
            (selection.effort === null || latest.state.effort === selection.effort)) {
          const shouldFocus = root.contains(document.activeElement);
          const anchor = lastAnchor;
          close();
          render();
          if (shouldFocus && anchor?.isConnected) anchor.focus({ preventScroll: true });
          refresh();
        } else if (Date.now() >= update.deadline) {
          fail('Selection was not confirmed. Check the current value before retrying.');
        } else {
          update.timer = setTimeout(confirm, 100);
        }
      };
      try {
        submitting = true;
        error = '';
        render(true);
        const allowed = await active.props.onBeforeSelectModel?.(selection.slug);
        if (operation !== update) return;
        if (!sameDesktopPickerOwner(current(active.trigger), update.owner)) { close(); return; }
        if (allowed === false) {
          fail('The app did not allow this selection.');
          return;
        }
        update.timer = setTimeout(() => fail(
          'Selection was not confirmed. Check the current value before retrying.'),
        8000);
        const accepted = await active.props.onSelectModel(selection.slug, selection.effort);
        if (operation !== update) return;
        clearTimeout(update.timer);
        update.timer = null;
        if (accepted === false) fail('The app did not apply this selection.');
        else {
          if (!sameDesktopPickerOwner(current(active.trigger), update.owner)) { close(); return; }
          if (selection.slug !== active.state.slug) active.props.onSelectModelOption?.();
          confirm();
        }
      } catch (cause) {
        fail(cause?.message || 'Model settings could not be updated');
      }
    };
    const render = (force = false) => {
      const active = current();
      if (!active) {
        if (!root.hidden) close();
        restoreTrigger(lastTrigger);
        lastTrigger = null;
        lastAnchor = null;
        toolbar.parentNode?.removeChild(toolbar);
        return;
      }
      const { trigger, props, state } = active;
      if (!root.hidden && !sameDesktopPickerOwner(active, menuOwner)) close();
      if (lastTrigger !== trigger) {
        restoreTrigger(lastTrigger);
        if (!originalAttributes.has(trigger)) originalAttributes.set(trigger, {
          'aria-label': trigger.getAttribute('aria-label'),
          'aria-expanded': trigger.getAttribute('aria-expanded'),
        });
      }
      lastTrigger = trigger;
      const summary = state.modelName;
      if (trigger.getAttribute('data-codex-copilot-model-summary') !== summary) {
        trigger.setAttribute('data-codex-copilot-model-summary', summary);
      }
      if (trigger.getAttribute('data-codex-copilot-native-model') === null) {
        trigger.setAttribute('data-codex-copilot-native-model', 'true');
      }
      const aria = 'Model ' + state.modelName;
      if (trigger.getAttribute('aria-label') !== aria) trigger.setAttribute('aria-label', aria);
      syncToolbar(active);
      if (root.hidden) return;
      const key = JSON.stringify([view, state, props.modelOptionsDisabled,
        props.reasoningEffortDisabled, props.daybreak?.disabled,
        props.daybreak?.isSaving, error, submitting]);
      const anchor = lastAnchor?.isConnected ? lastAnchor : settingButtons.get('model').button;
      if (!force && key === lastKey) { position(anchor); return; }
      lastKey = key;
      const hadMenuFocus = root.contains(document.activeElement);
      root.replaceChildren();
      if (view === 'main') {
        root.append(
          row('Model', state.modelName, {
            id: 'model', disabled: props.modelOptionsDisabled ||
              props.daybreak?.disabled || props.daybreak?.isSaving,
            action: () => { view = 'model'; render(true); root.querySelector('button:not(:disabled)')?.focus(); },
          }),
          row('Effort', effortLabel(state.effort), {
            id: 'effort', disabled: props.reasoningEffortDisabled ||
              props.daybreak?.disabled || props.daybreak?.isSaving || !state.efforts.length,
            action: () => { view = 'effort'; render(true); root.querySelector('button:not(:disabled)')?.focus(); },
          }),
          row('Context window', state.window, {
            id: 'context', disabled: props.modelOptionsDisabled ||
              props.daybreak?.disabled || props.daybreak?.isSaving || state.contexts.length < 2,
            action: () => { view = 'context'; render(true); root.querySelector('button:not(:disabled)')?.focus(); },
          }),
        );
      } else {
        if (directMenu) {
          const heading = document.createElement('div');
          heading.className = 'cc-model-heading';
          heading.textContent = settingTitles[view];
          root.appendChild(heading);
        } else {
          root.appendChild(row('‹  ' + settingTitles[view], '', {
            id: 'back', action: () => { view = 'main'; render(true); root.querySelector('button:not(:disabled)')?.focus(); },
          }));
        }
        const divider = document.createElement('div');
        divider.className = 'cc-model-divider';
        root.appendChild(divider);
        const options = document.createElement('div');
        options.className = 'cc-model-options';
        const choices = view === 'model' ? state.models
          : view === 'context' ? state.contexts
          : state.efforts.map(effort => ({
            id: effort, label: effortLabel(effort), selected: effort === state.effort,
          }));
        for (const choice of choices) {
          const button = row(choice.label, choice.selected ? '✓' : '', {
            id: choice.id, checked: choice.selected,
            disabled: choice.disabled || props.daybreak?.disabled ||
              props.daybreak?.isSaving || (view === 'effort'
              ? props.reasoningEffortDisabled : props.modelOptionsDisabled),
            action: () => choose(view, choice.id, active),
          });
          options.appendChild(button);
        }
        root.appendChild(options);
      }
      if (error) {
        const message = document.createElement('div');
        message.className = 'cc-model-error';
        message.setAttribute('role', 'alert');
        message.textContent = error;
        root.appendChild(message);
      }
      position(anchor);
      // Replacing a focused option resets focus to body; that is not user navigation.
      if (hadMenuFocus && document.activeElement === document.body) {
        root.focus({ preventScroll: true });
      }
    };
    const refresh = () => {
      if (disposed || refreshQueued) return;
      refreshQueued = true;
      requestAnimationFrame(() => {
        refreshQueued = false;
        if (!disposed) render();
      });
    };
    const open = (kind = 'main', anchor = null) => {
      const active = current();
      if (!active) return;
      if (anchor?.disabled) return;
      if (!root.hidden && view === kind && lastAnchor === (anchor || active.trigger)) {
        close(); return;
      }
      if (!root.hidden) close();
      menuOwner = active;
      view = kind;
      directMenu = kind !== 'main';
      lastAnchor = anchor || active.trigger;
      root.hidden = false;
      lastKey = '';
      render(true);
      lastTrigger?.setAttribute('aria-expanded', 'true');
      if (anchor) anchor.setAttribute('aria-expanded', 'true');
      root.setAttribute('aria-label', settingTitles[kind] || 'Model settings');
      root.querySelector('button:not(:disabled)')?.focus();
    };
    const isTrigger = (target) => {
      const trigger = target?.closest?.('[data-codex-intelligence-trigger]');
      return trigger && current()?.trigger === trigger;
    };
    const settingTrigger = (target) => {
      const button = target?.closest?.('[data-cc-model-setting]');
      const kind = button?.getAttribute('data-cc-model-setting');
      return button && toolbar.isConnected && settingButtons.get(kind)?.button === button && current()
        ? { button, kind } : null;
    };
    listen(document, 'pointerdown', (event) => {
      if (isTrigger(event.target) || settingTrigger(event.target)) event.stopImmediatePropagation();
      else if (!root.hidden && !root.contains(event.target)) close();
    }, true);
    listen(document, 'click', (event) => {
      const setting = settingTrigger(event.target);
      if (!setting && !isTrigger(event.target)) return;
      event.preventDefault();
      event.stopImmediatePropagation();
      open(setting?.kind || 'main', setting?.button);
    }, true);
    listen(document, 'keydown', (event) => {
      const setting = settingTrigger(event.target);
      if ((isTrigger(event.target) || setting) &&
          ['Enter', ' ', 'ArrowDown'].includes(event.key)) {
        event.preventDefault();
        event.stopImmediatePropagation();
        open(setting?.kind || 'main', setting?.button);
        return;
      }
      if (root.hidden || !root.contains(event.target)) return;
      if (event.key === 'Escape') {
        event.preventDefault();
        event.stopPropagation();
        if (view === 'main' || directMenu) {
          const anchor = lastAnchor;
          close();
          if (anchor?.isConnected) anchor.focus({ preventScroll: true });
        }
        else { view = 'main'; render(true); root.querySelector('button:not(:disabled)')?.focus(); }
      } else if (['ArrowDown', 'ArrowUp', 'Home', 'End'].includes(event.key)) {
        const buttons = [...root.querySelectorAll('button:not(:disabled)')];
        if (!buttons.length) return;
        const index = buttons.indexOf(document.activeElement);
        const next = event.key === 'Home' ? 0 : event.key === 'End' ? buttons.length - 1
          : (index + (event.key === 'ArrowUp' ? -1 : 1) + buttons.length) % buttons.length;
        event.preventDefault();
        buttons[next].focus();
      }
    }, true);
    listen(document, 'focusin', (event) => {
      if (!root.hidden && !root.contains(event.target) &&
          !isTrigger(event.target) && !settingTrigger(event.target)) close();
    }, true);
    listen(globalThis, 'resize', refresh);
    listen(globalThis, 'scroll', refresh, true);
    const observer = new MutationObserver(refresh);
    observer.observe(document.documentElement, {
      subtree: true, childList: true, characterData: true,
      attributes: true, attributeFilter: ['aria-label', 'data-selected-reasoning-effort', 'disabled', 'aria-disabled'],
    });
    const controls = {
      revision: 3,
      close,
      refresh,
      inspect() {
        const active = current();
        return {
          revision: 3, bound: Boolean(active), menuOpen: !root.hidden,
          view: root.hidden ? null : view,
          model: active?.state.modelName || null,
          effort: active?.state.effort || null,
          context: active?.state.window || null,
        };
      },
      dispose() {
        if (disposed) return;
        disposed = true;
        close();
        observer.disconnect();
        for (const args of listeners) {
          const [target, type, listener, options] = args;
          target.removeEventListener(type, listener, options);
        }
        restoreTrigger(lastTrigger);
        lastTrigger = null;
        lastAnchor = null;
        toolbar.parentNode?.removeChild(toolbar);
        root.parentNode?.removeChild(root);
        style.parentNode?.removeChild(style);
        if (globalThis.__codexCopilotModelControlsV1 === controls) {
          delete globalThis.__codexCopilotModelControlsV1;
        }
      },
    };
    globalThis.__codexCopilotModelControlsV1 = controls;
    refresh();
    return 'active';
  })()`;
}

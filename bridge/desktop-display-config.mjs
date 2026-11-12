export function buildDesktopDisplayConfigPatch() {
  return `(() => {
    const S = globalThis.__STATSIG__;
    if (!S) return 'waiting';
    const seen = new Set(), clients = [];
    const add = c => {
      if (c && typeof c.getDynamicConfig === 'function' && !seen.has(c)) {
        seen.add(c); clients.push(c);
      }
    };
    add(typeof S.instance === 'function' ? S.instance() : S.instance);
    add(S.firstInstance);
    if (S.instances instanceof Map) for (const c of S.instances.values()) add(c);
    else if (S.instances && typeof S.instances === 'object')
      for (const c of Object.values(S.instances)) add(c);
    if (!clients.length) return 'waiting';
    let applied = 0, active = 0;
    for (const client of clients) {
      let owner = client;
      while (owner && !Object.hasOwn(owner, 'getDynamicConfig')) owner = Object.getPrototypeOf(owner);
      if (!owner) continue;
      if (Object.hasOwn(owner, '__ccodexDisplayConfigV1')) { active++; continue; }
      const descriptor = Object.getOwnPropertyDescriptor(owner, 'getDynamicConfig');
      if (typeof descriptor?.value !== 'function') continue;
      const original = descriptor.value;
      Object.defineProperty(owner, 'getDynamicConfig', {
        ...descriptor,
        value: function(name, ...rest) {
          const result = original.call(this, name, ...rest);
          if (!result || !result.value || typeof result.value !== 'object') return result;
          const fields = name === '107580212' ? { use_hidden_models: false }
            : name === '72216192' ? { enable_i18n: true, locale_source: 'SYSTEM' } : null;
          if (!fields || Object.entries(fields).every(([key, value]) => result.value[key] === value)) return result;
          const copy = Object.create(Object.getPrototypeOf(result), Object.getOwnPropertyDescriptors(result));
          copy.value = { ...result.value, ...fields };
          return copy;
        },
      });
      Object.defineProperty(owner, '__ccodexDisplayConfigV1', { value: true, configurable: true });
      applied++;
    }
    if (!applied) return active ? 'active' : 'waiting';
    for (const client of clients) {
      try { client.$emt({ name: 'values_updated', status: client.loadingStatus, values: null }); } catch {}
    }
    return 'patched';
  })()`;
}

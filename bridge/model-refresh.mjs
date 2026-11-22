// Keep catalogue outages distinct from a successful entitlement response.
export async function refreshModels({ state, ensureAuth, fetchModels, sources, log = () => {} }, { force = false } = {}) {
  const token = await ensureAuth();
  const previous = { login: state.login, models: state.models, at: state.modelsAt };
  if (force || Date.now() - state.modelsAt > 5 * 60 * 1000 || !state.models.length) {
    try {
      state.models = await fetchModels(token, { force: true, login: state.login });
    } catch (error) {
      log(`model refresh failed with current credential: ${error.message}; resolving credential again`);
      try {
        const retryToken = await ensureAuth({ force: true });
        state.models = await fetchModels(retryToken, { force: true, login: state.login });
      } catch (failure) {
        state.modelRefreshError = failure;
        const category = failure.diagnostic?.category;
        const transient = ["network_error", "timeout", "tls_error", "rate_limited", "upstream_error"].includes(category);
        if (!transient) throw failure;
        if (state.login && state.login === previous.login && previous.models.length) {
          state.models = previous.models;
          state.modelsAt = previous.at;
          log("Copilot catalogue refresh unavailable; retaining the same account's last successful catalogue.");
          return sources.merge(state.models);
        }
        // Never publish an API-only replacement for an unavailable Copilot list.
        throw failure;
      }
    }
    state.modelsAt = Date.now();
    state.modelRefreshError = null;
  }
  return sources.merge(state.models);
}

// Report only fixed labels and numeric status codes. Never display provider
// response bodies, token values, credential targets or raw error messages.
const categories = {
  credential_missing: "no credential in the configured source",
  store_unreadable: "saved credential store could not be read",
  store_invalid_json: "saved credential store is not valid JSON",
  authorization_denied: "provider rejected authorization or entitlement",
  rate_limited: "provider rate-limited model validation",
  upstream_error: "provider model service unavailable",
  network_error: "model validation network request failed",
  timeout: "model validation timed out",
  tls_error: "model validation TLS verification failed",
  invalid_json: "provider model response is not valid JSON",
  invalid_schema: "provider model response has an unsupported structure",
  no_eligible_models: "provider returned no eligible chat models",
  cache_write_error: "validated model cache could not be written",
  identity_mismatch: "candidate does not match the selected account",
};

function failures(diagnostics) {
  return Array.isArray(diagnostics)
    ? diagnostics.filter(item => item && item.category !== "ok")
    : [];
}

export function formatCredentialDiagnostic(diagnostics) {
  const items = failures(diagnostics);
  if (!items.length) return "credential validation was not completed";
  return [...new Set(items.map(item => {
    let label = Object.hasOwn(categories, item.category)
      ? categories[item.category] : "credential validation failed";
    if (item.source === "credential-manager" &&
        ["store_unreadable", "store_invalid_json"].includes(item.category)) {
      label = item.category === "store_unreadable"
        ? "Credential Manager could not be read"
        : "Credential Manager returned an invalid credential record";
    }
    const statuses = Array.isArray(item.statuses)
      ? [...new Set(item.statuses.filter(status =>
        Number.isInteger(status) && status >= 100 && status <= 599))].sort((a, b) => a - b)
      : [];
    return label + (statuses.length ? ` (HTTP ${statuses.join("/")})` : "");
  }))].join("; ");
}

export function credentialRecoveryHint(diagnostics) {
  const kinds = new Set(failures(diagnostics).map(item => item.category));
  if (kinds.has("store_unreadable") || kinds.has("store_invalid_json") ||
      kinds.has("cache_write_error")) {
    return "Check the selected profile's file access and storage; do not replace a validated credential.";
  }
  const uncertain = ["rate_limited", "upstream_error", "network_error", "timeout",
    "tls_error", "invalid_json", "invalid_schema", "no_eligible_models", "unknown"];
  if ((kinds.has("authorization_denied") || kinds.has("credential_missing")) &&
      !uncertain.some(kind => kinds.has(kind))) {
    return "Check the selected account's Copilot access. Use `codex-copilot login --force` only if authentication is required.";
  }
  if (kinds.has("identity_mismatch")) {
    return "The selected account is pinned; do not switch accounts as a recovery shortcut.";
  }
  return "Check the provider/network condition and retry validation. This result does not establish that the saved credential is invalid.";
}

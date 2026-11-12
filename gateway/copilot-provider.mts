import "../tools/typescript-runtime.mjs";
import type { ProviderConfig, EngineAdapter, Modality } from "./contracts.mjs";
import path from "node:path";

export const copilotProviderId = "mycodex-copilot";
export const codexCopilotEngineId = "codex-copilot";
export const codexCopilotPrefix = `mycodex/${codexCopilotEngineId}/`;

export function copilotProviderConfig({ bridgeHome, bridgePort }: ProviderConfig) {
  if (!path.isAbsolute(bridgeHome || "") || !Number.isInteger(bridgePort) || bridgePort < 1024 || bridgePort > 65535)
    throw new Error("Codex + Copilot requires a private bridge home and a valid loopback port.");
  return {
    [`model_providers.${copilotProviderId}`]: {
      name: "Codex + Copilot", base_url: `http://127.0.0.1:${bridgePort}`,
      wire_api: "responses", requires_openai_auth: false,
      http_headers: { "X-Codex-Copilot-Surface": "codex" },
      request_max_retries: 4, stream_max_retries: 5, stream_idle_timeout_ms: 300000,
    },
    model_catalog_json: path.join(bridgeHome, "models.json"),
  };
}

export function copilotProviderArguments(config: ProviderConfig) {
  const provider = copilotProviderConfig(config)[`model_providers.${copilotProviderId}`];
  return Object.entries(provider).flatMap(([key, value]) => key === "http_headers"
    ? Object.entries(value as Record<string, string>).flatMap(([name, header]) => ["-c", `model_providers.${copilotProviderId}.http_headers.${JSON.stringify(name)}=${JSON.stringify(header)}`])
    : ["-c", `model_providers.${copilotProviderId}.${key}=${JSON.stringify(value)}`]);
}

export function codexCopilotCatalog(config: ProviderConfig, { fetchImpl = fetch } = {}): EngineAdapter {
  copilotProviderConfig(config);
  return {
    adapter: "codex-copilot", nativeProvider: true,
    async models() {
      const base = `http://127.0.0.1:${config.bridgePort}`;
      const health = await fetchImpl(`${base}/health`, { redirect: "error", signal: AbortSignal.timeout(10000) });
      if (!health.ok) throw new Error(`Copilot bridge health failed: HTTP ${health.status}`);
      const status = await health.json();
      if (status.bridge !== "codex-copilot") throw new Error("The selected port is not a Codex Copilot bridge.");
      if (status.status !== "ok") throw new Error("Codex + Copilot 尚未登录。请先为 API bridge 完成 GitHub 登录，再刷新模型；CLI 登录不等于 API bridge 登录。");
      const response = await fetchImpl(`${base}/catalog`, { redirect: "error", signal: AbortSignal.timeout(30000) });
      if (!response.ok) throw new Error(`Copilot bridge catalog failed: HTTP ${response.status}`);
      const catalog = await response.json() as { models: { slug: string; display_name?: string; description?: string; input_modalities?: Modality[]; supported_reasoning_levels?: { effort: string }[]; default_reasoning_level?: string }[] };
      if (!Array.isArray(catalog.models)) throw new Error("Invalid Copilot bridge catalog.");
      return catalog.models.map(model => ({
        id: model.slug, name: model.display_name?.replaceAll("\u200b", "") || model.slug,
        description: model.description, inputModalities: model.input_modalities ?? ["text"],
        supportedReasoningEfforts: model.supported_reasoning_levels?.map(level => level.effort) ?? [],
        defaultReasoningEffort: model.default_reasoning_level,
      }));
    },
    async run() { throw new Error("Codex + Copilot threads must execute in the native Codex app-server, not the CLI gateway."); },
  };
}

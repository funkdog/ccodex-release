import fs from "node:fs";
import * as useModel from "./use-model.mjs";

export function chooseConfiguredModel(catalog, upstream) {
  if (!catalog.models.length || !fs.existsSync(useModel.CONFIG_FILE)) return null;

  let current = null;
  try {
    current = useModel.current();
  } catch {
    /* the generated config is diagnosed separately */
  }
  if (current?.model && catalog.models.some((model) => model.slug === current.model)) {
    const entry = catalog.models.find((model) => model.slug === current.model);
    if (current.serviceTier && current.serviceTier !== "context-long") {
      // A non-context service tier belongs to the user's provider settings.
      // Do not erase it while normalizing the Desktop context aliases.
      return entry.slug;
    }
    const context =
      current.contextTier === "long_context" && entry?.copilot?.long_context_prompt_tokens
        ? "long_context"
        : "default";
    const validEfforts = (entry?.supported_reasoning_levels || []).map((level) => level.effort);
    const effort = validEfforts.includes(current.effort) ? current.effort : undefined;
    return useModel.use(current.model, effort, context).model;
  }

  const preferred = process.env.CODEX_COPILOT_DEFAULT_MODEL;
  const upstreamDefault = upstream.find((model) => model.is_chat_default);
  const candidates = [preferred, upstreamDefault?.id, catalog.models[0]?.slug].filter(Boolean);
  const selected = candidates.find((slug) =>
    catalog.models.some((model) => model.slug === slug),
  );
  if (selected) useModel.use(selected);
  return selected || null;
}

import fs from "node:fs";
import path from "node:path";
import { applyModelPolicies, fetchCopilotModelRecords, modelPoliciesRevision, stabilizeCopilotModels } from "./auth.mjs";
import { fetchCopilotCliModelMetadata } from "./copilot-cli-models.mjs";

const TEMPLATE_FILE = path.join(import.meta.dirname, "..", "assets", "catalog-templates.json");
const AUTO_REVIEW_MODEL = process.env.CODEX_COPILOT_AUTO_REVIEW_MODEL || null;

let templateCache = null;
function templates() {
  if (templateCache) return templateCache;
  try {
    templateCache = JSON.parse(fs.readFileSync(TEMPLATE_FILE, "utf8")).models || [];
  } catch {
    templateCache = [];
  }
  return templateCache;
}

function templateBySlug(slug) {
  return templates().find((m) => m.slug === slug) || null;
}

/**
 * Pick the closest official Codex catalog entry to use as the behavioural template
 * (base instructions, tool prompts, approval copy) for a Copilot model.
 */
function pickTemplate(model) {
  const id = model.id;
  const direct = templateBySlug(id);
  if (direct) return direct;

  const family = model.capabilities?.family || "";
  if (/codex/.test(id)) return templateBySlug("gpt-5.3-codex");
  if (/^gpt-5\.6/.test(id) || /mai-code/.test(id)) return templateBySlug("gpt-5.6-sol");
  if (/^gpt-5\.5/.test(id)) return templateBySlug("gpt-5.5");
  if (/mini|flash|haiku/.test(id) || /mini|flash|haiku/.test(family)) return templateBySlug("gpt-5.4-mini");
  if (/^gpt-5/.test(id)) return templateBySlug("gpt-5.4");
  return templateBySlug("gpt-5.4") || templates()[0] || null;
}

const REASONING_DESCRIPTIONS = {
  none: "No extra reasoning",
  minimal: "Fastest responses with minimal reasoning",
  low: "Fast responses with lighter reasoning",
  medium: "Balances speed and reasoning depth for everyday tasks",
  high: "Greater reasoning depth for complex problems",
  xhigh: "Extra high reasoning depth for complex problems",
  max: "Maximum reasoning depth for the hardest problems",
  ultra: "Maximum reasoning with automatic task delegation",
};

// Values understood by the native Codex protocol. Unknown GitHub values are omitted
// rather than guessed because presenting an option the request layer cannot serialize
// would make the picker lie about what will run.
const VALID_EFFORTS = new Set(["none", "minimal", "low", "medium", "high", "xhigh", "max", "ultra"]);

const VENDOR_LABEL = {
  Anthropic: "Anthropic",
  Google: "Google",
  OpenAI: "OpenAI",
  xAI: "xAI",
  Microsoft: "Microsoft",
};
const VENDOR_ORDER = new Map(
  ["OpenAI", "Anthropic", "Google", "xAI", "Microsoft"].map((vendor, index) => [
    vendor,
    index,
  ]),
);

// The desktop model picker shortens any label that starts with "GPT-" down to the bare
// version ("GPT-5.6 Sol" renders as "5.6 Sol", "GPT-5.4" as "5.4"). Both the reformatter
// and the prefix strip bail out on names that do not begin with "gpt", so a leading
// zero-width space keeps the complete Copilot name on screen without altering it.
const NAME_GUARD = "\u200B";
export const LONG_CONTEXT_SUFFIX = "--long-context";
export const DEFAULT_CONTEXT_SUFFIX = "--default-context";
export const LONG_CONTEXT_SERVICE_TIER = "context-long";

/** The Copilot model name, shielded from the desktop picker's "GPT-" truncation. */
export function displayName(name) {
  const label = String(name ?? "");
  return /^\s*gpt/iu.test(label) ? `${NAME_GUARD}${label}` : label;
}

/** Inverse of {@link displayName}, for terminal output and comparisons. */
export function plainName(name) {
  return String(name ?? "").split(NAME_GUARD).join("");
}

/** Endpoint families we can drive. */
export function routeFor(model) {
  const endpoints = model.supported_endpoints || [];
  if (endpoints.some((e) => e === "/responses")) return "responses";
  if (endpoints.some((e) => e === "/chat/completions")) return "chat";
  return null;
}

function vendorGroup(model) {
  return model.vendor === "Azure OpenAI"
    ? "OpenAI"
    : VENDOR_LABEL[model.vendor] || model.vendor || "Other";
}

function versionParts(model) {
  const source = String(model.version || model.id || "");
  return [...source.matchAll(/\d+/g)].map((match) => Number(match[0]));
}

function compareVersionDescending(left, right) {
  const leftParts = versionParts(left);
  const rightParts = versionParts(right);
  const length = Math.max(leftParts.length, rightParts.length);
  for (let index = 0; index < length; index += 1) {
    const difference = (rightParts[index] || 0) - (leftParts[index] || 0);
    if (difference !== 0) return difference;
  }
  return 0;
}

const CHAT_SINGLE_STREAM_INTRO =
  "You communicate with the user through a single assistant text stream. Include a brief 1-2 sentence progress note only in turns that also invoke tools; emit a standalone text response without tool calls only when yielding back to the user with your final answer or a blocking question.";

const CHAT_PROGRESS_UPDATES_SECTION = `## Progress updates

- Include brief 1-2 sentence progress updates only alongside tool calls in the same assistant turn.
- Never send a standalone progress message without tool calls, because a turn without tool calls ends your work and yields back to the user.
- Do not prefix messages with channel labels.
- Ensure your final answer is self-contained and summarizes the key outcomes and verification.`;

function rebrandInstructions(text, model, { route } = {}) {
  if (!text) return text;
  let updated = text;
  if ((model.vendor || "OpenAI") !== "OpenAI") {
    updated = updated.replace(
      /^You are Codex, an? ([a-z ]*)agent based on GPT-[0-9.]+\./,
      (_m, kind) => `You are Codex, a ${kind}agent based on ${model.name}.`,
    );
  }
  if (route === "chat") {
    updated = updated.replace(
      /(?:Use `multi_tool_use\.parallel` to parallelize tool calls and only this\.|You use `multi_tool_use\.parallel` for that parallelism, and only that\.)/g,
      "Emit independent tool calls in parallel within the same assistant turn when supported.",
    );
    updated = updated.replace(
      /You have (?:2 ways of communicating|two channels for staying in conversation) with the users?:\r?\n- (?:Share intermediary updates|You share updates) in (?:the )?`commentary` channel\.[ \t]*\r?\n- (?:After you have completed all(?: of)? your work, (?:you )?send a message|You yield back to the user and end your turn by sending a final message) to the `final` channel\./g,
      CHAT_SINGLE_STREAM_INTRO,
    );
    updated = updated.replace(
      /## (?:Intermediary updates|Intermediate commentary)[ \t]*\r?\n[\s\S]*?(?=\r?\n#{1,2} |\s*$)/g,
      CHAT_PROGRESS_UPDATES_SECTION,
    );
    updated = updated.replaceAll("in the `commentary` channel", "in a brief progress note alongside your tool call");
    updated = updated.replaceAll("in the commentary channel", "in a brief progress note alongside your tool call");
    updated = updated.replaceAll("in `commentary` channel", "in a brief progress note alongside your tool call");
    updated = updated.replaceAll("to the `final` channel", "in your final response");
    updated = updated.replaceAll("in the final channel", "in your final response");
  }
  return updated;
}

function reasoningLevels(model) {
  const advertised = model.capabilities?.supports?.reasoning_effort;
  const efforts = Array.isArray(advertised)
    ? advertised.map(String).filter((effort) => VALID_EFFORTS.has(effort))
    : [];
  const seen = new Set();
  return efforts
    .filter((effort) => (seen.has(effort) ? false : seen.add(effort)))
    .map((effort) => ({
      effort,
      description: REASONING_DESCRIPTIONS[effort] || `${effort} reasoning`,
    }));
}

function positiveInteger(value) {
  const number = Number(value);
  return Number.isInteger(number) && number > 0 ? number : null;
}

function totalContextTokens(model, promptTokens) {
  const limits = model.capabilities?.limits || {};
  const outputTokens = positiveInteger(limits.max_output_tokens) || 0;
  const physicalLimit = positiveInteger(limits.max_context_window_tokens);
  const combined = promptTokens + outputTokens;
  return physicalLimit ? Math.min(physicalLimit, combined) : combined;
}

export function formatContextTokens(tokens) {
  if (tokens >= 1_000_000) {
    const millions = tokens / 1_000_000;
    return `${Number.isInteger(millions) ? millions.toFixed(0) : millions.toFixed(1)}M`;
  }
  return `${Math.round(tokens / 1000).toLocaleString()}K`;
}

/** Context tiers exposed by Copilot CLI for this model. */
export function modelContextTiers(model) {
  const limits = model.capabilities?.limits || {};
  const metadata = model.codex_copilot_context || {};
  const defaultPromptTokens =
    positiveInteger(metadata.default_prompt_tokens) ||
    positiveInteger(limits.max_prompt_tokens) ||
    positiveInteger(limits.max_context_window_tokens) ||
    128000;
  const longPromptTokens = positiveInteger(metadata.long_context_prompt_tokens);

  const tiers = [
    {
      key: "default",
      max_prompt_tokens: defaultPromptTokens,
      context_window_tokens: totalContextTokens(model, defaultPromptTokens),
    },
  ];
  if (longPromptTokens && longPromptTokens !== defaultPromptTokens) {
    tiers.push({
      key: "long_context",
      max_prompt_tokens: longPromptTokens,
      context_window_tokens: totalContextTokens(model, longPromptTokens),
    });
  }
  return tiers;
}

export function contextSlug(modelId, tier) {
  return tier === "long_context" ? `${modelId}${LONG_CONTEXT_SUFFIX}` : modelId;
}

/** Resolves CLI tiers and explicit Desktop presets to one upstream Copilot model. */
export function resolveModelSelection(models, slug, serviceTier = null) {
  const requested = String(slug);
  const exact = models.find((model) => model.id === requested);
  const explicitLong = !exact && requested.endsWith(LONG_CONTEXT_SUFFIX);
  const explicitDefault = !exact && requested.endsWith(DEFAULT_CONTEXT_SUFFIX);
  const base = explicitLong
    ? requested.slice(0, -LONG_CONTEXT_SUFFIX.length)
    : explicitDefault
      ? requested.slice(0, -DEFAULT_CONTEXT_SUFFIX.length)
      : null;
  const model = exact || models.find((candidate) => candidate.id === base);
  if (!model) return null;

  const contextTier =
    explicitDefault
      ? "default"
      : explicitLong || serviceTier === LONG_CONTEXT_SERVICE_TIER
      ? "long_context"
      : "default";
  if (
    (contextTier === "long_context" || explicitDefault) &&
    !modelContextTiers(model).some((tier) => tier.key === "long_context")
  ) {
    return null;
  }
  return { model, contextTier };
}

/**
 * The official Desktop core cannot change the model context window through its
 * service-tier setting. Give it two real model presets instead. The CLI catalog
 * remains unchanged, so /model still follows Model → Context → Effort.
 */
export function buildDesktopCatalog(catalog) {
  const source = catalog?.models || [];
  const occupied = new Set(source.map((entry) => entry.slug));
  const models = [];
  let priority = 1;
  for (const entry of source) {
    const standardTokens = positiveInteger(entry.copilot?.default_prompt_tokens);
    const longTokens = positiveInteger(entry.copilot?.long_context_prompt_tokens);
    const standardSlug = `${entry.slug}${DEFAULT_CONTEXT_SUFFIX}`;
    const longSlug = `${entry.slug}${LONG_CONTEXT_SUFFIX}`;
    if (
      !standardTokens || !longTokens || longTokens <= standardTokens ||
      occupied.has(standardSlug) || occupied.has(longSlug)
    ) {
      models.push({ ...entry, priority: priority++ });
      continue;
    }

    // Preserve the original slug for conversations created by earlier releases,
    // but keep it out of the new picker: its inherited service tier alone cannot
    // enlarge the official core's effective window.
    models.push({ ...entry, visibility: "hide", priority: priority++ });
    for (const [slug, tokens, name] of [
      [standardSlug, standardTokens, "Standard"],
      [longSlug, longTokens, "Long"],
    ]) {
      const preset = structuredClone(entry);
      preset.slug = slug;
      preset.display_name = displayName(plainName(entry.display_name));
      preset.description =
        `${name} context · ${formatContextTokens(tokens)} prompt tokens` +
        ` · ${formatContextTokens(
          name === "Long"
            ? entry.copilot.long_context_window_tokens
            : entry.copilot.default_context_window_tokens
        )} total · ${entry.description}`;
      preset.visibility = "list";
      preset.priority = priority++;
      preset.context_window = tokens;
      preset.max_context_window = tokens;
      preset.service_tiers = [];
      preset.default_service_tier = null;
      preset.copilot.context_tier = name === "Long" ? "long_context" : "default";
      models.push(preset);
    }
  }
  return { models };
}

/**
 * Convert the live GitHub Copilot model list into a Codex `model_catalog_json` document.
 */
export function buildCatalog(copilotModels, { includeHidden = false } = {}) {
  const usable = copilotModels.filter((m) => {
    if (m.capabilities?.type !== "chat") return false;
    if (!routeFor(m)) return false;
    if (!includeHidden && !m.model_picker_enabled) return false;
    if (m.policy && m.policy.state && m.policy.state !== "enabled") return false;
    return true;
  });

  // Keep each company's models together, newest version first. GitHub's input
  // order is retained for same-version variants because the API has no release date.
  const ordered = usable
    .map((model, index) => ({ model, index }))
    .sort((left, right) => {
      const leftVendor = vendorGroup(left.model);
      const rightVendor = vendorGroup(right.model);
      const vendorDifference =
        (VENDOR_ORDER.get(leftVendor) ?? VENDOR_ORDER.size) -
        (VENDOR_ORDER.get(rightVendor) ?? VENDOR_ORDER.size);
      if (vendorDifference !== 0) return vendorDifference;
      const versionDifference = compareVersionDescending(left.model, right.model);
      if (versionDifference !== 0) return versionDifference;
      return left.index - right.index;
    });

  const models = [];
  let priority = 1;
  for (const { model } of ordered) {
    const route = routeFor(model);
    const template = pickTemplate(model);
    if (!template) continue;

    const levels = reasoningLevels(model);
    const vendor = VENDOR_LABEL[model.vendor] || model.vendor || "OpenAI";
    const efforts = levels.map((level) => level.effort);
    const advertisedDefault = String(
      model.capabilities?.supports?.default_reasoning_effort ||
        model.default_reasoning_effort ||
        "",
    );
    const defaultReasoningLevel = efforts.includes(advertisedDefault)
      ? advertisedDefault
      : efforts.includes("medium")
        ? "medium"
        : efforts[0] || null;

    const tiers = modelContextTiers(model);
    const defaultTier = tiers[0];
    const longTier = tiers.find((tier) => tier.key === "long_context") || null;
    const entry = JSON.parse(JSON.stringify(template));
    const traits = [
      route === "responses" ? "native Responses API" : "adapted Chat Completions",
      `context: ${tiers.map((tier) => formatContextTokens(tier.context_window_tokens)).join("/")}`,
      model.capabilities?.supports?.vision ? "vision" : null,
      model.capabilities?.supports?.parallel_tool_calls ? "parallel tools" : null,
      efforts.length ? `reasoning: ${efforts.join("/")}` : "no configurable reasoning effort",
    ].filter(Boolean);

    entry.slug = model.id;
    entry.display_name = displayName(model.name);
    entry.description = `${vendor} via GitHub Copilot · ${traits.join(" · ")}`;
    entry.visibility = "list";
    entry.supported_in_api = true;
    entry.priority = priority++;
    entry.context_window = defaultTier.max_prompt_tokens;
    entry.max_context_window = longTier?.max_prompt_tokens || defaultTier.max_prompt_tokens;
    entry.auto_compact_token_limit = null;
    entry.input_modalities = model.capabilities?.supports?.vision ? ["text", "image"] : ["text"];
    entry.supports_parallel_tool_calls = Boolean(model.capabilities?.supports?.parallel_tool_calls);
    entry.supports_image_detail_original = Boolean(model.capabilities?.supports?.vision);
    entry.base_instructions = rebrandInstructions(entry.base_instructions, model, { route });
    if (entry.model_messages && typeof entry.model_messages.instructions_template === "string") {
      entry.model_messages = {
        ...entry.model_messages,
        instructions_template: rebrandInstructions(entry.model_messages.instructions_template, model, { route }),
      };
    }
    entry.availability_nux = undefined;
    entry.upgrade = null;
    entry.additional_speed_tiers = [];
    entry.service_tiers = longTier
      ? [
          {
            id: LONG_CONTEXT_SERVICE_TIER,
            name: formatContextTokens(longTier.context_window_tokens),
            description: formatContextTokens(defaultTier.context_window_tokens),
          },
        ]
      : [];
    entry.default_service_tier = null;
    if (AUTO_REVIEW_MODEL && usable.some((candidate) => candidate.id === AUTO_REVIEW_MODEL)) {
      entry.auto_review_model_override = AUTO_REVIEW_MODEL;
    }
    entry.experimental_supported_tools = [];
    entry.supported_reasoning_levels = levels;
    if (defaultReasoningLevel) entry.default_reasoning_level = defaultReasoningLevel;
    else delete entry.default_reasoning_level;

    if (route === "chat") {
      // The Chat Completions wire format has no server-side reasoning items and no
      // native web search. Freeform (custom) tools stay enabled because the bridge
      // re-encodes them as a single-string JSON function call and unwraps the result.
      entry.prefer_websockets = false;
      entry.use_responses_lite = false;
      entry.support_verbosity = false;
      entry.default_reasoning_summary = "none";
      entry.supports_reasoning_summaries = false;
      entry.supports_reasoning_summary_parameter = false;
      entry.supports_search_tool = false;
      delete entry.web_search_tool_type;
      delete entry.tool_mode;
      delete entry.multi_agent_version;
    }

    // Drop undefined keys so the JSON stays close to the official document shape.
    for (const key of Object.keys(entry)) if (entry[key] === undefined) delete entry[key];

    entry.copilot = {
      route,
      vendor,
      vendor_group: vendorGroup(model),
      family: model.capabilities?.family || null,
      base_model: model.id,
      default_context_window_tokens: defaultTier.context_window_tokens,
      default_prompt_tokens: defaultTier.max_prompt_tokens,
      long_context_window_tokens: longTier?.context_window_tokens || null,
      long_context_prompt_tokens: longTier?.max_prompt_tokens || null,
      capability_provenance: {
        model: "github-copilot-models",
        efforts: efforts.length ? "github-copilot-models" : null,
        context:
          model.codex_copilot_context?.default_prompt_tokens ||
          model.codex_copilot_context?.long_context_prompt_tokens
            ? "copilot-cli-sdk"
            : "github-copilot-models",
      },
    };
    models.push(entry);
  }

  return { models };
}

let modelCache = { at: 0, token: null, login: null, policyRev: null, data: null };

export async function fetchCopilotModels(token, { force = false, login = null, forceCliMetadata = false } = {}) {
  const ttl = 5 * 60 * 1000;
  const policyRev = modelPoliciesRevision();
  if (
    !force &&
    modelCache.token === token &&
    modelCache.login === login &&
    modelCache.policyRev === policyRev &&
    modelCache.data &&
    Date.now() - modelCache.at < ttl
  ) {
    return modelCache.data;
  }
  const data = applyModelPolicies(
    stabilizeCopilotModels(
      login,
      await fetchCopilotModelRecords(token),
    ),
  );
  const metadata = await fetchCopilotCliModelMetadata(token, { force: forceCliMetadata });
  const enriched = data.map((model) => {
    const context = metadata.get(model.id);
    return context ? { ...model, codex_copilot_context: context } : model;
  });
  modelCache = { at: Date.now(), token, login, policyRev, data: enriched };
  return enriched;
}

export function routeMap(copilotModels) {
  const map = new Map();
  for (const m of copilotModels) {
    const route = routeFor(m);
    if (route) map.set(m.id, route);
  }
  return map;
}

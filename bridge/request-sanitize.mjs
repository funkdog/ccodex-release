const STRIP_ALWAYS = [
  "_audit",
  "previous_response_id",
  "service_tier",
  "safety_identifier",
  "prompt_cache_key",
];

function toolFallbackName(tool) {
  return tool?.name || tool?.function?.name || "tool";
}

function sanitizeTool(tool) {
  if (!tool || typeof tool !== "object" || Array.isArray(tool)) return tool;
  const sanitized = { ...tool };
  const fallback = `Run ${toolFallbackName(tool)}`;

  if (
    Object.hasOwn(sanitized, "description") &&
    (typeof sanitized.description !== "string" || sanitized.description.trim() === "")
  ) {
    sanitized.description = fallback;
  }

  if (sanitized.function && typeof sanitized.function === "object") {
    sanitized.function = { ...sanitized.function };
    if (
      Object.hasOwn(sanitized.function, "description") &&
      (typeof sanitized.function.description !== "string" ||
        sanitized.function.description.trim() === "")
    ) {
      sanitized.function.description = fallback;
    }
  }

  return sanitized;
}

function sanitizeTools(tools) {
  return Array.isArray(tools) ? tools.map(sanitizeTool) : tools;
}

export function sanitizeResponsesBody(request) {
  const body = { ...request };
  for (const key of STRIP_ALWAYS) delete body[key];
  if (Array.isArray(body.include) && body.include.length === 0) delete body.include;
  if (Array.isArray(body.tools)) body.tools = sanitizeTools(body.tools);
  if (Array.isArray(body.input)) {
    body.input = body.input.map((item) =>
      item && typeof item === "object" && !Array.isArray(item) && Array.isArray(item.tools)
        ? { ...item, tools: sanitizeTools(item.tools) }
        : item,
    );
  }
  return body;
}

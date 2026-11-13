import { randomUUID, createHash } from "node:crypto";
import { isContextWindowError, normalizeResponsesError } from "./responses-errors.mjs";
import { readSseFrames } from "./responses-stream.mjs";
import { normalizeResponsesInput } from "./request-sanitize.mjs";

export function id(prefix) {
  return `${prefix}_${randomUUID().replaceAll("-", "")}`;
}

function unsupportedInput(message) {
  return Object.assign(new Error(message), { code: "unsupported_input", status: 400 });
}

/* ------------------------------------------------------------------ *
 * Responses request  ->  Chat Completions request
 * ------------------------------------------------------------------ */

function textOf(value) {
  if (typeof value === "string") return value;
  if (value === null || value === undefined) return "";
  if (Array.isArray(value)) return value.map(textOf).filter(Boolean).join("\n");
  if (typeof value === "object") {
    if (typeof value.text === "string") return value.text;
    if (typeof value.output_text === "string") return value.output_text;
    try {
      return JSON.stringify(value);
    } catch {
      return String(value);
    }
  }
  return String(value);
}

function jsonArgs(value) {
  if (typeof value === "string") return value || "{}";
  if (value === null || value === undefined) return "{}";
  try {
    return JSON.stringify(value);
  } catch {
    return "{}";
  }
}

function contentParts(content, { vision }) {
  if (typeof content === "string") return content;
  if (!Array.isArray(content)) return textOf(content);

  const parts = [];
  for (const part of content) {
    if (!part) continue;
    const type = part.type || "";
    if (["input_text", "output_text", "text", "summary_text"].includes(type)) {
      const text = textOf(part.text ?? part);
      if (text) parts.push({ type: "text", text });
    } else if (type === "refusal") {
      const text = textOf(part.refusal ?? part.text ?? part);
      if (text) parts.push({ type: "text", text });
    } else if (["input_image", "image_url"].includes(type)) {
      const url = part.image_url?.url || part.image_url || part.url;
      if (vision && typeof url === "string" && url) {
        parts.push({ type: "image_url", image_url: { url } });
      } else {
        parts.push({ type: "text", text: "[image omitted: model has no vision support]" });
      }
    } else if (type === "input_file") {
      throw unsupportedInput("Chat Completions does not support input_file attachments; provide text or an image instead.");
    } else {
      const text = textOf(part);
      if (text) parts.push({ type: "text", text });
    }
  }
  if (parts.length === 0) return "";
  if (parts.every((p) => p.type === "text")) return parts.map((p) => p.text).join("\n");
  return parts;
}

function isEmpty(content) {
  if (typeof content === "string") return content.trim() === "";
  return !Array.isArray(content) || content.length === 0;
}

function chatToolName(name, namespace) {
  if (!namespace) return name;
  const prefix = `${namespace}_${name}`.replace(/[^A-Za-z0-9_-]/g, "_").slice(0, 40);
  return `ns_${prefix}_${createHash("sha256").update(namespace + "\0" + name).digest("hex").slice(0, 16)}`;
}

function hasSchemaRef(node) {
  if (!node || typeof node !== "object") return false;
  if (Array.isArray(node)) return node.some(hasSchemaRef);
  if (typeof node.$ref === "string") return true;
  return Object.values(node).some(hasSchemaRef);
}

function simplifySchemaNode(schema, defs, seen = new Set(), isRoot = false) {
  if (!schema || typeof schema !== "object" || Array.isArray(schema)) return schema;
  if (typeof schema.$ref === "string") {
    const match = /^#\/(?:\$defs|definitions)\/([^/]+)$/.exec(schema.$ref);
    const key = match ? decodeURIComponent(match[1]) : null;
    const target = key && defs && Object.hasOwn(defs, key) ? defs[key] : null;
    const extraKeys = Object.keys(schema).filter((k) => !["$ref", "$defs", "definitions", "description"].includes(k));
    if (target && extraKeys.length === 0 && !seen.has(key)) {
      const nextSeen = new Set(seen);
      nextSeen.add(key);
      const resolved = simplifySchemaNode(target, defs, nextSeen, isRoot);
      if (resolved && typeof resolved === "object" && !Array.isArray(resolved)) {
        return schema.description && !resolved.description ? { ...resolved, description: schema.description } : { ...resolved };
      }
    }
    return schema;
  }

  let current = { ...schema };
  if (isRoot) {
    delete current.$defs;
    delete current.definitions;
  }
  for (const keyword of ["allOf", "anyOf", "oneOf"]) {
    if (Array.isArray(current[keyword]) && current[keyword].length === 1) {
      const only = simplifySchemaNode(current[keyword][0], defs, seen, false);
      if (only && typeof only === "object" && !Array.isArray(only)) {
        const rest = { ...current };
        delete rest[keyword];
        current = { ...only, ...rest };
      }
    }
  }
  for (const keyword of ["anyOf", "oneOf"]) {
    if (!isRoot && Array.isArray(current[keyword])) {
      const nonNull = current[keyword].filter((entry) => !(entry && typeof entry === "object" && entry.type === "null" && Object.keys(entry).length === 1));
      const hasNull = nonNull.length < current[keyword].length;
      if (hasNull && nonNull.length === 1) {
        const simplified = simplifySchemaNode(nonNull[0], defs, seen, false);
        if (simplified && typeof simplified === "object" && !Array.isArray(simplified) &&
            typeof simplified.type === "string" &&
            !["oneOf", "anyOf", "allOf", "$ref"].some((k) => Object.hasOwn(simplified, k))) {
          const rest = { ...current };
          delete rest[keyword];
          current = { ...simplified, ...rest, nullable: true };
        }
      }
    }
  }
  if (current.properties && typeof current.properties === "object" && !Array.isArray(current.properties)) {
    const nextProps = {};
    for (const [propName, propSchema] of Object.entries(current.properties)) {
      nextProps[propName] = simplifySchemaNode(propSchema, defs, seen, false);
    }
    current.properties = nextProps;
  }
  if (current.items && typeof current.items === "object") {
    current.items = Array.isArray(current.items)
      ? current.items.map((entry) => simplifySchemaNode(entry, defs, seen, false))
      : simplifySchemaNode(current.items, defs, seen, false);
  }
  if (hasSchemaRef(current) && (schema.$defs || schema.definitions) && isRoot) {
    if (schema.$defs) current.$defs = schema.$defs;
    if (schema.definitions) current.definitions = schema.definitions;
  }
  return current;
}

function simplifyChatParameters(sourceParameters) {
  if (!sourceParameters || typeof sourceParameters !== "object" || Array.isArray(sourceParameters)) {
    return { type: "object", properties: {} };
  }
  const defs = {
    ...(sourceParameters.definitions && typeof sourceParameters.definitions === "object" ? sourceParameters.definitions : {}),
    ...(sourceParameters.$defs && typeof sourceParameters.$defs === "object" ? sourceParameters.$defs : {}),
  };
  return simplifySchemaNode(sourceParameters, defs, new Set(), true);
}

function collectChatTools(definitions, toolKinds) {
  const result = new Map();
  const visit = (tool, namespace) => {
    if (tool?.type === "tool_search" && tool.execution === "client") {
      const name = "client_tool_search";
      if (toolKinds.has(name) && toolKinds.get(name)?.kind !== "search") throw new Error("Chat tool alias collision; no ambiguous tool was exposed.");
      toolKinds.set(name, { kind: "search", name: "tool_search" });
      result.set(name, { type: "function", function: { name, description: tool.description || "Find the available tools", parameters: tool.parameters || { type: "object", properties: {} } } });
      return;
    }
    if (!tool || typeof tool.name !== "string") return;
    if (tool.type === "namespace") { for (const child of tool.tools ?? []) visit(child, tool.name); return; }
    if (!["function", "custom"].includes(tool.type)) return;
    const name = chatToolName(tool.name, namespace);
    const sourceParameters = tool.parameters || { type: "object", properties: {} };
    const simplifiedParameters = tool.type === "function" ? simplifyChatParameters(sourceParameters) : sourceParameters;
    const jsonEncoded = tool.type === "function" && (
      ["oneOf", "anyOf", "allOf", "$ref"].some(key => Object.hasOwn(simplifiedParameters, key)) ||
      hasSchemaRef(simplifiedParameters) ||
      simplifiedParameters.required?.some(name => !Object.hasOwn(simplifiedParameters.properties ?? {}, name))
    );
    const metadata = namespace || jsonEncoded ? { kind: tool.type, name: tool.name, ...(namespace ? { namespace } : {}), ...(jsonEncoded ? { encoding: "json-string" } : {}) } : tool.type;
    const previous = toolKinds.get(name);
    if (previous !== undefined && (typeof previous !== typeof metadata || typeof previous === "object" &&
        (previous.namespace !== namespace || previous.name !== tool.name || previous.kind !== tool.type))) throw new Error("Chat tool alias collision; no ambiguous tool was exposed.");
    toolKinds.set(name, metadata);
    let description = tool.description || `Run ${tool.name}`;
    if (namespace) description = `[${namespace}.${tool.name}] ${description}`;
    let parameters = simplifiedParameters;
    if (tool.type === "custom") {
      description += "\n\nCall this tool with a single JSON field named `input` whose value is the exact raw tool text (no Markdown fences, no commentary).";
      if (tool.name === "apply_patch") description += "\nThe `input` value must start with `*** Begin Patch` and end with `*** End Patch`, using `*** Add File: <path>`, `*** Update File: <path>` or `*** Delete File: <path>` hunks. Every content line of an Add File hunk must begin with `+`.";
      parameters = { type: "object", properties: { input: { type: "string" } }, required: ["input"] };
    } else if (jsonEncoded) {
      // Chat endpoints can reject root unions or required open fields absent
      // from properties, even when unused in auto mode. Encode the original
      // argument object without narrowing the schema or discarding constraints.
      description += "\n\nCall this tool with a single JSON field named `input`. Its string value must be the complete JSON object of the original tool arguments matching this schema:\n" + JSON.stringify(sourceParameters);
      parameters = { type: "object", properties: { input: { type: "string", description: "Complete JSON serialization of the original argument object." } }, required: ["input"], additionalProperties: false };
    }
    result.set(name, { type: "function", function: { name, description, parameters } });
  };
  for (const tool of definitions) visit(tool);
  return [...result.values()];
}

export function buildChatRequest(request, model) {
  if (request?.previous_response_id) {
    throw unsupportedInput("Chat Completions cannot resume previous_response_id; materialized conversation history is required.");
  }
  const vision = Boolean(model?.capabilities?.supports?.vision);
  const messages = [];
  const toolKinds = new Map();
  const toolCalls = new Map();
  const toolImages = [];
  const flushToolImages = () => { if (toolImages.length) messages.push({ role: "user", content: toolImages.splice(0) }); };

  const pushSystem = (text) => {
    if (!text) return;
    if (messages.length && messages[0].role === "system") {
      messages[0].content += `\n\n${text}`;
    } else {
      messages.unshift({ role: "system", content: text });
    }
  };

  const pushAssistantToolCall = (callId, name, args) => {
    toolCalls.set(callId, name);
    const last = messages[messages.length - 1];
    const call = {
      id: callId,
      type: "function",
      function: { name, arguments: args },
    };
    if (last && last.role === "assistant" && Array.isArray(last.tool_calls) && !last.__sealed) {
      last.tool_calls.push(call);
    } else {
      messages.push({ role: "assistant", content: null, tool_calls: [call] });
    }
  };

  const items = normalizeResponsesInput(typeof request.input === "string"
    ? [{ type: "message", role: "user", content: request.input }]
    : request.input || []);
  const loaded = items.filter(item => ["additional_tools", "tool_search_output"].includes(item?.type)).flatMap(item => item.tools ?? []);
  const tools = collectChatTools([...(request.tools ?? []), ...loaded], toolKinds);

  const systemChunks = [];
  if (typeof request.instructions === "string" && request.instructions.trim()) {
    systemChunks.push(request.instructions);
  }

  for (const item of items) {
    if (!item) continue;
    const type = item.type || (item.role ? "message" : "");
    if (!["function_call_output", "custom_tool_call_output", "tool_search_output"].includes(type)) flushToolImages();
    if (type === "additional_tools") continue;

    if (type === "message") {
      const role = item.role || "user";
      if (role === "system" || role === "developer") {
        const text = textOf(item.content);
        if (text) systemChunks.push(text);
        continue;
      }
      const content = contentParts(item.content, { vision });
      if (isEmpty(content)) continue;
      const target = role === "assistant" ? "assistant" : "user";
      const last = messages[messages.length - 1];
      if (last && last.role === target && typeof last.content === "string" && typeof content === "string") {
        last.content += `\n${content}`;
      } else {
        if (last && last.role === "assistant") last.__sealed = true;
        messages.push({ role: target, content });
      }
    } else if (type === "function_call") {
      const name = chatToolName(item.name, item.namespace);
      const declared = toolKinds.get(name);
      if (typeof declared !== "object" || declared.kind !== "function") toolKinds.set(name, item.namespace ? { kind: "function", name: item.name, namespace: item.namespace } : "function");
      const args = jsonArgs(item.arguments);
      pushAssistantToolCall(item.call_id || item.id || id("call"), name, declared?.encoding === "json-string" ? JSON.stringify({ input: args }) : args);
    } else if (type === "custom_tool_call") {
      const name = chatToolName(item.name, item.namespace);
      toolKinds.set(name, item.namespace ? { kind: "custom", name: item.name, namespace: item.namespace } : "custom");
      pushAssistantToolCall(
        item.call_id || item.id || id("call"),
        name,
        JSON.stringify({ input: typeof item.input === "string" ? item.input : textOf(item.input) })
      );
    } else if (type === "tool_search_call") {
      if (item.execution === "client" && item.call_id) pushAssistantToolCall(item.call_id, "client_tool_search", jsonArgs(item.arguments));
    } else if (type === "tool_search_output") {
      if (item.execution === "client" && item.call_id) messages.push({ role: "tool", tool_call_id: item.call_id, name: "client_tool_search", content: JSON.stringify({ loaded_tools: (item.tools ?? []).map(tool => ({ type: tool.type, name: tool.name })) }) });
    } else if (type === "function_call_output" || type === "custom_tool_call_output") {
      const last = messages[messages.length - 1];
      if (last && last.role === "assistant") last.__sealed = true;
      const callId = item.call_id || item.id;
      const name = toolCalls.get(callId) || item.name;
      const parts = contentParts(item.output, { vision });
      let content = typeof parts === "string" ? parts : parts.filter(part => part.type === "text").map(part => part.text).join("\n");
      if (Array.isArray(parts)) toolImages.push(...parts.filter(part => part.type === "image_url"));
      messages.push({
        role: "tool",
        tool_call_id: callId,
        ...(name ? { name } : {}),
        content: content || (toolImages.length ? "Tool returned an image shown after the tool results." : "(no output)"),
      });
    } else if (type === "compaction" || type === "item_reference") {
      throw unsupportedInput(`Chat Completions cannot decode opaque ${type} history; materialized conversation history is required.`);
    } else if (["reasoning", "web_search_call"].includes(type)) {
      continue;
    } else {
      const text = textOf(item);
      if (text) messages.push({ role: "user", content: text });
    }
  }
  flushToolImages();

  for (const message of messages) delete message.__sealed;
  pushSystem(systemChunks.join("\n\n"));
  if (messages.filter((m) => m.role !== "system").length === 0) {
    messages.push({ role: "user", content: "Continue." });
  }

  const body = {
    model: request.model,
    messages,
    stream: request.stream !== false,
  };
  if (body.stream) body.stream_options = { include_usage: true };
  if (tools.length) {
    body.tools = tools;
    body.tool_choice = mapToolChoice(request.tool_choice);
    if (model?.capabilities?.supports?.parallel_tool_calls && request.parallel_tool_calls !== false) {
      body.parallel_tool_calls = true;
    }
  }

  const maxOut = model?.capabilities?.limits?.max_output_tokens;
  const wanted = Number(request.max_output_tokens) > 0 ? Number(request.max_output_tokens) : maxOut;
  if (wanted) body.max_tokens = Math.min(wanted, maxOut || wanted);

  const efforts = model?.capabilities?.supports?.reasoning_effort;
  const effort = request.reasoning?.effort;
  if (Array.isArray(efforts) && effort && efforts.includes(effort)) body.reasoning_effort = effort;

  if (typeof request.temperature === "number") body.temperature = request.temperature;
  if (typeof request.top_p === "number") body.top_p = request.top_p;

  return { body, toolKinds };
}

function mapToolChoice(choice) {
  if (!choice || choice === "auto") return "auto";
  if (choice === "none" || choice === "required") return choice;
  if (typeof choice === "object") {
    if (choice.type === "tool_search") return { type: "function", function: { name: "client_tool_search" } };
    const name = choice.name || choice.function?.name;
    if (name) return { type: "function", function: { name: chatToolName(name, choice.namespace) } };
  }
  return "auto";
}

/* ------------------------------------------------------------------ *
 * Chat Completions stream  ->  Responses stream
 * ------------------------------------------------------------------ */

function normalizeCustomInput(name, raw) {
  let value = String(raw ?? "").trim();
  // Chat models must wrap freeform tool text in {"input": "..."}; unwrap it (some
  // models nest it more than once) and strip Markdown fences they like to add.
  for (let i = 0; i < 3 && value.startsWith("{"); i += 1) {
    try {
      const parsed = JSON.parse(value);
      if (typeof parsed.input !== "string") break;
      value = parsed.input.trim();
    } catch {
      break;
    }
  }
  value = value.replace(/^```(?:[a-z]*)\s*\r?\n?/i, "").replace(/\r?\n?```$/, "").trim();
  if (name !== "apply_patch") return value;

  const BEGIN = "*** Begin Patch";
  const END = "*** End Patch";
  const lines = [];
  let inAddFile = false;

  for (const line of value.split(/\r?\n/)) {
    const trimmed = line.trim();

    if (/^\*{3}\s*Begin Patch(?:\s*\*{3})?$/i.test(trimmed)) {
      lines.push(BEGIN);
      inAddFile = false;
      continue;
    }
    if (/^\*{3}\s*End Patch(?:\s*\*{3})?$/i.test(trimmed)) {
      if (inAddFile) while (lines.at(-1) === "+") lines.pop();
      lines.push(END);
      inAddFile = false;
      continue;
    }

    const add = trimmed.match(/^(?:\*{3}\s*)?Add File\s*:?\s*(.+?)(?:\s*\*{3})?$/i);
    if (add) {
      lines.push(`*** Add File: ${add[1].trim()}`);
      inAddFile = true;
      continue;
    }
    const update = trimmed.match(/^(?:\*{3}\s*)?Update File\s*:?\s*(.+?)(?:\s*\*{3})?$/i);
    if (update) {
      lines.push(`*** Update File: ${update[1].trim()}`);
      inAddFile = false;
      continue;
    }
    const del = trimmed.match(/^(?:\*{3}\s*)?Delete File\s*:?\s*(.+?)(?:\s*\*{3})?$/i);
    if (del) {
      lines.push(`*** Delete File: ${del[1].trim()}`);
      inAddFile = false;
      continue;
    }

    if (inAddFile) {
      // Add File hunks require every content line to be prefixed with '+'.
      if (/^(---|\+\+\+)\s/.test(trimmed) || /^@@(?:\s|$)/.test(trimmed)) continue;
      if (trimmed === "" && !line.startsWith("+")) continue;
      lines.push(line.startsWith("+") ? line : `+${line}`);
      continue;
    }
    if (trimmed.startsWith("*** ")) inAddFile = false;
    lines.push(line);
  }

  if (lines[0] !== BEGIN) lines.unshift(BEGIN);
  if (lines.at(-1) !== END) lines.push(END);
  return lines.join("\n");
}

function responseObject(request, responseId, createdAt, status, output, usage, incompleteDetails = null) {
  return {
    id: responseId,
    object: "response",
    created_at: createdAt,
    status,
    background: false,
    error: null,
    incomplete_details: incompleteDetails,
    instructions: request.instructions ?? null,
    max_output_tokens: request.max_output_tokens ?? null,
    metadata: request.metadata || {},
    model: request.model,
    output,
    parallel_tool_calls: request.parallel_tool_calls !== false,
    previous_response_id: request.previous_response_id ?? null,
    reasoning: request.reasoning ?? null,
    store: false,
    temperature: request.temperature ?? null,
    text: request.text || { format: { type: "text" } },
    tool_choice: request.tool_choice || "auto",
    tools: request.tools || [],
    top_p: request.top_p ?? null,
    truncation: request.truncation || "disabled",
    usage: usage || null,
    user: request.user ?? null,
  };
}

export function sendJson(res, status, value) {
  const body = JSON.stringify(value);
  res.writeHead(status, {
    "content-type": "application/json",
    "content-length": Buffer.byteLength(body),
    "cache-control": "no-store",
  });
  res.end(body);
}

/**
 * Turns OpenAI Chat Completions stream chunks into the Responses SSE protocol
 * that Codex speaks natively.
 */
export function createResponsesWriter(res, request, toolKinds, { streaming = true, onLog } = {}) {
  const responseId = id("resp");
  const createdAt = Math.floor(Date.now() / 1000);
  const output = [];
  let sequence = 0;
  let started = false;
  let finished = false;
  let usage = null;
  let finishReason = null;

  let textState = null;
  const toolStates = new Map(); // chat tool_call index -> state

  function event(type, fields) {
    if (!streaming) return;
    res.write(`event: ${type}\ndata: ${JSON.stringify({ ...fields, type, sequence_number: sequence++ })}\n\n`);
  }

  function start() {
    if (started) return;
    started = true;
    if (!streaming) return;
    res.writeHead(200, {
      "content-type": "text/event-stream; charset=utf-8",
      "cache-control": "no-cache, no-transform",
      connection: "keep-alive",
      "x-accel-buffering": "no",
    });
    const snapshot = responseObject(request, responseId, createdAt, "in_progress", []);
    event("response.created", { response: snapshot });
    event("response.in_progress", { response: snapshot });
  }

  function ensureText() {
    if (textState) return textState;
    start();
    const itemId = id("msg");
    const outputIndex = output.length;
    const item = { id: itemId, type: "message", status: "in_progress", role: "assistant", content: [] };
    output.push(item);
    textState = { item, itemId, outputIndex, text: "", done: false };
    event("response.output_item.added", { output_index: outputIndex, item: { ...item } });
    event("response.content_part.added", {
      output_index: outputIndex,
      item_id: itemId,
      content_index: 0,
      part: { type: "output_text", text: "", annotations: [], logprobs: [] },
    });
    return textState;
  }

  function closeText(status = "completed") {
    if (!textState || textState.done) return;
    textState.done = true;
    const { item, itemId, outputIndex, text } = textState;
    item.status = status;
    item.content = [{ type: "output_text", text, annotations: [], logprobs: [] }];
    event("response.output_text.done", {
      output_index: outputIndex,
      item_id: itemId,
      content_index: 0,
      text,
      logprobs: [],
    });
    event("response.content_part.done", {
      output_index: outputIndex,
      item_id: itemId,
      content_index: 0,
      part: { type: "output_text", text, annotations: [], logprobs: [] },
    });
    event("response.output_item.done", { output_index: outputIndex, item: { ...item } });
  }

  function materializeTool(state) {
    if (state.materialized) return state;
    start();
    closeText();
    const alias = state.alias;
    const metadata = toolKinds.get(alias);
    const name = typeof metadata === "object" ? metadata.name : alias;
    const namespace = typeof metadata === "object" ? metadata.namespace : undefined;
    const kind = metadata?.kind === "search" ? "search" : metadata === "custom" || metadata?.kind === "custom" ? "custom" : "function";
    const itemId = id("fc");
    const outputIndex = output.length;
    const callId = state.callId || id("call");
    const item =
      kind === "search"
        ? { id: itemId, type: "tool_search_call", status: "in_progress", call_id: callId, execution: "client", arguments: {} }
      : kind === "custom"
        ? { id: itemId, type: "custom_tool_call", status: "in_progress", call_id: callId, name, ...(namespace ? { namespace } : {}), input: "" }
        : { id: itemId, type: "function_call", status: "in_progress", call_id: callId, name, ...(namespace ? { namespace } : {}), arguments: "" };
    output.push(item);
    Object.assign(state, { materialized: true, kind, item, itemId, outputIndex, encoding: metadata?.encoding });
    event("response.output_item.added", { output_index: outputIndex, item: { ...item } });
    if (state.args && state.kind === "function" && state.encoding !== "json-string") {
      event("response.function_call_arguments.delta", {
        output_index: outputIndex,
        item_id: itemId,
        delta: state.args,
      });
    }
    return state;
  }

  function closeTool(state) {
    if (!state || state.done) return;
    if (!state.materialized) {
      throw new Error("Chat tool call stream ended without a function name.");
    }
    state.done = true;
    const { item, itemId, outputIndex } = state;
    item.status = "completed";
    if (state.kind === "custom") {
      item.input = normalizeCustomInput(item.name, state.args);
    } else if (state.kind === "search") {
      item.arguments = JSON.parse(state.args || "{}");
    } else {
      if (state.encoding === "json-string") {
        const wrapper = JSON.parse(state.args || "{}");
        if (typeof wrapper.input !== "string") throw new Error("Encoded tool arguments require an input JSON string.");
        const original = JSON.parse(wrapper.input);
        if (!original || typeof original !== "object" || Array.isArray(original)) throw new Error("Encoded tool arguments must contain a JSON object.");
        item.arguments = wrapper.input;
        event("response.function_call_arguments.delta", { output_index: outputIndex, item_id: itemId, delta: item.arguments });
      } else item.arguments = state.args || "{}";
      event("response.function_call_arguments.done", {
        output_index: outputIndex,
        item_id: itemId,
        arguments: item.arguments,
      });
    }
    event("response.output_item.done", { output_index: outputIndex, item: { ...item } });
  }

  /** Feed one `chat.completion.chunk` (or a whole non-streamed completion). */
  function pushChunk(chunk) {
    if (!chunk || typeof chunk !== "object") return;
    if (chunk.usage) {
      usage = {
        input_tokens: chunk.usage.prompt_tokens || 0,
        input_tokens_details: { cached_tokens: chunk.usage.prompt_tokens_details?.cached_tokens || 0 },
        output_tokens: chunk.usage.completion_tokens || 0,
        output_tokens_details: {
          reasoning_tokens: chunk.usage.completion_tokens_details?.reasoning_tokens || 0,
        },
        total_tokens: chunk.usage.total_tokens || 0,
      };
    }
    const choice = (chunk.choices || [])[0];
    if (!choice) return;
    if (typeof choice.finish_reason === "string" && choice.finish_reason) {
      finishReason = choice.finish_reason;
    }
    const delta = choice.delta || choice.message || {};

    if (typeof delta.content === "string" && delta.content) {
      const state = ensureText();
      state.text += delta.content;
      event("response.output_text.delta", {
        output_index: state.outputIndex,
        item_id: state.itemId,
        content_index: 0,
        delta: delta.content,
        logprobs: [],
      });
    } else if (Array.isArray(delta.content)) {
      for (const part of delta.content) {
        const text = typeof part === "string" ? part : part?.text;
        if (!text) continue;
        const state = ensureText();
        state.text += text;
        event("response.output_text.delta", {
          output_index: state.outputIndex,
          item_id: state.itemId,
          content_index: 0,
          delta: text,
          logprobs: [],
        });
      }
    }

    for (const call of delta.tool_calls || []) {
      const index = call.index ?? toolStates.size;
      let state = toolStates.get(index);
      if (!state) {
        state = { materialized: false, callId: "", alias: "", args: "", done: false };
        toolStates.set(index, state);
      }
      if (call.id) {
        state.callId = call.id;
        if (state.materialized && state.item.call_id !== call.id) state.item.call_id = call.id;
      }
      const incomingName = call.function?.name || call.name;
      if (incomingName && !state.alias) {
        state.alias = incomingName;
      }
      const piece = call.function?.arguments;
      if (!state.materialized) {
        if (typeof piece === "string" && piece) state.args += piece;
        if (state.alias) materializeTool(state);
        continue;
      }
      if (typeof piece === "string" && piece) {
        state.args += piece;
        if (state.kind === "function" && state.encoding !== "json-string") {
          event("response.function_call_arguments.delta", {
            output_index: state.outputIndex,
            item_id: state.itemId,
            delta: piece,
          });
        }
      }
    }
  }

  function finish() {
    if (finished) return { status: "completed", incompleteDetails: null };
    start();
    const incompleteReason =
      finishReason === "length" ? "max_output_tokens"
      : finishReason === "content_filter" ? "content_filter"
      : null;
    if (incompleteReason) {
      closeText("incomplete");
      for (const state of toolStates.values()) {
        state.done = true;
        if (state.materialized && state.item) state.item.status = "incomplete";
      }
      finished = true;
      const details = { reason: incompleteReason };
      const final = responseObject(request, responseId, createdAt, "incomplete", output, usage, details);
      if (streaming) {
        event("response.incomplete", { response: final });
        res.end();
      } else {
        sendJson(res, 200, final);
      }
      onLog?.(`incomplete reason=${incompleteReason} items=${output.length}`);
      return { status: "incomplete", incompleteDetails: details };
    }
    closeText();
    for (const state of toolStates.values()) closeTool(state);
    finished = true;
    const final = responseObject(request, responseId, createdAt, "completed", output, usage);
    if (streaming) {
      event("response.completed", { response: final });
      res.end();
    } else {
      sendJson(res, 200, final);
    }
    onLog?.(`completed items=${output.length}`);
    return { status: "completed", incompleteDetails: null };
  }

  function fail(message, status = 502, code = "upstream_error") {
    if (finished) return;
    finished = true;
    const error = normalizeResponsesError(
      message && typeof message === "object" && !Array.isArray(message)
        ? message : { message, type: "api_error", param: null, code },
    );
    onLog?.(`failed ${status} ${error.message}`);
    if (!streaming || (!started && !isContextWindowError(error))) {
      if (!res.headersSent) sendJson(res, status, { error });
      else res.end();
    } else {
      start();
      event("response.failed", {
        response: {
          ...responseObject(request, responseId, createdAt, "failed", output, usage),
          error,
        },
      });
      res.end();
    }
  }

  function currentUsage() {
    return usage;
  }

  return { pushChunk, finish, fail, start, currentUsage };
}

/** Minimal SSE reader for a `fetch` response body. */
export async function readSse(body, onEvent, onDone) {
  for await (const raw of readSseFrames(body)) {
    const dataLines = [];
    let name = "message";
    for (const line of raw.split(/\r\n|\r|\n/)) {
      if (line.startsWith("event:")) name = line.slice(6).trim();
      else if (line.startsWith("data:")) dataLines.push(line.slice(5).replace(/^ /, ""));
    }
    if (!dataLines.length) continue;
    const payload = dataLines.join("\n");
    if (payload === "[DONE]") {
      onDone?.();
      return;
    }
    let event;
    try { event = JSON.parse(payload); } catch { continue; }
    if (onEvent(name, event) === false) return;
  }
}

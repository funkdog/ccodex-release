import assert from "node:assert/strict";
import test from "node:test";
import { buildChatRequest, createResponsesWriter, readSse } from "../bridge/translate.mjs";
import { memoryResponsesBridge } from "./fixtures/responses-bridge.mjs";

const js = { type: "function", name: "js", description: "Inspect the owned UI fixture", parameters: { type: "object", properties: { code: { type: "string" } }, required: ["code"] } };
const tools = [{ type: "namespace", name: "mcp__cua_repl", description: "Computer Use", tools: [js] },
  { type: "namespace", name: "mcp__node_repl", description: "Other runtime", tools: [js] }];
const image = { type: "input_image", image_url: "data:image/png;base64,fixture-image" };
const unionSchema = { type: "object", oneOf: [{ $ref: "#/$defs/read" }, { $ref: "#/$defs/update" }], $defs: {
  read: { type: "object", properties: { mode: { const: "read" }, id: { type: "string" } }, required: ["mode", "id"], additionalProperties: false },
  update: { type: "object", properties: { mode: { const: "update" }, value: { type: "string" } }, required: ["mode", "value"], additionalProperties: false },
} };
function writerOutput(request, kinds, call) {
  let output;
  const res = { writeHead() {}, end(raw) { output = JSON.parse(raw); } };
  const writer = createResponsesWriter(res, request, kinds, { streaming: false });
  writer.pushChunk({ choices: [{ message: { tool_calls: [call] } }] }); writer.finish(); return output.output[0];
}
test("Chat transports namespaced Computer Use functions without collisions and restores native call identities", () => {
  const request = { model: "gemini-fixture", tools, input: "Inspect the owned test UI" }, before = structuredClone(request);
  const { body, toolKinds } = buildChatRequest(request, {});
  assert.equal(body.tools.length, 2);
  const names = body.tools.map(tool => tool.function.name);
  assert.notEqual(names[0], names[1]);
  for (const name of names) assert.match(name, /^[A-Za-z0-9_-]{1,64}$/);
  const call = writerOutput(request, toolKinds, { id: "call_cua", type: "function", function: { name: names[0], arguments: '{"code":"inspect"}' } });
  assert.equal(call.type, "function_call"); assert.equal(call.namespace, "mcp__cua_repl"); assert.equal(call.name, "js");
  const next = buildChatRequest({ ...request, input: [call, { type: "function_call_output", call_id: call.call_id, output: "fixture inspected" }] }, {});
  assert.equal(next.body.messages.find(message => message.tool_calls).tool_calls[0].function.name, names[0]);
  assert.equal(next.body.messages.find(message => message.role === "tool").name, names[0]);
  assert.deepEqual(request, before);
});

test("Computer Use screenshots remain images after Chat tool results, including parallel tool output ordering", () => {
  const request = { tools, input: [
    { type: "function_call", namespace: "mcp__cua_repl", name: "js", call_id: "call_a", arguments: "{}" },
    { type: "function_call", namespace: "mcp__node_repl", name: "js", call_id: "call_b", arguments: "{}" },
    { type: "function_call_output", call_id: "call_a", output: [{ type: "input_text", text: "Owned screenshot" }, image] },
    { type: "function_call_output", call_id: "call_b", output: "Other result" },
  ] };
  const { body } = buildChatRequest(request, { capabilities: { supports: { vision: true } } });
  assert.deepEqual(body.messages.map(message => message.role), ["assistant", "tool", "tool", "user"]);
  assert.equal(body.messages[1].content, "Owned screenshot");
  assert.deepEqual(body.messages[3].content, [{ type: "image_url", image_url: { url: image.image_url } }]);
});

test("tools added by a trusted deferred-tool result stay callable on the next Chat request", () => {
  const { body } = buildChatRequest({ tools: [], input: [{ type: "additional_tools", role: "developer", tools: [tools[0]] }, { role: "user", content: "Use the loaded UI runtime" }] }, {});
  assert.equal(body.tools.length, 1);
  assert.equal(body.messages.some(message => typeof message.content === "string" && message.content.includes('"type":"additional_tools"')), false);
});

test("client tool discovery survives Chat calls and loads the returned Computer Use namespace", () => {
  const search = { type: "tool_search", execution: "client", description: "Find the available tools", parameters: { type: "object", properties: { query: { type: "string" } } } };
  const first = buildChatRequest({ tools: [search], input: "Find Computer Use" }, {});
  assert.equal(first.body.tools.length, 1);
  const call = writerOutput({ tools: [search] }, first.toolKinds, { id: "call_search", function: { name: first.body.tools[0].function.name, arguments: '{"query":"computer"}' } });
  assert.equal(call.type, "tool_search_call"); assert.equal(call.execution, "client"); assert.deepEqual(call.arguments, { query: "computer" });
  const next = buildChatRequest({ tools: [search], input: [call, { type: "tool_search_output", execution: "client", call_id: call.call_id, status: "completed", tools: [tools[0]] }] }, {});
  assert.equal(next.body.tools.length, 2);
  assert.deepEqual(next.body.messages.map(message => message.role), ["assistant", "tool"]);
});

test("malformed client-search arguments fail explicitly and leave the response available for an error", () => {
  let response;
  const res = { writeHead() {}, end(raw) { response = JSON.parse(raw); } };
  const writer = createResponsesWriter(res, {}, new Map([["client_tool_search", { kind: "search", name: "tool_search" }]]), { streaming: false });
  writer.pushChunk({ choices: [{ message: { tool_calls: [{ id: "call_invalid", function: { name: "client_tool_search", arguments: "{invalid" } }] } }] });
  assert.throws(() => writer.finish(), SyntaxError);
  writer.fail("Invalid client-search JSON"); assert.equal(response.error.message, "Invalid client-search JSON");
});

test("namespaced custom tools retain raw input and explicit tool selection after streaming translation", () => {
  const request = { tools: [{ type: "namespace", name: "editor", tools: [{ type: "custom", name: "patch", description: "Edit the owned test file" }] }],
    tool_choice: { type: "custom", namespace: "editor", name: "patch" }, input: "Edit" };
  const { body, toolKinds } = buildChatRequest(request, {}), name = body.tools[0].function.name;
  assert.equal(body.tool_choice.function.name, name);
  const result = writerOutput(request, toolKinds, { id: "call_patch", function: { name, arguments: '{"input":"raw edit"}' } });
  assert.equal(result.type, "custom_tool_call"); assert.equal(result.namespace, "editor"); assert.equal(result.name, "patch"); assert.equal(result.input, "raw edit");
});

test("root union schemas use a reversible Chat encoding while retaining the complete original contract", () => {
  const request = { model: "gemini-carbon-fixture", tools: [{ type: "namespace", name: "owned_app", tools: [{ type: "function", name: "union_fixture", description: "Synthetic union tool", parameters: unionSchema }] }], input: "Test" };
  const before = structuredClone(request), { body, toolKinds } = buildChatRequest(request, {}), tool = body.tools[0].function;
  assert.equal(tool.parameters.oneOf, undefined); assert.equal(tool.parameters.anyOf, undefined);
  assert.equal(tool.parameters.type, "object"); assert.equal(tool.parameters.properties.input.type, "string");
  assert(tool.description.includes(JSON.stringify(unionSchema)), "Keep the full original schema, including references and branch constraints");
  const args = { mode: "read", id: "owned-fixture" };
  const result = writerOutput(request, toolKinds, { id: "call_union", function: { name: tool.name, arguments: JSON.stringify({ input: JSON.stringify(args) }) } });
  assert.equal(result.namespace, "owned_app"); assert.equal(result.name, "union_fixture"); assert.deepEqual(JSON.parse(result.arguments), args);
  const next = buildChatRequest({ ...request, input: [result, { type: "function_call_output", call_id: result.call_id, output: "fixture result" }] }, {});
  assert.deepEqual(JSON.parse(next.body.messages.find(message => message.tool_calls).tool_calls[0].function.arguments), { input: JSON.stringify(args) });
  assert.deepEqual(request, before);
});

test("open object schemas with required undeclared fields retain their contract through Chat", () => {
  const parameters = { type: "object", additionalProperties: true, properties: { title: { type: "string" } }, required: ["title", "handoff"] };
  const request = { tools: [{ type: "namespace", name: "owned_work", tools: [{ type: "function", name: "upsert", parameters }] }], input: "Test" };
  const before = structuredClone(request), { body, toolKinds } = buildChatRequest(request, {}), tool = body.tools[0].function;
  assert.equal(body.tool_choice, "auto");
  assert(tool.parameters.required.every(name => Object.hasOwn(tool.parameters.properties, name)));
  assert(tool.description.includes(JSON.stringify(parameters)), "Retain the required open field and additional-properties contract");
  const args = { title: "Owned fixture", handoff: { result: "fixture" }, extra: true };
  const call = writerOutput(request, toolKinds, { id: "call_open", function: { name: tool.name, arguments: JSON.stringify({ input: JSON.stringify(args) }) } });
  assert.equal(call.name, "upsert"); assert.equal(call.namespace, "owned_work"); assert.deepEqual(JSON.parse(call.arguments), args);
  const next = buildChatRequest({ ...request, input: [call, { type: "function_call_output", call_id: call.call_id, output: "fixture result" }] }, {});
  assert.deepEqual(JSON.parse(next.body.messages.find(message => message.tool_calls).tool_calls[0].function.arguments), { input: JSON.stringify(args) });
  assert.deepEqual(request, before);
});

for (const stream of [false, true]) test(`normal auto Chat accepts a required open field with stream=${stream}`, async t => {
  const bridge = await memoryResponsesBridge(async (_req, res, body) => {
    assert.equal(body.tool_choice, "auto");
    if (body.tools.some(tool => tool.function.parameters.required?.some(name => !Object.hasOwn(tool.function.parameters.properties ?? {}, name)))) {
      res.writeHead(400, { "content-type": "application/json" }); res.end(JSON.stringify({ error: { code: "invalid_request_body", message: "invalid request body" } })); return;
    }
    res.writeHead(200, { "content-type": body.stream ? "text/event-stream" : "application/json" });
    const completion = { choices: [{ [body.stream ? "delta" : "message"]: { content: "AUTO_CHAT_OK" } }] };
    res.end(body.stream ? `data: ${JSON.stringify(completion)}\n\ndata: [DONE]\n\n` : JSON.stringify(completion));
  }, { route: "/chat/completions" }); t.after(() => bridge.close());
  const response = await fetch(bridge.url, { method: "POST", body: JSON.stringify({ model: "gemini-fixture", stream, input: "Test", tools: [{ type: "function", name: "open_work", parameters: { type: "object", additionalProperties: true, properties: {}, required: ["handoff"] } }] }) });
  assert.equal(response.status, 200);
  const events = []; const result = stream ? (await readSse(response.body, (_name, event) => events.push(event)), events.at(-1).response) : await response.json();
  assert.equal(result.output[0].content[0].text, "AUTO_CHAT_OK");
});

test("encoded function arguments stream back as the original JSON and malformed wrappers fail explicitly", () => {
  const request = { tools: [{ type: "function", name: "union_fixture", parameters: unionSchema }], input: "Test" };
  const { body, toolKinds } = buildChatRequest(request, {}), events = [];
  const res = { writeHead() {}, write(text) { const data = text.split("\ndata: ")[1]; if (data) events.push(JSON.parse(data)); }, end() {} };
  const writer = createResponsesWriter(res, request, toolKinds);
  const original = '{"mode":"read","id":"owned-fixture"}', encoded = JSON.stringify({ input: original });
  writer.pushChunk({ choices: [{ delta: { tool_calls: [{ index: 0, id: "call_encoded", function: { name: body.tools[0].function.name, arguments: encoded.slice(0, 12) } }] } }] });
  writer.pushChunk({ choices: [{ delta: { tool_calls: [{ index: 0, function: { arguments: encoded.slice(12) } }] } }] }); writer.finish();
  assert.equal(events.filter(event => event.type === "response.function_call_arguments.delta").map(event => event.delta).join(""), original);
  assert.equal(events.at(-1).response.output[0].arguments, original);
  assert.throws(() => writerOutput(request, toolKinds, { id: "call_bad_encoding", function: { name: body.tools[0].function.name, arguments: '{"input":{}}' } }), /input JSON string/);
});

for (const stream of [false, true]) test(`ordinary Carbon messages remain usable beside root-union tools with stream=${stream}`, async t => {
  const bridge = await memoryResponsesBridge(async (_req, res, body) => {
    if (body.tools.some(tool => ["oneOf", "anyOf", "allOf", "$ref"].some(key => key in tool.function.parameters))) {
      res.writeHead(400, { "content-type": "application/json" }); res.end(JSON.stringify({ error: { code: "invalid_request_body", message: "invalid request body" } })); return;
    }
    res.writeHead(200, { "content-type": body.stream ? "text/event-stream" : "application/json" });
    const completion = { choices: [{ [body.stream ? "delta" : "message"]: { content: "CARBON_BASIC_CHAT_OK" } }] };
    res.end(body.stream ? `data: ${JSON.stringify(completion)}\n\ndata: [DONE]\n\n` : JSON.stringify(completion));
  }, { route: "/chat/completions" }); t.after(() => bridge.close());
  const response = await fetch(bridge.url, { method: "POST", body: JSON.stringify({ model: "gemini-carbon-fixture", stream, input: "Test", tools: [{ type: "namespace", name: "owned_app", tools: [{ type: "function", name: "union_fixture", parameters: unionSchema }] }] }) });
  assert.equal(response.status, 200);
  const events = []; const result = stream ? (await readSse(response.body, (_name, event) => events.push(event)), events.at(-1).response) : await response.json();
  assert.equal(result.output[0].content[0].text, "CARBON_BASIC_CHAT_OK");
});

for (const stream of [false, true]) test(`production Chat bridge preserves a Computer Use tool and screenshot round trip with stream=${stream}`, async t => {
  let name;
  const bridge = await memoryResponsesBridge(async (_req, res, body, count) => {
    const reply = message => {
      res.writeHead(200, { "content-type": body.stream ? "text/event-stream" : "application/json" });
      const completion = { choices: [{ [body.stream ? "delta" : "message"]: message }] };
      res.end(body.stream ? `data: ${JSON.stringify(completion)}\n\ndata: [DONE]\n\n` : JSON.stringify(completion));
    };
    if (count === 1) {
      name = body.tools.find(tool => tool.function.description.includes("mcp__cua_repl.js")).function.name;
      reply({ tool_calls: [{ index: 0, id: "call_owned_ui", type: "function", function: { name, arguments: '{"code":"inspect owned fixture"}' } }] });
    } else {
      assert.equal(body.messages.find(message => message.role === "tool").name, name);
      assert(body.messages.some(message => Array.isArray(message.content) && message.content.some(part => part.type === "image_url" && part.image_url.url === image.image_url)));
      reply({ content: "COMPUTER_USE_ROUNDTRIP_OK" });
    }
  }, { route: "/chat/completions", model: { id: "gemini-carbon-fixture", capabilities: { supports: { vision: true } } } });
  t.after(() => bridge.close());
  const request = { model: "gemini-carbon-fixture", stream, tools, input: [{ role: "user", content: "Inspect the owned UI" }] };
  const post = async () => {
    const response = await fetch(bridge.url, { method: "POST", body: JSON.stringify(request) }); assert.equal(response.status, 200);
    if (!stream) return response.json();
    const events = []; await readSse(response.body, (_name, event) => events.push(event)); return events.at(-1).response;
  };
  const first = await post(), call = first.output.find(item => item.type === "function_call");
  assert.equal(call.namespace, "mcp__cua_repl"); assert.equal(call.name, "js");
  request.input.push(call, { type: "function_call_output", call_id: call.call_id, output: [{ type: "input_text", text: "Owned screenshot" }, image] });
  const second = await post(); assert.equal(second.output[0].content[0].text, "COMPUTER_USE_ROUNDTRIP_OK");
});

test("streaming tool calls resolve custom, namespaced and search identities when function.name arrives in a later chunk", () => {
  const search = { type: "tool_search", execution: "client", description: "Find tools", parameters: { type: "object", properties: { query: { type: "string" } } } };
  const custom = { type: "namespace", name: "editor", tools: [{ type: "custom", name: "patch", description: "Patch file" }] };
  const request = { tools: [search, custom], input: "Run tools" };
  const { body, toolKinds } = buildChatRequest(request, {});
  const patchAlias = body.tools.find(tool => tool.function.description.includes("[editor.patch]")).function.name;
  const events = [];
  const res = { writeHead() {}, write(text) { const data = text.split("\ndata: ")[1]; if (data) events.push(JSON.parse(data)); }, end() {} };
  const writer = createResponsesWriter(res, request, toolKinds);
  writer.pushChunk({ choices: [{ delta: { tool_calls: [
    { index: 0, id: "call_late_patch", type: "function", function: { arguments: '{"in' } },
    { index: 1, id: "call_late_search", type: "function" },
  ] } }] });
  assert.equal(events.some(event => event.type === "response.output_item.added"), false, "Do not emit output_item.added before the tool name is known");
  writer.pushChunk({ choices: [{ delta: { tool_calls: [
    { index: 0, function: { name: patchAlias, arguments: 'put":"raw patch"}' } },
    { index: 1, function: { name: "client_tool_search", arguments: '{"query":"ui"}' } },
  ] } }] });
  writer.finish();
  const final = events.at(-1).response.output;
  assert.equal(final[0].type, "custom_tool_call");
  assert.equal(final[0].namespace, "editor");
  assert.equal(final[0].name, "patch");
  assert.equal(final[0].call_id, "call_late_patch");
  assert.equal(final[0].input, "raw patch");
  assert.equal(final[1].type, "tool_search_call");
  assert.equal(final[1].call_id, "call_late_search");
  assert.deepEqual(final[1].arguments, { query: "ui" });
});

test("streaming function arguments buffered before function.name arrives are emitted in order without duplication", () => {
  const request = { tools, input: "Inspect UI" };
  const { body, toolKinds } = buildChatRequest(request, {});
  const alias = body.tools[0].function.name;
  const events = [];
  const res = { writeHead() {}, write(text) { const data = text.split("\ndata: ")[1]; if (data) events.push(JSON.parse(data)); }, end() {} };
  const writer = createResponsesWriter(res, request, toolKinds);
  writer.pushChunk({ choices: [{ delta: { tool_calls: [{ index: 0, id: "call_buf", function: { arguments: '{"co' } }] } }] });
  writer.pushChunk({ choices: [{ delta: { tool_calls: [{ index: 0, function: { name: alias, arguments: 'de":"ok' } }] } }] });
  writer.pushChunk({ choices: [{ delta: { tool_calls: [{ index: 0, function: { arguments: '"}' } }] } }] });
  writer.finish();
  assert.equal(events.filter(event => event.type === "response.function_call_arguments.delta").map(event => event.delta).join(""), '{"code":"ok"}');
  assert.equal(events.at(-1).response.output[0].arguments, '{"code":"ok"}');
});

test("local $ref objects and nullable property anyOf simplify to direct Chat schemas without double JSON encoding", () => {
  const parameters = {
    $ref: "#/$defs/QueryParams",
    $defs: {
      QueryParams: {
        type: "object",
        properties: {
          query: { type: "string" },
          cursor: { anyOf: [{ type: "string" }, { type: "null" }], description: "Optional page cursor" },
        },
        required: ["query"],
        additionalProperties: false,
      },
    },
  };
  const request = { tools: [{ type: "namespace", name: "pages", tools: [{ type: "function", name: "find", parameters }] }], input: "Search" };
  const { body, toolKinds } = buildChatRequest(request, {});
  const tool = body.tools[0].function;
  assert.equal(tool.parameters.$ref, undefined);
  assert.equal(tool.parameters.$defs, undefined);
  assert.equal(tool.parameters.properties.input, undefined, "Single-object $ref should not fall back to stringified input wrapper");
  assert.equal(tool.parameters.properties.query.type, "string");
  assert.equal(tool.parameters.properties.cursor.anyOf, undefined);
  assert.equal(tool.parameters.properties.cursor.type, "string");
  assert.equal(tool.parameters.properties.cursor.nullable, true);
  assert.equal(toolKinds.get(tool.name)?.encoding, undefined);
});

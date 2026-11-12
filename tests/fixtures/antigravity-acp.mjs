import fs from "node:fs";
import path from "node:path";
import { randomUUID } from "node:crypto";
import { readMessages, writeMessage } from "../../gateway/ipc.mjs";
const home = process.env.GEMINI_HOME, file = path.join(home, "fixture-session.json");
const send = value => writeMessage(process.stdout, { jsonrpc: "2.0", ...value });
let sessionId, model = "gemini-a", effort = "high", pending, permission;
const config = () => ({ configOptions: [
  { id: "model-choice", category: "model", type: "select", currentValue: model, options: [{ value: "gemini-a", name: "A" }, { value: "gemini-b", name: "B" }] },
  { id: "thinking-choice", category: "thought_level", type: "select", currentValue: effort,
    options: (model === "gemini-a" ? ["low", "high"] : ["medium", "high"]).map(value => ({ value, name: value })) },
] });
const update = value => send({ method: "session/update", params: { sessionId, update: value } });
readMessages(process.stdin, message => {
  if (!message.method) {
    if (message.id !== permission) return;
    update({ sessionUpdate: "agent_message_chunk", content: { type: "text", text: message.result?.outcome?.optionId ?? "Denied" } });
    send({ id: pending, result: { stopReason: "end_turn" } }); return;
  }
  fs.appendFileSync(path.join(home, "calls.jsonl"), JSON.stringify({ method: message.method, params: message.params }) + "\n");
  if (message.method === "initialize") send({ id: message.id, result: { protocolVersion: 1,
    agentInfo: { name: "antigravity-acp", version: process.env.FIXTURE_VERSION ?? "1.4.4" },
    agentCapabilities: { sessionCapabilities: { resume: {} }, promptCapabilities: { image: true } } } });
  else if (["session/new", "session/resume"].includes(message.method)) {
    if (message.method === "session/resume") {
      sessionId = JSON.parse(fs.readFileSync(file, "utf8"))[message.params.sessionId]?.sessionId;
      if (!sessionId || message.params.sessionId !== sessionId) throw new Error("Wrong stored session");
      update({ sessionUpdate: "agent_message_chunk", content: { type: "text", text: "OLD_HISTORY_NOT_NEW_OUTPUT" } });
    } else { sessionId = randomUUID(); const sessions = fs.existsSync(file) ? JSON.parse(fs.readFileSync(file, "utf8")) : {};
      sessions[sessionId] = { sessionId }; fs.writeFileSync(file, JSON.stringify(sessions)); }
    send({ id: message.id, result: { sessionId, ...config() } });
  } else if (message.method === "session/set_config_option") {
    if (message.params.configId === "model-choice") model = message.params.value;
    else if (message.params.configId === "thinking-choice") effort = message.params.value;
    send({ id: message.id, result: config() });
  } else if (message.method === "session/set_mode") send({ id: message.id, result: {} });
  else if (message.method === "session/cancel") { if (pending) send({ id: pending, result: { stopReason: "cancelled" } }); }
  else if (message.method === "session/prompt") {
    pending = message.id;
    const text = message.params.prompt.filter(p => p.type === "text").map(p => p.text).join("");
    if (text === "wait") return;
    if (text === "output-images") {
      update({ sessionUpdate: "tool_call", toolCallId: "image-tool", title: "generate image", status: "inProgress", rawInput: {} });
      update({ sessionUpdate: "tool_call_update", toolCallId: "image-tool", title: "generate image", status: "completed", content: [{ type: "content", content: { type: "image", mimeType: "image/png", data: "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+aN6sAAAAASUVORK5CYII=" } }] });
      send({ id: pending, result: { stopReason: "end_turn" } }); return;
    }
    if (["permission", "question"].includes(text)) {
      permission = "same-peer-request";
      send({ id: permission, method: "session/request_permission", params: { sessionId,
        toolCall: { toolCallId: text === "question" ? "interaction_business" : "write", title: text === "question" ? "Choose a target" : "Write file" },
        options: text === "question" ? [{ kind: "allow_once", optionId: "alpha", name: "Alpha" }, { kind: "allow_once", optionId: "beta", name: "Beta" }]
          : [{ kind: "allow_always", optionId: "always", name: "Always" }, { kind: "allow_once", optionId: "once", name: "Once" }] } });
    } else {
      update({ sessionUpdate: "agent_message_chunk", content: { type: "text", text: message.params.prompt.some(p => p.type === "image") ? "IMAGE_OK" : "TEXT_OK" } });
      send({ id: message.id, result: { stopReason: "end_turn" } });
    }
  } else send({ id: message.id, error: { code: -32601, message: "Unsupported fixture request" } });
}, () => process.exit(1));
process.stdin.once("end", () => process.exit(0));

import fs from "node:fs";
import path from "node:path";
import { randomUUID } from "node:crypto";
import { readMessages, writeMessage } from "../../gateway/ipc.mjs";
const send = message => writeMessage(process.stdout, { jsonrpc: "2.0", ...message });
const file = path.join(process.env.GEMINI_CLI_HOME, "fixture-session.json");
let sessionId, pending, permission;
const update = value => send({ method: "session/update", params: { sessionId, update: value } });
readMessages(process.stdin, message => {
  if (!message.method) {
    if (message.id !== permission) return;
    const outcome = message.result?.outcome;
    update({ sessionUpdate: "tool_call_update", toolCallId: "tool", status: outcome?.optionId === "once" ? "completed" : "failed" });
    update({ sessionUpdate: "agent_message_chunk", content: { type: "text", text: outcome?.optionId === "once" ? "Approved" : "Denied" } });
    send({ id: pending, result: { stopReason: "end_turn" } }); return;
  }
  if (message.method === "initialize") send({ id: message.id, result: { protocolVersion: 1,
    agentCapabilities: { loadSession: true, promptCapabilities: { image: true } } } });
  else if (["session/new", "session/load"].includes(message.method)) {
    if (message.method === "session/load") {
      sessionId = JSON.parse(fs.readFileSync(file, "utf8")).sessionId;
      if (message.params.sessionId !== sessionId) throw new Error("Wrong stored session");
    } else { sessionId = randomUUID(); fs.writeFileSync(file, JSON.stringify({ sessionId })); }
    send({ id: message.id, result: { sessionId, models: { availableModels: [{ modelId: "gemini-fixture", name: "Fixture" }] } } });
    setTimeout(() => {
      if (message.method === "session/load") update({ sessionUpdate: "agent_message_chunk", content: { type: "text", text: "OLD_HISTORY_NOT_A_NEW_REPLY" } });
      update({ sessionUpdate: "available_commands_update", availableCommands: [] });
    }, 5);
  } else if (message.method === "session/set_model") send({ id: message.id, result: {} });
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
    if (text === "permission") {
      update({ sessionUpdate: "tool_call", toolCallId: "tool", title: "Fixture write", status: "pending" });
      permission = "same-peer-permission";
      send({ id: permission, method: "session/request_permission", params: { sessionId,
        toolCall: { toolCallId: "tool", title: "Fixture write" },
        options: [{ kind: "allow_always", optionId: "always" }, { kind: "allow_once", optionId: "once" }] } });
    } else {
      update({ sessionUpdate: "agent_message_chunk", content: { type: "text", text: message.params.prompt.some(p => p.type === "image") ? "IMAGE_OK" : "TEXT_OK" } });
      send({ id: message.id, result: { stopReason: "end_turn" } });
    }
  }
}, () => process.exit(1));
process.stdin.once("end", () => process.exit(0));

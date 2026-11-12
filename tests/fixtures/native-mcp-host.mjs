import { createInterface } from "node:readline";
let calls = 0;
let held = null;
let authorization = null;
const send = message => process.stdout.write(`${JSON.stringify({ jsonrpc: "2.0", ...message })}\n`);
const lines = createInterface({ input: process.stdin });
lines.on("line", line => {
  const request = JSON.parse(line);
  if (request.method === "notifications/cancelled" && held?.id === request.params?.requestId) {
    send({ id: held.id, error: { code: -32800, message: "Cancelled on the original host." } });
    held = null;
    return;
  }
  if (!request.method && request.id === authorization?.id) {
    send({ id: authorization.id, result: { action: request.result?.action, generation: process.env.TEST_NATIVE_GENERATION } });
    authorization = null;
    return;
  }
  if (request.id == null) return;
  if (request.method === "tools/call" && request.params?.name === "hold") {
    held = request;
    send({ method: "notifications/testHolding", params: { requestId: request.id } });
    return;
  }
  if (request.method === "tools/call" && request.params?.name === "authorize") {
    authorization = request;
    send({ id: request.id, method: "elicitation/create", params: { message: "Synthetic request only." } });
    return;
  }
  let result = {};
  if (request.method === "initialize") result = { protocolVersion: "2025-03-26", capabilities: { tools: {} }, serverInfo: { name: "synthetic-native-host", version: "1" } };
  if (request.method === "tools/list") result = { tools: [{ name: "read", inputSchema: { type: "object" } }] };
  if (request.method === "tools/call") result = { content: [{ type: "text", text: JSON.stringify(
    request.params?.name === "turn_ended"
      ? { cleanup: true, generation: process.env.TEST_NATIVE_GENERATION }
      : { calls: ++calls, generation: process.env.TEST_NATIVE_GENERATION }
  ) }] };
  send({ id: request.id, result });
});

// Synthetic native process for transport tests, never a product backend.
import readline from "node:readline";
if (process.env.TEST_CCODEX_NATIVE_PROCESS !== "test-only") process.exit(2);
if (process.argv.includes("--version")) { console.log("native-fixture 1.0"); process.exit(0); }
if (process.argv.includes("--print-startup-config")) { console.log(JSON.stringify({ appServerVersion: "native-fixture", configRequirements: { requirements: null, supportsIndependentSpeedModes: true } })); process.exit(0); }
if (process.argv.includes("exec-server")) {
  const chunks = [];
  for await (const chunk of process.stdin) chunks.push(chunk);
  console.log(JSON.stringify({ input: Buffer.concat(chunks).toString(), args: process.argv.slice(2),
    home: process.env.HOME, codeHome: process.env.CODEX_HOME,
    executorFlag: process.env.CODEX_EXEC_SERVER_EXIT_ON_STDIN_CLOSE,
    recursive: process.env.CODEX_CLI_PATH ?? null, gateway: process.env.CCODEX_GATEWAY_CONNECTION ?? null }));
  process.stderr.write("native executor stderr\n");
  process.exit(7);
}
const write = value => process.stdout.write(JSON.stringify(value) + "\n");
for await (const line of readline.createInterface({ input: process.stdin })) {
  const message = JSON.parse(line);
  if (!Object.hasOwn(message, "id") || !message.method) continue;
  if (message.method === "initialize") write({ id: message.id, result: { userAgent: "native-fixture", codexHome: process.env.CODEX_HOME } });
  else if (message.method === "model/list") write({ id: message.id, result: { data: [{ id: "native-model", model: "native-model", isDefault: true }], nextCursor: null } });
  else if (message.method === "thread/list") write({ id: message.id, result: { data: [], nextCursor: null } });
  else if (message.method === "fixture/crash") process.exit(7);
  else if (message.method === "fixture/environment") write({ id: message.id, result: {
    codeHome: process.env.CODEX_HOME, home: process.env.HOME,
    cliOverride: process.env.CODEX_CLI_PATH ?? null,
    connection: process.env.CCODEX_GATEWAY_CONNECTION ?? null,
  } });
  else if (message.method === "turn/start") write({ id: message.id, error: { code: -32602, message: "Synthetic native fixture never executes inference." } });
  else write({ id: message.id, error: { code: -32601, message: "Synthetic native method unavailable", data: { fixture: true } } });
}

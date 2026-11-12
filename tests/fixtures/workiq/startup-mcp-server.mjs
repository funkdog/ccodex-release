// Isolated startup regression fixture. No Microsoft or model-provider requests.
import { setTimeout as delay } from "node:timers/promises";
import { createWorkIqServer } from "../../../bridge/workiq/server.mjs";
import { runtimeImport } from "../../../bridge/workiq/dependencies.mjs";

const dependencyProfile = process.env.WORKIQ_TEST_DEPENDENCY_PROFILE;
if (!dependencyProfile || process.env.WORKIQ_REQUIRE_RUNTIME_TESTS !== "1") throw new Error("Test gate required.");
const profile = process.env.CODEX_COPILOT_HOME;
const { Server } = await runtimeImport("@modelcontextprotocol/sdk/server/index.js", dependencyProfile);
const { StdioServerTransport } = await runtimeImport("@modelcontextprotocol/sdk/server/stdio.js", dependencyProfile);
const types = await runtimeImport("@modelcontextprotocol/sdk/types.js", dependencyProfile);
const cancellation = new AbortController();
const upstream = {
  client: null,
  connecting: null,
  async connect() {
    if (this.client) return;
    this.connecting ||= delay(20_000, undefined, { signal: cancellation.signal });
    await this.connecting;
    this.client = {};
  },
  async listTools() {
    return [{
      name: "synthetic_delayed_read", description: "SYNTHETIC TEST ONLY: delayed discovery",
      inputSchema: { type: "object", properties: {}, additionalProperties: false },
      annotations: { readOnlyHint: true },
    }];
  },
  async callTool(params) {
    if (params.name !== "synthetic_delayed_read") throw new Error("Unexpected synthetic tool.");
    return { content: [{ type: "text", text: "SYNTHETIC DELAYED RESULT" }] };
  },
  async close() {
    cancellation.abort();
    this.client = null;
  },
};
const instance = await createWorkIqServer({ profile, identity: {}, upstream, sdk: { Server, types } });
process.stdin.once("end", () => { instance.close().catch(() => {}); });
await instance.server.connect(new StdioServerTransport());

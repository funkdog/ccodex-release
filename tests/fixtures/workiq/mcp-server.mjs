// Synthetic backend for isolated native-host integration tests. Never used by
// production configuration and never calls Microsoft or a model provider.
import { createWorkIqServer } from "../../../bridge/workiq/server.mjs";
import { runtimeImport } from "../../../bridge/workiq/dependencies.mjs";
const dependencyProfile = process.env.WORKIQ_TEST_DEPENDENCY_PROFILE;
if (!dependencyProfile || process.env.WORKIQ_REQUIRE_RUNTIME_TESTS !== "1") throw new Error("Test gate required.");
const profile = process.env.CODEX_COPILOT_HOME;
const { Server } = await runtimeImport("@modelcontextprotocol/sdk/server/index.js", dependencyProfile);
const { StdioServerTransport } = await runtimeImport("@modelcontextprotocol/sdk/server/stdio.js", dependencyProfile);
const types = await runtimeImport("@modelcontextprotocol/sdk/types.js", dependencyProfile);
const tools = ["fetch", "create_entity", "future_workiq_tool"].map(name => ({
  name, description: `SYNTHETIC TEST ONLY: ${name}`,
  inputSchema: { type: "object", properties: {}, additionalProperties: false },
  annotations: { readOnlyHint: name !== "create_entity" },
}));
const upstream = {
  client: null,
  async connect() { this.client = {}; },
  async listTools() { return tools; },
  async callTool() { return { content: [{ type: "text", text: "SYNTHETIC TEST ONLY" }] }; },
  async close() { this.client = null; },
};
const instance = await createWorkIqServer({ profile, identity: {}, upstream, sdk: { Server, types } });
await instance.server.connect(new StdioServerTransport());
process.stdin.once("end", () => { instance.close().catch(() => {}); });

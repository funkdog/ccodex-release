// Compile-only consumer: these errors must remain rejected by strict checking.
import type { EngineAdapter, RunContext, ToolEvent } from "../../gateway/contracts.mjs";
import type { UiServices, SessionPreferences, MountedComponent } from "../../bridge/desktop-diy-contracts.mjs";
import { createNativeSessionController } from "../../bridge/desktop-native-session.mjs";
import { RpcPeer } from "../../gateway/rpc-peer.mjs";
const engine: EngineAdapter = { async models() { return [{ id: "local/model", inputModalities: ["text", "image"] }]; }, async run(context: RunContext) { context.onText("hello"); } };
void engine;
const controller = createNativeSessionController();
controller.configure({ cliApprovalMode: "ask", reasoningEffort: "high" });
// @ts-expect-error Approval policy is a closed contract, not arbitrary text.
controller.configure({ cliApprovalMode: "approve-everything" });
// @ts-expect-error SDK text callbacks cannot send an object into the UI stream.
const brokenEngine: EngineAdapter = { models: async () => [], run: async ({ onText }) => { onText({ text: "bad" }); } };
// @ts-expect-error Tool completion and tool start have different payloads.
const brokenTool: ToolEvent = { phase: "end", id: "t1", name: "write" };
// @ts-expect-error RPC identities are string or number, never arbitrary objects.
new RpcPeer(() => {}).notify({ id: { guessed: true } });
// @ts-expect-error Mount results must expose cleanup for event listeners/resources.
const brokenMount: MountedComponent = { host: document.createElement("span") };
function consumer(services: UiServices) {
  services.updateSettings({ threadId: "thread", cliApprovalMode: "deny" });
  // @ts-expect-error Creating a session requires an explicit workspace.
  services.createThread({ model: "local/model" });
  // @ts-expect-error UI settings must use a supported policy.
  const bad: SessionPreferences = { cliApprovalMode: false };
  return services.listModels();
}
void consumer;

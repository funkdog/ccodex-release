import type { HostActions, DrawerSlot } from "../../bridge/desktop-diy-contracts.mjs";
import type { SpineContext } from "../../gateway/spine/contracts.mjs";
import { SpineRegistry } from "../../gateway/spine/registry.mjs";
// @ts-expect-error Native actions acknowledge asynchronously; no invented send operation.
const invalidActions: HostActions = { openThread() {}, prefillDraft() {}, injectText() {} };
// @ts-expect-error A mounted slot must provide deterministic cleanup.
const invalidSlot: DrawerSlot = { id: "example", label: "Example", mount: ({ document }) => ({ host: document.createElement("div") }) };
// @ts-expect-error Capability authority is a closed trusted-context contract.
const invalidContext: SpineContext = { authenticated: true, initialized: true, capabilities: new Set(["exec:write"]) };
function consumer(registry: SpineRegistry, context: SpineContext) {
  registry.dispatch("diy/spine/status", {}, context);
  // @ts-expect-error Trusted dispatch context cannot be supplied in caller JSON.
  registry.dispatch("diy/spine/status", {});
}
void consumer;

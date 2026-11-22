import type { SpineContext } from "../../gateway/spine/contracts.mjs";
import { SpineRegistry } from "../../gateway/spine/registry.mjs";
// @ts-expect-error Capability authority is a closed trusted-context contract.
const invalidContext: SpineContext = { authenticated: true, initialized: true, capabilities: new Set(["exec:write"]) };
function consumer(registry: SpineRegistry, context: SpineContext) {
  registry.dispatch("diy/spine/status", {}, context);
  // @ts-expect-error Trusted dispatch context cannot be supplied in caller JSON.
  registry.dispatch("diy/spine/status", {});
}
void consumer;

import type { SquadDeliverable, SquadSlotRound, SquadSlotStage } from "../../gateway/spine/squad-v2-contracts.mjs";
const delivery: SquadDeliverable = { kind: "mr", label: "repo!83", target: "https://git.example/repo/merge_requests/83" };
const round: SquadSlotRound = { round: 1, goal: "Outcome", touches: [], criteriaIds: ["C1"], dispatchedAt: 0, stage: "accepted", acceptedAt: 1, deliverables: [delivery] };
// @ts-expect-error A business acceptance stage is distinct from a worker's done receipt.
const invalidStage: SquadSlotStage = "done";
// @ts-expect-error Executable content is not a deliverable kind.
const invalidDelivery: SquadDeliverable = { kind: "script", label: "invalid" };
void round;

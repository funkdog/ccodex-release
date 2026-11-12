import type { EngineImage, ImageGenerationThreadItem } from "../../gateway/contracts.mjs";
import type { KnowledgeSource, MycodexKnowledgeCard } from "../../gateway/spine/knowledge-contracts.mjs";
// @ts-expect-error Inline images require a MIME type and encoded data.
const image: EngineImage = { kind: "blob", data: "encoded" };
// @ts-expect-error The standard gallery item requires its saved path and result.
const incomplete: ImageGenerationThreadItem = { type: "imageGeneration", id: "id", status: "completed" };
// @ts-expect-error MyCodex provenance uses producer kinds, not a legacy schema lane.
const oldSource: KnowledgeSource = { kind: "cat-cafe", uri: "cat-cafe://message/id" };
function consumer(card: MycodexKnowledgeCard) {
  card.sources[0].uri;
  // @ts-expect-error Legacy knowledge metadata is not the MyCodex contract.
  card.sourceRefs;
}
void consumer;

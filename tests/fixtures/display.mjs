import { randomUUID } from "node:crypto";
import { createDisplaySink } from "../../gateway/display-projector.mjs";
export function displayFixture(request = async () => ({ decision: "accept" })) {
  const turn = { id: randomUUID(), status: "inProgress", error: null, items: [] }, events = [], controller = new AbortController();
  const value = createDisplaySink({ turn, context: { threadId: "thread", turnId: turn.id }, signal: controller.signal,
    beforeItem() {}, save() {}, notify: (method, params) => events.push({ method, params }), request });
  return { ...value, turn, events, controller };
}

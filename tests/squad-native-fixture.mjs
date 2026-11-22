import { randomUUID } from "node:crypto";
import { createNativeHostPeer } from "../gateway/native-host-peer.mjs";
import { RpcPeer } from "../gateway/rpc-peer.mjs";

export async function attachSquadNative(t, f, { accountId = "squad-browser", holdTurns = false, beforeRequest } = {}) {
  const threads = new Map(), prompts = [];
  const turns = new Map();
  const request = async (method, p) => {
    await beforeRequest?.(method, p);
    if (method === "thread/start") { const thread = { id: randomUUID(), cwd: p.cwd, model: p.model ?? "native-model", status: { type: "idle" } }; threads.set(thread.id, thread); return { thread }; }
    if (method === "thread/list") return { data: [...threads.values()], nextCursor: null };
    if (method === "thread/loaded/list") return { data: [...threads.keys()] };
    if (method === "model/list") return { data: [{ id: "native-model", displayName: "Native Codex" }] };
    if (method === "thread/read" || method === "thread/resume") return { thread: threads.get(p.threadId) };
    if (method === "thread/turns/list") return { data: [...turns.values()].filter(turn => turn.threadId === p.threadId), nextCursor: null };
    if (method === "turn/start") {
      prompts.push(p); const turn = { id: randomUUID(), threadId: p.threadId, status: holdTurns ? "inProgress" : "completed", items: [] };
      turns.set(turn.id, turn); threads.get(p.threadId).status = { type: holdTurns ? "active" : "idle" }; return { turn };
    }
    throw new Error(method);
  };
  let native;
  native = new RpcPeer(message => queueMicrotask(() => native.receive({ id: message.id, result: { account: { type: "chatgpt", id: accountId } } })));
  const channel = createNativeHostPeer(f.config, native, id => f.gateway.protocol.store.threads.has(id), () => {}, { runExclusive: async (_id, run) => run(), squadRequest: request });
  t.after(() => channel.close()); await channel.start();
  return { threads, prompts, turns, close: () => channel.close(), create: async () => (await request("thread/start", { cwd: f.home })).thread,
    finish(turnId) { const turn = turns.get(turnId); turn.status = "completed"; threads.get(turn.threadId).status = { type: "idle" }; },
    async remove(id) { threads.delete(id); await channel.deleted(id); } };
}

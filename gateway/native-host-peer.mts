import type { Socket } from "node:net";
import { createHash, randomUUID } from "node:crypto";
import type { ConnectionConfig } from "./contracts.mjs";
import type { RpcPeer as NativePeer } from "./rpc-peer.mjs";
import { RpcPeer } from "./rpc-peer.mjs";
import { connectGateway, writeMessage } from "./ipc.mjs";
import { nativeHostToken } from "./spine-tokens.mjs";
import { parseHostRef } from "./spine/host-thread-contracts.mjs";
import fs from "node:fs";
import path from "node:path";
import type { HostDeliveryReceipt, HostThreadRef } from "./spine/host-thread-contracts.mjs";

const object = (value: unknown): Record<string, unknown> => {
  if (!value || typeof value !== "object" || Array.isArray(value)) throw new Error("Invalid native host response.");
  return value as Record<string, unknown>;
};
const digest = (value: string) => createHash("sha256").update(value).digest("hex");
async function accountIdentity(native: NativePeer, timeoutMs = 5000) {
  const response = object(await native.request("account/read", { refreshToken: false }, { timeoutMs }));
  const account = response.account == null ? null : object(response.account);
  const identity = account?.id ?? account?.email;
  return { accountId: digest(JSON.stringify([account?.type ?? "signed-out", typeof identity === "string" ? identity : null])), accountVerified: typeof identity === "string" && Boolean(identity) };
}

/** Reverse channel over the existing native peer. Delivery needs both a
 * frontend mutation guard and a fresh gateway authority confirmation. */
export function createNativeHostPeer(config: ConnectionConfig, native: NativePeer, ownsThread: (id: string) => unknown, warn: (message: string) => void = () => {},
  { runExclusive }: { runExclusive?: <T>(threadId: string, operation: () => Promise<T>) => Promise<T> } = {}) {
  const runtimeId = randomUUID(), hostId = `local:${digest(config.home).slice(0, 32)}`;
  let socket: Socket | undefined, peer: RpcPeer | undefined, stopped = false, starting: Promise<void> | undefined;
  let retryTimer: ReturnType<typeof setTimeout> | undefined, retry = 0, connected = false, warned = false;
  const reads = new Set<Promise<unknown>>();
  let identity: Awaited<ReturnType<typeof accountIdentity>> | undefined;
  const deliveries = new Map<string, { fingerprint: string; receipt: HostDeliveryReceipt }>();
  const deliver = async (p: Record<string, unknown>, ref: HostThreadRef, channel: RpcPeer) => {
    if (typeof p.requestId !== "string" || !/^[a-f0-9]{64}$/.test(p.requestId) || typeof p.message !== "string" || !p.message.trim() || Buffer.byteLength(p.message) > 16384 ||
      typeof p.workspace !== "string" || !path.isAbsolute(p.workspace) || p.workspace.length > 4096) throw new Error("Invalid host delivery.");
    const requestId = p.requestId, message = p.message, workspace = fs.realpathSync(p.workspace);
    const fingerprint = digest(JSON.stringify([ref.hostId, ref.accountId, ref.runtimeId, ref.threadId, message, workspace]));
    const previous = deliveries.get(requestId);
    if (previous && previous.fingerprint !== fingerprint) throw new Error("Delivery identity already binds a different action.");
    if (previous && !(previous.receipt.state === "not_sent" && previous.receipt.reason === "busy")) return previous.receipt;
    if (!previous && deliveries.size >= 256) return { ref, requestId, observedAt: new Date().toISOString(), state: "not_sent", reason: "receipt_capacity" };
    const entry = { fingerprint, receipt: { ref: structuredClone(ref), requestId, observedAt: new Date().toISOString(), state: "pending" } as HostDeliveryReceipt };
    deliveries.set(requestId, entry);
    const finish = (state: HostDeliveryReceipt["state"], fields: { reason?: string; turnId?: string } = {}) => {
      entry.receipt = { ref, requestId, state, observedAt: new Date().toISOString(), ...fields }; return entry.receipt;
    };
    let sent = false;
    if (!runExclusive) return finish("not_sent", { reason: "delivery_unavailable" });
    try {
      return await runExclusive(ref.threadId, async () => {
        const current = await accountIdentity(native);
        if (stopped || current.accountId !== identity?.accountId || ownsThread(ref.threadId)) return finish("not_sent", { reason: "binding_changed" });
        const response = object(await native.request("thread/read", { threadId: ref.threadId, includeTurns: false }, { timeoutMs: 5000 }));
        const thread = object(response.thread), state = typeof thread.status === "string" ? thread.status : (thread.status as Record<string, unknown> | undefined)?.type;
        if (thread.id !== ref.threadId) return finish("not_sent", { reason: "binding_changed" });
        if (state === "active") return finish("not_sent", { reason: "busy" });
        if (state !== "idle" || thread.archived === true || typeof thread.cwd !== "string") return finish("not_sent", { reason: "responsible_unavailable" });
        const cwd = fs.realpathSync(thread.cwd);
        if (cwd !== workspace && !cwd.startsWith(workspace + path.sep)) return finish("not_sent", { reason: "workspace_changed" });
        const confirmation = await channel.request<{ allowed: boolean }>("gateway/host/authorize", { requestId, ref, message, workspace }, { timeoutMs: 5000 });
        if (stopped || confirmation?.allowed !== true) return finish("not_sent", { reason: "authority_changed" });
        sent = true;
        const result = object(await native.request("turn/start", { threadId: ref.threadId, input: [{ type: "text", text: message }], clientUserMessageId: requestId }, { timeoutMs: 5000 }));
        const turn = object(result.turn);
        if (typeof turn.id !== "string" || !turn.id.length || turn.id.length > 128) return finish("unknown", { reason: "invalid_acceptance" });
        return finish("accepted", { turnId: turn.id });
      });
    } catch (cause) {
      return finish(sent ? "unknown" : "not_sent", { reason: (cause as { code?: string }).code === "MYCODEX_THREAD_BUSY" ? "busy" : sent ? "native_outcome_unknown" : "precondition_failed" });
    }
  };
  const handle = async (method: string, value: unknown, channel: RpcPeer) => {
    if (stopped || !identity || !["mycodex/host/read", "mycodex/host/result", "mycodex/host/deliver", "mycodex/host/receipt"].includes(method)) throw new Error("Native host operation unavailable.");
    const p = object(value), ref = parseHostRef(p.ref);
    const keys = method === "mycodex/host/read" ? ["ref"] : method === "mycodex/host/result" ? ["ref", "turnId", "offset"] : method === "mycodex/host/deliver" ? ["ref", "requestId", "message", "workspace"] : ["ref", "requestId"];
    if (Object.keys(p).some(key => !keys.includes(key)) ||
      ref.hostId !== hostId || ref.accountId !== identity.accountId || ref.runtimeId !== runtimeId || ownsThread(ref.threadId)) throw new Error("Native host target mismatch.");
    if (method === "mycodex/host/deliver") return deliver(p, ref, channel);
    const deadline = Date.now() + 6500;
    const remaining = () => {
      if (stopped || Date.now() >= deadline) throw new Error("Native host read cancelled or timed out.");
      return Math.max(1, Math.min(5000, deadline - Date.now()));
    };
    const current = await accountIdentity(native, remaining());
    if (current.accountId !== identity.accountId) throw new Error("Native account changed; rebind the host before reading.");
    if (method === "mycodex/host/receipt") {
      if (typeof p.requestId !== "string" || !/^[a-f0-9]{64}$/.test(p.requestId)) throw new Error("Invalid host receipt identity.");
      const entry = deliveries.get(p.requestId);
      if (entry && entry.receipt.ref.threadId !== ref.threadId) throw new Error("Receipt target mismatch.");
      return entry?.receipt ?? { ref, requestId: p.requestId, state: "not_found", observedAt: new Date().toISOString() };
    }
    if (method === "mycodex/host/result" && (typeof p.turnId !== "string" || !p.turnId.length || p.turnId.length > 128 || !Number.isSafeInteger(p.offset) || (p.offset as number) < 0)) throw new Error("Invalid native result range.");
    const response = object(await native.request("thread/read", { threadId: ref.threadId, includeTurns: false }, { timeoutMs: remaining() }));
    const thread = object(response.thread);
    if (thread.id !== ref.threadId) throw new Error("Native returned a different thread.");
    const observedAt = new Date().toISOString();
    if (method === "mycodex/host/read") return { ref, observedAt,
      title: typeof thread.name === "string" ? thread.name.slice(0, 300) : typeof thread.preview === "string" ? thread.preview.slice(0, 300) : "",
      cwd: typeof thread.cwd === "string" ? thread.cwd.slice(0, 4096) : "",
      status: typeof thread.status === "string" ? thread.status : thread.status && typeof thread.status === "object" && typeof (thread.status as Record<string, unknown>).type === "string" ? (thread.status as Record<string, unknown>).type : "unknown",
      archived: typeof thread.archived === "boolean" ? thread.archived : null };
    // New native stores do not implement includeTurns on thread/read. Use
    // their documented read-only pagination, with an explicit scan budget.
    let turn: Record<string, unknown> | undefined, cursor: string | undefined;
    const cursors = new Set<string>();
    for (let page = 0; page < 5; page++) {
      const history = object(await native.request("thread/turns/list", { threadId: ref.threadId, itemsView: "full", limit: 20, sortDirection: "desc", ...(cursor ? { cursor } : {}) }, { timeoutMs: remaining() }));
      if (!Array.isArray(history.data)) throw new Error("Invalid native turn page.");
      turn = history.data.find(value => value && typeof value === "object" && value.id === p.turnId);
      if (turn || history.nextCursor == null) break;
      if (typeof history.nextCursor !== "string" || !history.nextCursor.length || cursors.has(history.nextCursor)) throw new Error("Invalid native turn cursor.");
      cursor = history.nextCursor; cursors.add(cursor);
    }
    if (!turn || !Array.isArray(turn.items)) throw new Error("Native turn result is unavailable within the read budget; no cached summary was substituted.");
    const text = turn.items.filter((item: Record<string, unknown>) => item?.type === "agentMessage" && typeof item.text === "string").map((item: Record<string, unknown>) => item.text as string).join("\n\n");
    const offset = p.offset as number;
    if (offset > text.length) throw new Error("Result offset exceeds current content.");
    let end = Math.min(offset + 8192, text.length);
    if (end < text.length && /[\uD800-\uDBFF]/.test(text[end - 1])) end--;
    return { ref, observedAt, turnId: p.turnId, status: typeof turn.status === "string" ? turn.status : "unknown", text: text.slice(offset, end), offset, nextOffset: end < text.length ? end : null };
  };
  const schedule = () => {
    if (stopped || native.closed || retryTimer) return;
    retryTimer = setTimeout(() => { retryTimer = undefined; void start(); }, Math.min(30000, 250 * 2 ** Math.min(retry++, 7)));
    retryTimer.unref();
  };
  const start = (): Promise<void> | undefined => {
    if (starting || stopped || connected) return starting;
    let channel: RpcPeer | undefined, channelSocket: Socket | undefined;
    starting = (async () => {
      try {
        identity = await accountIdentity(native);
        if (stopped) return;
        channel = new RpcPeer(message => writeMessage(channelSocket!, message)); peer = channel;
        const currentChannel = channel;
        currentChannel.onRequest = message => {
          if (reads.size >= 8) { currentChannel.notify({ id: message.id, error: { code: -32000, message: "Native host read budget exhausted." } }); return; }
          const reading = handle(message.method!, message.params, currentChannel).then(result => {
            if (!stopped && !currentChannel.closed) currentChannel.notify({ id: message.id, result });
          }, () => {
            if (!stopped && !currentChannel.closed) currentChannel.notify({ id: message.id, error: { code: -32000, message: "Native host operation failed; reconcile any delivery before retrying." } });
          }).catch(() => { channelSocket?.destroy(); currentChannel.close(); }).finally(() => { reads.delete(reading); });
          reads.add(reading);
        };
        channelSocket = await connectGateway({ ...config, token: nativeHostToken(config.token, config.generation) }, message => currentChannel.receive(message)); socket = channelSocket;
        channelSocket.once("close", () => { currentChannel.close(); if (peer === currentChannel) connected = false; schedule(); });
        if (stopped) { channelSocket.destroy(); currentChannel.close(); return; }
        await currentChannel.request("initialize", { clientInfo: { name: "mycodex_native_host", version: "1" } }, { timeoutMs: 5000 });
        await currentChannel.request("gateway/host/register", { runtimeId, hostId, ...identity, canDeliver: Boolean(runExclusive) }, { timeoutMs: 5000 });
        connected = true; retry = 0; warned = false;
      } catch {
        if (!stopped && !native.closed && !warned) { warned = true; warn("Native host channel unavailable; conversation routing continues and delivery receipts await reconnection."); }
        channelSocket?.destroy(); channel?.close(); schedule();
      }
    })().finally(() => { starting = undefined; });
    return starting;
  };
  return { start, async close() { stopped = true; clearTimeout(retryTimer); socket?.destroy(); peer?.close(); await starting; await Promise.allSettled([...reads]); socket?.destroy(); peer?.close(); } };
}

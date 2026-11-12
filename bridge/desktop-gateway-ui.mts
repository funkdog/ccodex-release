import "../tools/typescript-runtime.mjs";
import type { Socket } from "node:net";
import type { ConnectionConfig } from "../gateway/contracts.mjs";
import type { CdpTarget, CdpEvent, CdpSession, CdpSessions } from "./desktop-host-contracts.mjs";
import fs from "node:fs";
import path from "node:path";
import { randomUUID } from "node:crypto";
import { pathToFileURL } from "node:url";
import { connectCdp, CdpTargetSessions } from "./desktop-cdp.mjs";
import { readProcessIdentity, sameProcessLifetime, desktopEndpointOwner } from "./desktop-process.mjs";
import { inspectCurrentHost } from "./desktop-current-host.mjs";
import { createCliSelectorServices } from "./desktop-cli-selector.mjs";
import { buildNativeSessionsPatch } from "./desktop-native-composer.mjs";
import { readRoutingConnection } from "../gateway/routed-stdio.mjs";
import { RpcPeer } from "../gateway/rpc-peer.mjs";
import { connectGateway, writeMessage } from "../gateway/ipc.mjs";
import { buildSpinePatch } from "./desktop-spine-ui.mjs";
import { boundedJson, DIY_REQUEST_BYTES, DIY_RESPONSE_BYTES } from "../gateway/spine/registry.mjs";
import { createUiHealthPublisher, type UiComponentHealth } from "./desktop-ui-health.mjs";

export interface GatewayUiRequest { id: string; method: string; params: Record<string, unknown> }
export function assertGatewayUiConfiguration(config: Pick<ConnectionConfig, "generation" | "configGeneration" | "frontend">, configurationGeneration: unknown) {
  // Launch receipts bind the selected configuration. The gateway may retain
  // its original transport generation after an authorized CLI-only addition;
  // connectGateway must continue authenticating with that original value.
  if (typeof configurationGeneration !== "string" || !configurationGeneration ||
      (config.configGeneration ?? config.generation) !== configurationGeneration || config.frontend !== "routed-stdio.mjs")
    throw new Error("UI helper requires its matching routed gateway.");
}
export function parseGatewayUiRequest(payload: string): GatewayUiRequest {
  if (Buffer.byteLength(payload) > DIY_REQUEST_BYTES) throw new Error("UI request exceeds limit.");
  const value: unknown = JSON.parse(payload);
  boundedJson(value, DIY_REQUEST_BYTES);
  if (!value || typeof value !== "object" || Array.isArray(value)) throw new Error("Invalid UI request.");
  const p = value as Record<string, unknown>;
  if (Object.keys(p).some(key => !["id", "method", "params"].includes(key)) || typeof p.id !== "string" || !p.id.length || p.id.length > 128 || typeof p.method !== "string" ||
    !(["listModels", "refreshModels", "listThreads", "updateSettings", "setApprovalDefault"].includes(p.method) || /^diy\/[a-z][a-z0-9_-]*\/[a-z][a-z0-9_-]*$/.test(p.method)) ||
    (p.params !== undefined && (!p.params || typeof p.params !== "object" || Array.isArray(p.params)))) throw new Error("Invalid or unapproved UI method.");
  return { id: p.id, method: p.method, params: (p.params ?? {}) as Record<string, unknown> };
}

/** Only discovery/binding reconciliation is retryable. User RPCs are handled
 * separately below and are never replayed by this watcher. Check the host
 * lifetime before every attempt; permission/contract failures still stop it. */
export async function watchGatewayUi({ active, assertHost, update, wait = () => new Promise<void>(resolve => setTimeout(resolve, 2000)),
  warn = (message: string) => console.error(message), onTransient = () => {} }: { active: () => boolean; assertHost: () => void; update: () => Promise<void>;
    wait?: () => Promise<void>; warn?: (message: string) => void; onTransient?: () => void }) {
  let lastWarning: string | null = null;
  while (active()) {
    try { assertHost(); await update(); lastWarning = null; }
    catch (cause) {
      const error = cause instanceof Error ? cause : new Error(String(cause));
      const probe = error as NodeJS.ErrnoException & { path?: string; syscall?: string };
      const identityTimeout = probe.code === "ETIMEDOUT" && ["/usr/sbin/lsof", "/bin/ps"].includes(probe.path ?? "") &&
        probe.syscall === `spawnSync ${probe.path}`;
      const transient = identityTimeout || ["AbortError", "TimeoutError"].includes(error.name) ||
        (error instanceof TypeError && error.message === "fetch failed") ||
        /^CDP (?:.+ timeout|connection .+|socket error)$/.test(error.message) ||
        /^(?:Execution context was destroyed|Cannot find context with specified id|Inspected target navigated)/.test(error.message);
      if (!transient) throw error;
      onTransient();
      if (error.message !== lastWarning) warn(`MyCodex UI 暂时不可用，将重试页面绑定：${error.message}`);
      lastWarning = error.message;
    }
    if (active()) await wait();
  }
}

export async function runGatewayUi(receiptFile: string) {
  const stat = fs.lstatSync(receiptFile);
  if (!stat.isFile() || stat.isSymbolicLink() || stat.size > 256 * 1024 || (stat.mode & 0o077)) throw new Error("Invalid private current-host receipt.");
  const receipt = JSON.parse(fs.readFileSync(receiptFile, "utf8"));
  const report = createUiHealthPublisher(receiptFile, receipt);
  // Status reporting must never prevent otherwise healthy routing or bindings.
  const health = (state: Parameters<typeof report>[0], components?: UiComponentHealth) => { try { report(state, components); } catch {} };
  health("pending");
  const host = inspectCurrentHost(receipt.application);
  if (host.executable !== receipt.identity?.executable || host.archiveSha256 !== receipt.archiveSha256 || host.cliSha256 !== receipt.cliSha256 ||
      !Number.isInteger(receipt.port) || receipt.port < 1024 || receipt.port > 65535) throw new Error("UI helper contract differs from its prepared installation.");
  const assertHost = () => {
    if (!sameProcessLifetime(receipt.identity, readProcessIdentity(receipt.identity.pid)) ||
        (desktopEndpointOwner as unknown as (port: number, options: { pid: number }) => number | null)(receipt.port, { pid: receipt.identity.pid }) !== receipt.identity.pid) throw new Error("UI helper no longer owns this app lifetime and debugging endpoint.");
  };
  // The watcher validates this before every renderer operation, including the
  // first bind. Keep startup probes in that retry boundary too; a timed-out
  // process inspection must not retire the helper or authorize a UI operation.
  const config = readRoutingConnection(receipt.connectionFile);
  assertGatewayUiConfiguration(config, receipt.generation);
  let socket!: Socket;
  const peer = new RpcPeer(message => writeMessage(socket, message));
  socket = await connectGateway(config, message => peer.receive(message));
  socket.on("close", () => peer.close());
  const sessions = new CdpTargetSessions() as unknown as CdpSessions;
  const services = createCliSelectorServices((method, params) => peer.request(method, params,
    { timeoutMs: ["model/list", "gateway/models/refresh"].includes(method) ? 45000 : 15000 }));
  let stopping = false, bindingReported = false;
  const activityTargets = new Map<string, { session: CdpSession; contexts: Set<number>; event: string }>();
  peer.onNotification = message => {
    if (message.method !== "diy/spine/changed" || stopping) return;
    try { boundedJson(message.params, DIY_REQUEST_BYTES); assertHost(); } catch { return; }
    for (const target of activityTargets.values()) for (const contextId of target.contexts) {
      if (!target.session.active) continue;
      target.session.send("Runtime.evaluate", { contextId, expression: `globalThis.dispatchEvent(new CustomEvent(${JSON.stringify(target.event)}, {detail:${JSON.stringify(message.params)}}))`, returnByValue: true }).catch(() => {});
    }
  };
  const stop = () => { stopping = true; };
  process.once("SIGTERM", stop); process.once("SIGINT", stop);
  try {
    await peer.request("initialize", { clientInfo: { name: "mycodex_selector", version: "0.1" } }, { timeoutMs: 5000 });
    peer.notify({ method: "initialized" });
    await watchGatewayUi({ active: () => !stopping && !peer.closed, assertHost, onTransient: () => health("retrying"), update: async () => {
      const response = await fetch(`http://127.0.0.1:${receipt.port}/json/list`, { signal: AbortSignal.timeout(5000), redirect: "error" });
      if (!response.ok) throw new Error("Current-host renderer catalog is unavailable.");
      const targets = (await response.json() as CdpTarget[]).filter(target => target.type === "page" && String(target.url).startsWith("app://-/"));
      sessions.retain(targets);
      let ready = false;
      const components: UiComponentHealth = { nativeSessions: "pending", workbench: config.spine ? "pending" : "disabled" };
      for (const target of targets) {
        const endpoint = new URL(target.webSocketDebuggerUrl);
        if (endpoint.protocol !== "ws:" || !["127.0.0.1", "localhost"].includes(endpoint.hostname) || Number(endpoint.port) !== receipt.port || endpoint.username || endpoint.password) throw new Error("Unexpected renderer endpoint.");
        let session = sessions.get(target.id);
        if (!session) {
          const binding = `__mycodexSelector_${randomUUID().replaceAll("-", "")}`;
          const responseEvent = `${binding}_response`;
          const contexts = new Set<number>();
          let mainFrame: string;
          const inFlight = new Set();
          session = await (connectCdp as unknown as (url: string, options: { onEvent: (message: CdpEvent) => Promise<void> }) => Promise<CdpSession>)(target.webSocketDebuggerUrl, { onEvent: async message => {
            if (message.method === "Runtime.executionContextCreated") {
              const context = message.params.context;
              if (context.auxData?.isDefault && context.auxData.frameId === mainFrame) contexts.add(context.id);
            } else if (message.method === "Runtime.executionContextDestroyed") contexts.delete(message.params.executionContextId);
            else if (message.method === "Runtime.executionContextsCleared") contexts.clear();
            else if (message.method === "Runtime.bindingCalled" && message.params.name === binding && contexts.has(message.params.executionContextId)) {
              let request: GatewayUiRequest | undefined;
              try {
                assertHost();
                if (inFlight.size >= 8) return;
                request = parseGatewayUiRequest(message.params.payload);
                if (inFlight.has(request.id)) return;
                inFlight.add(request.id);
                let result, error;
                try {
                  if (request.method.startsWith("diy/")) result = await peer.request(request.method, request.params, { timeoutMs: /^diy\/(?:work\/(?:dispatch|handoff|integrate)|goals\/plan)$/.test(request.method) ? 120000 : 15000 });
                  else if (request.method === "listModels") result = await services.listModels();
                  else if (request.method === "refreshModels") result = await services.refreshModels!();
                  else if (request.method === "setApprovalDefault") {
                    const p = request.params;
                    if (Object.keys(p).some(key => !["model", "cliApprovalMode"].includes(key)) || typeof p.model !== "string" ||
                        !["ask", "read-only", "auto", "deny"].includes(String(p.cliApprovalMode))) throw new Error("Invalid CLI approval preference.");
                    result = await services.setApprovalDefault!(p as { model: string; cliApprovalMode: import("../gateway/contracts.mjs").ApprovalMode });
                  }
                  else if (request.method === "listThreads") {
                    if (request.params.cursor != null && typeof request.params.cursor !== "string") throw new Error("Invalid thread cursor.");
                    result = await services.listThreads({ cursor: request.params.cursor as string | null | undefined });
                  } else {
                    const p = request.params;
                    if (typeof p.threadId !== "string" || (p.model !== undefined && typeof p.model !== "string") ||
                        (p.reasoningEffort != null && typeof p.reasoningEffort !== "string") ||
                        (p.cliApprovalMode !== undefined && !["ask", "read-only", "auto", "deny"].includes(String(p.cliApprovalMode)))) throw new Error("Invalid settings.");
                    result = await services.updateSettings(p as unknown as import("./desktop-diy-contracts.mjs").CliSettingsUpdate);
                  }
                  boundedJson(result, DIY_RESPONSE_BYTES);
                } catch (cause) { result = undefined; error = (cause instanceof Error ? cause.message : String(cause)).slice(0, 2048); }
                assertHost();
                if (!session!.active || !contexts.has(message.params.executionContextId)) return;
                await session!.send("Runtime.evaluate", { contextId: message.params.executionContextId,
                  expression: `globalThis.dispatchEvent(new CustomEvent(${JSON.stringify(responseEvent)}, {detail:${JSON.stringify({ id: request.id, result, error })}}))`, returnByValue: true });
              } catch { /* Lost renderer responses are never retried as operations. */ }
              finally { if (request?.id) inFlight.delete(request.id); }
            }
          } });
          mainFrame = (await session!.send("Page.getFrameTree")).frameTree!.frame.id;
          await session!.send("Runtime.enable");
          await session!.send("Runtime.addBinding", { name: binding });
          // Mount the workbench before awaiting the independent native model
          // controls. Lazy host modules must not hold back goals and work.
          session.selectorPatch = `(async()=>{const workbench=${config.spine ? buildSpinePatch(binding, responseEvent, config.spine.ui?.rightOffset) : '"disabled"'};
            const nativeSessions=await (${buildNativeSessionsPatch(binding, responseEvent)});
            return {nativeSessions,workbench};})()`;
          activityTargets.set(target.id, { session, contexts, event: responseEvent + "_activity" });
          sessions.set(target.id, session);
        }
        const installed = await session!.send("Runtime.evaluate", { expression: session.selectorPatch, returnByValue: true, awaitPromise: true });
        if (installed.exceptionDetails) throw new Error(`Native session integration: ${installed.exceptionDetails.exception?.description || installed.exceptionDetails.text}`);
        const value = installed.result?.value as UiComponentHealth | undefined;
        if (value?.nativeSessions === "active" && (!config.spine || value.workbench === "active")) ready = true;
        for (const key of ["nativeSessions", "workbench"] as const) {
          const state = value?.[key];
          if (state === "active" || components[key] !== "active" && state === "unavailable") components[key] = state;
        }
        if (!bindingReported && components.workbench === "active") {
          bindingReported = true;
          console.error("MyCodex 工作台已接入当前窗口。");
        }
      }
      health(ready ? "ready" : "pending", components);
    } });
  } finally {
    health("unavailable");
    for (const session of sessions.sessions.values()) {
      try { await session.evaluate("globalThis.__mycodexSpine?.dispose();globalThis.__mycodexNativeSessions?.dispose()"); } catch {}
    }
    sessions.close(); socket.destroy(); peer.close();
    activityTargets.clear();
    process.off("SIGTERM", stop); process.off("SIGINT", stop);
  }
}

if (process.argv[1] && import.meta.url === pathToFileURL(path.resolve(process.argv[1])).href) {
  // This process only owns read-only UI bindings. All cleanup has completed
  // when runGatewayUi settles; do not keep it alive for a CDP close handshake.
  runGatewayUi(process.argv[2]).then(() => process.exit(0), error => {
    console.error(`MyCodex selector: ${error.message}`); process.exit(1);
  });
}

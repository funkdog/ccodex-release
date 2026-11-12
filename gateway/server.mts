import "../tools/typescript-runtime.mjs";
import { assertTypeScriptBuild } from "../tools/typescript-state.mjs";
import type { EngineAdapter, GatewayConnection } from "./contracts.mjs";
import fs from "node:fs";
import path from "node:path";
import net from "node:net";
import { pathToFileURL } from "node:url";
import { ThreadStore } from "./state.mjs";
import { GatewayProtocol } from "./protocol.mjs";
import { attachConnection } from "./ipc.mjs";
import type { SpineRegistry } from "./spine/registry.mjs";
import type { Capability } from "./spine/contracts.mjs";
import type { SpineRuntimeOptions } from "./spine/contracts.mjs";
import { nativeTraceToken, nativeHostToken } from "./spine-tokens.mjs";
import type { ResolveDispatchAuthority, VerifyDispatchResources } from "./spine/work-dispatch-contracts.mjs";

assertTypeScriptBuild(path.resolve(import.meta.dirname, ".."));

export async function startGateway({ home, endpoint, token, generation, runtimeGeneration, engines, defaultEngine, idleTimeoutMs = 0, onIdle, onRetire, spine: spineOptions, workbench = true, dispatchAuthority, verifyDispatchResources }: { home: string; endpoint: string; token: string; generation: string; runtimeGeneration?: string; engines: Map<string, EngineAdapter>; defaultEngine: string | null; idleTimeoutMs?: number; onIdle?: () => void; onRetire?: () => void; spine?: SpineRuntimeOptions; workbench?: boolean; dispatchAuthority?: ResolveDispatchAuthority; verifyDispatchResources?: VerifyDispatchResources }) {
  if (typeof workbench !== "boolean" || (!workbench && spineOptions !== undefined)) throw new Error("Invalid workbench configuration.");
  const connections = new Set<GatewayConnection & { socket: net.Socket }>();
  const spineChanged = (kind: string) => { for (const connection of connections) if (connection.initialized && connection.role === "default") { try { connection.send({ method: "diy/spine/changed", params: { kind, at: Date.now(), activeTasks: spine?.activeTasks ?? 0 } }); } catch { connection.socket.destroy(); } } };
  let protocol!: GatewayProtocol;
  let spine: SpineRegistry | undefined;
  let host: import("./host-threads.mjs").HostThreadBroker | undefined;
  let work: import("./spine/work-service.mjs").WorkService | undefined;
  let dispatch: import("./spine/work-dispatch.mjs").WorkDispatchService | undefined;
  const spineCapabilities = new Set<Capability>(["status:read", "logs:read", "radar:read", "radar:write", "daily:read", "vault:write", "host:read", "work:read", "work:write"]);
  let closing = false;
  let retiring = false;
  let workspaceDiagnostic: string | undefined;
  let idleTimer: ReturnType<typeof setTimeout> | undefined;
  const idle = () => {
    clearTimeout(idleTimer);
    if (closing || !idleTimeoutMs || connections.size) return;
    idleTimer = setTimeout(() => {
      if (spine?.activeTasks || spine?.backgroundActivities || protocol.active.size || protocol.pendingMaintenance.size || [...engines.values()].some(engine => engine.activeRequests)) idle();
      else onIdle?.();
    }, idleTimeoutMs);
    idleTimer.unref();
  };
  const server = net.createServer(socket => {
    clearTimeout(idleTimer);
    const connection = attachConnection(socket, { token, generation, traceToken: nativeTraceToken(token, generation), hostToken: nativeHostToken(token, generation),
      handle: (method, params, connection) => {
        if (method === "gateway/retireIfIdle") {
          const p = params as unknown as Record<string, unknown>;
          if (connection.role !== "default" || !connection.initialized || !onRetire ||
              Object.keys(p).some(key => !["expectedPid", "expectedRuntimeGeneration"].includes(key)) ||
              p.expectedPid !== process.pid || p.expectedRuntimeGeneration !== runtimeGeneration)
            return Promise.reject(new Error("Gateway retirement identity was not verified."));
          if (closing || retiring || spine?.activeTasks || spine?.backgroundActivities ||
              protocol.active.size || protocol.pendingMaintenance.size ||
              [...engines.values()].some(engine => engine.activeRequests) ||
              [...connections].some(item => item.role === "native-host" || (item.inFlight ?? 0) > (item === connection ? 1 : 0)))
            return Promise.resolve({ retiring: false, reason: "busy" });
          retiring = true;
          return Promise.resolve({ retiring: true });
        }
        if (retiring) return Promise.reject(new Error("Gateway is retiring; reconnect to the new instance."));
        if (connection.role === "native-trace" && !["initialize", "diy/trace/record"].includes(method)) return Promise.reject(new Error("Native trace channel cannot perform conversation or plugin operations."));
        if (connection.role === "native-host") {
          if (method === "initialize") return Promise.resolve({});
          if (method === "gateway/host/register" && host) return Promise.resolve(host.register(params as unknown as Record<string, unknown>, connection));
          if (method === "gateway/host/authorize" && dispatch) {
            const p = params as unknown as Record<string, unknown>;
            if (Object.keys(p).some(key => !["requestId", "ref", "message", "workspace"].includes(key)) || typeof p.requestId !== "string" || typeof p.message !== "string" || typeof p.workspace !== "string") return Promise.reject(new Error("Invalid delivery confirmation."));
            if (!host?.ownsConnection(connection, p.ref)) return Promise.resolve({ allowed: false });
            return dispatch.confirm(p.requestId, p.ref as import("./spine/host-thread-contracts.mjs").HostThreadRef, { message: p.message, workspace: p.workspace });
          }
          return Promise.reject(new Error("Native host channel cannot perform conversation or plugin operations."));
        }
        // Bounded workspace metadata only: never log prompts, attachments,
        // tokens or the full request. Native main-process creates do not pass
        // through the renderer hooks; diagnose the actual IPC envelope here.
        if (method === "thread/start" && params.runtimeWorkspaceRoots != null) {
          const roots: unknown = params.runtimeWorkspaceRoots;
          const diagnostic = JSON.stringify({ method, cwd: typeof params.cwd === "string" ? params.cwd.slice(0, 512) : null,
            rootCount: Array.isArray(roots) ? roots.length : null,
            roots: Array.isArray(roots) ? roots.slice(0, 8).map(root => typeof root === "string" ? root.slice(0, 512) : typeof root) : typeof roots });
          if (diagnostic !== workspaceDiagnostic) { workspaceDiagnostic = diagnostic; console.error(`MyCodex workspace envelope: ${diagnostic}`); }
        }
        if (method.startsWith("diy/")) {
          if (!spine) return Promise.reject(new Error("Spine is unavailable; existing session routing remains available."));
          return spine.dispatch(method, params, {
          authenticated: true, initialized: connection.initialized, capabilities: connection.role === "native-trace" ? new Set<Capability>(["trace:write"]) : spineCapabilities,
          });
        }
        return protocol.handle(method, params, connection);
      },
      afterReply: (method, result) => { if (method === "gateway/retireIfIdle" && (result as { retiring?: boolean })?.retiring) onRetire?.(); },
      onClose: connection => { host?.disconnect(connection); connections.delete(connection as GatewayConnection & { socket: net.Socket }); idle(); } }) as GatewayConnection & { socket: net.Socket };
    connection.socket = socket;
    connections.add(connection);
  });
  // Owning the single stable instance socket precedes all persistence writes.
  await new Promise<void>((resolve, reject) => { server.once("error", reject); server.listen(endpoint, resolve); });
  const started: EngineAdapter[] = [];
  try {
    fs.chmodSync(endpoint, 0o600);
    const store = new ThreadStore(path.join(home, "gateway", "threads"));
    protocol = new GatewayProtocol({ store, engines, defaultEngine, home, allowEmptyCatalog: !workbench,
      notify: (method, params) => {
        for (const connection of connections) if (connection.initialized) {
          try { connection.send({ method, params }); } catch { connection.socket.destroy(); }
        }
      } });
    for (const engine of engines.values()) if (engine.start) { await engine.start({ token }); started.push(engine); }
    if (workbench) try {
      const { SpineRegistry } = await import("./spine/registry.mjs");
      const registry = spine = new SpineRegistry(home, { onActivity: () => { idle(); spineChanged("activity"); } });
      await registry.installModule("kernel", async () => {
        const { installSpineModules } = await import("./spine/kernel.mjs");
        await installSpineModules(registry, home, () => store.all(), spineOptions, spineChanged);
      });
      host = await registry.installModule("host", async scope => {
        const { HostThreadBroker, parseHostRef } = await import("./host-threads.mjs");
        const service = new HostThreadBroker();
        scope.register("diy/host/status", "host:read", p => { if (Object.keys(p).length) throw new Error("Host status takes no parameters."); return service.status(); });
        scope.register("diy/host/read", "host:read", (p, context) => {
          if (Object.keys(p).some(key => key !== "ref")) throw new Error("Invalid host read parameters.");
          return service.read(parseHostRef(p.ref), context.signal);
        });
        scope.register("diy/host/result", "host:read", (p, context) => {
          if (Object.keys(p).some(key => !["ref", "turnId", "offset"].includes(key))) throw new Error("Invalid host result parameters.");
          return service.result(parseHostRef(p.ref), p.turnId as string, p.offset as number | undefined, context.signal);
        });
        return service;
      });
      work = await registry.installModule("work", async scope => {
        const { WorkService } = await import("./spine/work-service.mjs");
        const service = new WorkService(home, registry, protocol, () => spineChanged("work"));
        scope.register("diy/goals/list", "work:read", p => {
          if (Object.keys(p).length) throw new Error("Goals list takes no parameters.");
          return service.listGoals();
        });
        scope.register("diy/goals/upsert", "work:write", p => service.upsertGoal(p));
        scope.register("diy/goals/plan", "work:write", p => service.planGoal(p));
        scope.register("diy/work/list", "work:read", p => service.listWorkItems(p));
        scope.register("diy/work/get", "work:read", p => service.getWorkItem(p));
        scope.register("diy/work/upsert", "work:write", p => service.upsertWorkItem(p));
        scope.register("diy/work/shared_list", "work:read", p => service.listSharedWork(p));
        scope.register("diy/work/record", "work:write", p => service.upsertSharedWork(p));
        scope.register("diy/work/context", "work:read", p => service.readWorkContext(p));
        scope.register("diy/work/dispatch", "work:write", p => service.dispatchSquad(p));
        scope.register("diy/work/handoff", "work:write", p => service.handoffMember(p));
        scope.register("diy/work/integrate", "work:write", p => service.integrateWorkItem(p));
        return service;
      });
      dispatch = await registry.installModule("dispatch", async scope => {
        if (!host) throw new Error("Native host module is unavailable.");
        const { WorkDispatchService } = await import("./spine/work-dispatch.mjs");
        const service = new WorkDispatchService(home, registry, host,
          typeof dispatchAuthority === "function" ? dispatchAuthority : (work ? request => work!.resolveAuthority(request) : undefined),
          typeof verifyDispatchResources === "function" ? verifyDispatchResources : (work ? authority => work!.verifyResources(authority) : undefined),
          () => spineChanged("reactions"));
        // Write actions remain in-process only until the owning WorkItem/Brief
        // service exists. Local credentials do not grant raw model dispatch.
        scope.register("diy/reactions/get", "work:read", p => {
          if (Object.keys(p).some(key => key !== "id") || typeof p.id !== "string") throw new Error("Invalid reaction read.");
          return service.get(p.id);
        });
        scope.register("diy/reactions/list", "work:read", p => {
          if (Object.keys(p).some(key => !["after", "limit"].includes(key))) throw new Error("Invalid reaction page.");
          return service.list(p as { after?: string; limit?: number });
        });
        await service.start(); return service;
      });
    } catch { console.error("MyCodex Spine is unavailable; optional data was preserved and session routing continues."); }
  } catch (cause) { const error = cause instanceof Error ? cause : new Error(String(cause)); for (const engine of started) await engine.close?.(); await new Promise<void>(resolve => server.close(() => resolve())); throw error; }
  idle();
  return { protocol, spine, work, dispatch, async close() {
    closing = true;
    clearTimeout(idleTimer);
    const dispatchClosed = dispatch?.close();
    const spineClosed = spine?.close();
    for (const connection of connections) connection.socket.destroy();
    await protocol.close();
    await spineClosed;
    await dispatchClosed;
    for (const engine of started) await engine.close?.();
    await new Promise<void>(resolve => server.close(() => resolve()));
  } };
}

if (process.argv[1] && import.meta.url === pathToFileURL(path.resolve(process.argv[1])).href) {
  try {
    const file = process.argv[2];
    const stat = fs.lstatSync(file);
    if (!stat.isFile() || stat.isSymbolicLink() || stat.size > 256 * 1024) throw new Error("Invalid private gateway launch file.");
    const config = JSON.parse(fs.readFileSync(file, "utf8"));
    const { createEngines } = await import("./engines/index.mjs");
    const engines = await createEngines(config.engines, { requireSelection: config.workbench === false });
    const gateway = await startGateway({ ...config, engines, idleTimeoutMs: 60000, onIdle: () => close(), onRetire: () => close() });
    process.send?.({ ready: true });
    let closing = false;
    const close = async () => {
      if (closing) return;
      closing = true;
      await gateway.close();
      process.exit(0);
    };
    process.on("SIGTERM", close);
    process.on("SIGINT", close);
  } catch (cause) { const error = cause instanceof Error ? cause : new Error(String(cause)); console.error(`Gateway startup failed: ${error.message}`); process.exitCode = 1; }
}

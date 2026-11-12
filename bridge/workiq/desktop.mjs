import { randomUUID } from "node:crypto";
import { configure, publicStatus } from "./settings.mjs";
import { createIdentity, safeAuthError } from "./auth.mjs";
import { ActionQueue } from "./actions.mjs";
import { WorkIqUpstream } from "./transport.mjs";

export function createDesktopWorkIqHandler(profile, {
  identityFactory = createIdentity,
  actionQueue = new ActionQueue(profile),
  upstreamFactory = identity => new WorkIqUpstream(identity, profile),
} = {}) {
  const sessions = new Map();
  let currentSessionId = null;
  const publicSession = session => ({
    id: session.id,
    status: session.status,
    method: session.method,
    ...(session.code ? { userCode: session.code.userCode, verificationUri: session.code.verificationUri, expiresInSeconds: session.code.expiresIn } : {}),
    ...(session.authorization ? {
      authorizationUri: session.authorization.authorizationUri,
      expiresInSeconds: session.authorization.expiresInSeconds,
    } : {}),
    ...(session.error ? { error: session.error } : {}),
  });
  return async request => {
    if (!request || typeof request.operation !== "string") throw new Error("Invalid Work IQ Desktop request.");
    if (request.operation === "status") return publicStatus(profile);
    if (request.operation === "actions-list") return { actions: actionQueue.list() };
    if (request.operation === "action-show") return actionQueue.show(request.actionId);
    if (request.operation === "action-reject") return actionQueue.reject(request.actionId);
    if (request.operation === "action-approve") {
      if (request.confirmed !== true || typeof request.requestHash !== "string") throw new Error("Explicit action review is required.");
      const identity = await identityFactory(profile);
      const remote = upstreamFactory(identity);
      try {
        await remote.connect();
        return await actionQueue.approve(request.actionId, request.requestHash, params => remote.callTool(params));
      } finally { await remote.close(); }
    }
    if (request.operation === "enable") {
      if (request.acknowledge !== true) throw new Error("Explicit enterprise data-processing acknowledgement is required.");
      return configure({ profile, enable: true, acknowledge: true });
    }
    if (request.operation === "disable") return configure({ profile, enable: false });
    if (request.operation === "login-start") {
      const method = request.method || "authorization-code";
      if (!["authorization-code", "device-code"].includes(method)) throw new Error("Unsupported Work IQ sign-in method.");
      const status = publicStatus(profile);
      if (!status.runtimeInstalled) throw new Error("Run 'ccodex workiq install' once before signing in.");
      if (!status.configured) configure({ profile });
      const active = sessions.get(currentSessionId);
      if (active && ["starting", "pending"].includes(active.status)) return publicSession(active);
      const session = { id: randomUUID(), status: "starting", method, controller: new AbortController() };
      currentSessionId = session.id;
      sessions.set(session.id, session);
      // This flow is started only by the user's sign-in button. No external
      // browser, WAM window, admin-consent request, or content query is launched.
      session.done = (async () => {
        try {
          const identity = await identityFactory(profile);
          if (method === "authorization-code") {
            await identity.loginWithAuthorizationCode(address => {
              if (!session.controller.signal.aborted) {
                session.authorization = {
                  authorizationUri: address.authorizationUri,
                  expiresInSeconds: address.expiresInSeconds,
                };
                session.status = "pending";
              }
            }, { signal: session.controller.signal });
          } else {
            await identity.login(code => {
              if (!session.controller.signal.aborted) {
                session.code = { userCode: code.userCode, verificationUri: code.verificationUri, expiresIn: code.expiresIn };
                session.status = "pending";
              }
            }, { signal: session.controller.signal });
          }
          session.status = session.controller.signal.aborted ? "cancelled" : "complete";
        } catch (error) {
          session.status = session.controller.signal.aborted ? "cancelled" : "error";
          session.error = safeAuthError(error).message;
        } finally {
          session.code = null;
          session.authorization = null;
          const timer = setTimeout(() => sessions.delete(session.id), 5 * 60_000);
          timer.unref();
        }
      })();
      return publicSession(session);
    }
    if (["login-status", "login-cancel"].includes(request.operation)) {
      if (typeof request.sessionId !== "string") throw new Error("A Work IQ sign-in session ID is required.");
      const session = sessions.get(request.sessionId);
      if (!session) throw new Error("Work IQ sign-in session expired.");
      if (request.operation === "login-cancel" && ["starting", "pending"].includes(session.status)) {
        session.status = "cancelled";
        session.code = null;
        session.authorization = null;
        session.controller.abort();
      }
      return publicSession(session);
    }
    throw new Error("Unsupported Work IQ Desktop operation.");
  };
}

import { desktopEndpointOwner } from "./desktop-process.mjs";

export function windowsEndpointOwner(port) {
  return desktopEndpointOwner(port, { platform: "win32" });
}

export async function awaitDesktopRenderer({
  port,
  pid,
  timeoutMs = 30000,
  request = fetch,
  owner = port => desktopEndpointOwner(port, { pid }),
  isAlive = () => { try { process.kill(pid, 0); return true; } catch { return false; } },
  assertIdentity = () => {},
  pause = ms => new Promise(resolve => setTimeout(resolve, ms)),
  now = Date.now,
}) {
  if (!Number.isInteger(pid) || pid <= 0 ||
      !Number.isInteger(port) || port < 1024 || port > 65535 ||
      !Number.isFinite(timeoutMs) || timeoutMs <= 0) {
    throw new Error("Invalid Desktop readiness parameters.");
  }
  const deadline = now() + timeoutMs;
  while (now() < deadline) {
    if (!isAlive()) throw new Error("The new Desktop exited before its renderer was ready; no old instance was treated as success.");
    await assertIdentity();
    let targets;
    try {
      const response = await request(`http://127.0.0.1:${port}/json/list`,
        { signal: AbortSignal.timeout(1000), redirect: "error" });
      if (response.ok) targets = await response.json();
    } catch { /* A newly launched app has not opened its endpoint yet. */ }
    if (Array.isArray(targets)) {
      const target = targets.find(item => item.type === "page" &&
        String(item.url || "").startsWith("app://-/") &&
        typeof item.webSocketDebuggerUrl === "string");
      if (target) {
        const endpoint = new URL(target.webSocketDebuggerUrl);
        if (!["ws:", "wss:"].includes(endpoint.protocol) ||
            !["127.0.0.1", "localhost"].includes(endpoint.hostname) ||
            Number(endpoint.port) !== port || endpoint.username || endpoint.password) {
          throw new Error("Desktop renderer endpoint is not the expected private loopback endpoint.");
        }
        const actualOwner = await owner(port);
        if (actualOwner !== pid) throw new Error("Private Desktop endpoint belongs to another process; no extension was installed.");
        await assertIdentity();
        if (!isAlive()) throw new Error("The new Desktop exited during endpoint validation; no extension was installed.");
        return { pid, port, rendererVerified: true, endpointOwnerVerified: true,
          rendererId: target.id, rendererUrl: target.url };
      }
    }
    await pause(200);
  }
  throw new Error("The private Desktop renderer did not become ready; no running user process was stopped.");
}

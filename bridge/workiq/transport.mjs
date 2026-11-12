import { createHash } from "node:crypto";
import { runtimeImport } from "./dependencies.mjs";
import { ENDPOINT, RESOURCE_METADATA, KNOWN_TOOLS, atomicWrite, paths } from "./settings.mjs";

const MAX_METADATA_BYTES = 128 * 1024;

export async function discoverEndpoint({ fetchImpl = fetch } = {}) {
  const response = await fetchImpl(RESOURCE_METADATA, {
    redirect: "error",
    signal: AbortSignal.timeout(15_000),
    headers: { accept: "application/json" },
  });
  if (!response.ok) throw new Error(`Work IQ public discovery failed: HTTP ${response.status}.`);
  const body = await response.text();
  if (body.length > MAX_METADATA_BYTES) throw new Error("Work IQ discovery metadata exceeded the size limit.");
  const metadata = JSON.parse(body);
  if (metadata.resource !== ENDPOINT ||
      !Array.isArray(metadata.authorization_servers) ||
      metadata.authorization_servers.length === 0 ||
      !metadata.authorization_servers.every(value => {
        const url = new URL(value);
        return url.origin === "https://login.microsoftonline.com" && !url.username && !url.password;
      })) {
    throw new Error("Work IQ advertised an unexpected identity provider or resource; no credentials were sent.");
  }
  return metadata;
}

export function authorizedFetch(identity, { fetchImpl = fetch, endpoint = ENDPOINT } = {}) {
  const expected = new URL(endpoint);
  return async (input, init = {}) => {
    const url = new URL(typeof input === "string" || input instanceof URL ? input : input.url);
    if (url.origin !== expected.origin || url.pathname !== expected.pathname || url.username || url.password) {
      throw new Error("Work IQ rejected a cross-origin or unexpected credential destination.");
    }
    const token = await identity.token();
    const headers = new Headers(input instanceof Request ? input.headers : undefined);
    new Headers(init.headers).forEach((value, key) => headers.set(key, value));
    headers.set("authorization", `Bearer ${token}`);
    // No browser/auth-provider callback is supplied to the MCP SDK. A 401 is a
    // hard authentication failure, not a trigger to open a window or replay a write.
    return fetchImpl(input, { ...init, headers, redirect: "error" });
  };
}

export function capabilitySnapshot(tools, serverInfo, instructions = "", identityBindingSha256 = null) {
  const names = new Set(tools.map(tool => tool.name));
  return {
    schemaVersion: 2,
    observedAt: new Date().toISOString(),
    endpoint: ENDPOINT,
    identityBindingSha256,
    server: { name: serverInfo?.name || null, version: serverInfo?.version || null },
    tools: tools.map(tool => ({
      name: tool.name,
      readOnly: tool.annotations?.readOnlyHint === true,
      destructive: tool.annotations?.destructiveHint !== false,
      schemaSha256: createHash("sha256").update(JSON.stringify(tool.inputSchema || {})).digest("hex"),
    })),
    missingDocumentedTools: Object.keys(KNOWN_TOOLS).filter(name => !names.has(name)),
    instructionsSha256: createHash("sha256").update(instructions).digest("hex"),
    // tools/list proves availability, not successful data retrieval or mutations.
    enterpriseDataAccessVerified: false,
  };
}

export class WorkIqUpstream {
  constructor(identity, profile, { fetchImpl, clientFactory, transportFactory } = {}) {
    this.identity = identity;
    this.profile = profile;
    this.fetchImpl = fetchImpl;
    this.clientFactory = clientFactory;
    this.transportFactory = transportFactory;
    this.client = null;
    this.connecting = null;
    this.tools = [];
    this.instructions = "";
    this.capabilities = {};
  }

  async connect() {
    this.identity.assertCurrentSelection?.();
    if (this.client) return this;
    if (this.connecting) return this.connecting;
    this.connecting = this.open();
    try { return await this.connecting; }
    finally { this.connecting = null; }
  }

  async open() {
    await this.identity.token(); // Silent only. Fail before any service request if not signed in.
    const Client = this.clientFactory ||
      (await runtimeImport("@modelcontextprotocol/sdk/client/index.js", this.profile)).Client;
    const Transport = this.transportFactory ||
      (await runtimeImport("@modelcontextprotocol/sdk/client/streamableHttp.js", this.profile)).StreamableHTTPClientTransport;
    const client = new Client({ name: "ccodex-workiq", version: "0.1.0" }, {
      capabilities: {},
    });
    const transport = new Transport(new URL(ENDPOINT), {
      fetch: authorizedFetch(this.identity, { ...(this.fetchImpl ? { fetchImpl: this.fetchImpl } : {}) }),
      reconnectionOptions: {
        maxRetries: 0,
        initialReconnectionDelay: 1000,
        maxReconnectionDelay: 30_000,
        reconnectionDelayGrowFactor: 1.5,
      },
    });
    try {
      await client.connect(transport, { timeout: 30_000 });
      this.capabilities = client.getServerCapabilities() || {};
      this.instructions = client.getInstructions?.() || "";
      this.client = client;
      await this.listTools();
      return this;
    } catch (error) {
      this.client = null;
      await client.close().catch(() => {});
      throw error;
    }
  }

  async listTools() {
    if (!this.client) await this.connect();
    const binding = this.identity.bindingFingerprint?.() || null;
    const tools = [];
    const cursors = new Set();
    let cursor;
    do {
      const page = await this.client.listTools(cursor ? { cursor } : undefined, { timeout: 30_000 });
      if (!Array.isArray(page.tools)) throw new Error("Work IQ returned an invalid tool catalog.");
      tools.push(...page.tools);
      cursor = page.nextCursor;
      if (cursor && cursors.has(cursor)) throw new Error("Work IQ repeated a tool-list cursor.");
      if (cursor) cursors.add(cursor);
      if (cursors.size > 100 || tools.length > 10_000) throw new Error("Work IQ tool catalog exceeded the discovery bound.");
    } while (cursor);
    const names = new Set();
    for (const tool of tools) {
      if (typeof tool.name !== "string" || names.has(tool.name)) throw new Error("Work IQ returned duplicate or invalid tool names.");
      names.add(tool.name);
    }
    this.identity.assertCurrentSelection?.();
    this.tools = tools;
    atomicWrite(paths(this.profile).capabilities, `${JSON.stringify(capabilitySnapshot(tools, this.client.getServerVersion?.(), this.instructions, binding), null, 2)}\n`);
    return tools;
  }

  async callTool(params, { signal, onprogress } = {}) {
    await this.connect();
    if (!this.tools.some(tool => tool.name === params.name)) {
      await this.listTools();
      if (!this.tools.some(tool => tool.name === params.name)) throw new Error("The connected Work IQ service does not expose this tool.");
    }
    // The cloud tool contract, arguments, references, structured output and error
    // flags are preserved. Never convert upstream failures into fabricated answers.
    const result = await this.client.callTool(params, undefined, {
      timeout: 300_000,
      maxTotalTimeout: 900_000,
      resetTimeoutOnProgress: true,
      signal,
      onprogress: onprogress ? progress => {
        try { this.identity.assertCurrentSelection?.(); }
        catch { return; }
        onprogress(progress);
      } : undefined,
    });
    // Do not deliver another tenant's in-flight result into a newly selected
    // session. A write may already have happened; the action queue must keep
    // that outcome uncertain rather than replaying it with the new identity.
    this.identity.assertCurrentSelection?.();
    return result;
  }

  async close() {
    const client = this.client;
    this.client = null;
    if (client) await client.close();
  }
}

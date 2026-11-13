import "../tools/typescript-runtime.mjs";
import type { GoogleConfig, EngineAdapter, Model } from "./contracts.mjs";
import type { GoogleRequest, GoogleChunk, GooglePart } from "./sdk-contracts.mjs";
import type { SignatureStore, NativeModelRequest, GoogleOperationResult, GoogleWorkerParams, ChatTranslation } from "./google-contracts.mjs";
import type { RpcPeer } from "./rpc-peer.mjs";
import fs from "node:fs";
import path from "node:path";
import http from "node:http";
import { createHash, randomUUID, timingSafeEqual } from "node:crypto";
import { buildCatalog } from "../bridge/catalog.mjs";
import { buildChatRequest, createResponsesWriter, sendJson } from "../bridge/translate.mjs";
import { cliInput } from "./input.mjs";
import { startGeminiPeer, assertGeminiAccount } from "./engines/gemini-cli.mjs";

export const googleProviderId = "mycodex-google";
export const codexGooglePrefix = "mycodex/codex-gemini/";
export const googleProviderToken = (token: string) => createHash("sha256").update(`mycodex-google:${token}`).digest("hex");
export function googleProviderConfig({ cliHome, bridgePort }: Pick<GoogleConfig, "cliHome" | "bridgePort">) {
  if (!path.isAbsolute(cliHome || "") || !Number.isInteger(bridgePort) || bridgePort < 1024 || bridgePort > 65535) throw new Error("Codex + Gemini requires a private Google home and a loopback port.");
  return { [`model_providers.${googleProviderId}`]: { name: "Codex + Gemini（Google）",
    base_url: `http://127.0.0.1:${bridgePort}`, env_key: "MYCODEX_GOOGLE_TOKEN", wire_api: "responses",
    requires_openai_auth: false, request_max_retries: 0, stream_max_retries: 0, stream_idle_timeout_ms: 300000 },
    model_catalog_json: path.join(cliHome, "codex-models.json") };
}
export function googleProviderArguments(config: GoogleConfig) {
  return Object.entries(googleProviderConfig(config)[`model_providers.${googleProviderId}`]).flatMap(([key, value]) => ["-c", `model_providers.${googleProviderId}.${key}=${JSON.stringify(value)}`]);
}

export async function googleModelOperation(config: GoogleConfig, method: string, params: object = {}, { signal, onChunk = () => {}, env = process.env }: { signal?: AbortSignal; onChunk?: (chunk: GoogleChunk) => void; env?: NodeJS.ProcessEnv } = {}): Promise<GoogleOperationResult> {
  assertGeminiAccount(config.cliHome);
  const peer = await startGeminiPeer({ executable: path.join(import.meta.dirname, "google-model-worker.mjs"),
    cliHome: config.cliHome, env, args: [config.sdkPath] }) as unknown as RpcPeer<Partial<GoogleWorkerParams>, GoogleOperationResult> & { dispose(): Promise<void> };
  const id = randomUUID(); let timer;
  const abort = () => { if (!peer.closed) peer.notify({ method: "cancel", params: { requestId: id } }); timer ??= setTimeout(() => void peer.dispose(), 2000); };
  peer.onNotification = message => { if (message.method === "chunk" && message.params?.requestId === id) onChunk(message.params.chunk!); };
  try {
    signal?.addEventListener("abort", abort, { once: true });
    if (signal?.aborted) throw new Error("Google model operation cancelled.");
    const response = await peer.call({ id, method, params }, { timeoutMs: method === "model/list" ? 45000 : 300000 });
    if (response.error) throw new Error(response.error.message);
    return response.result!;
  } finally { signal?.removeEventListener("abort", abort); clearTimeout(timer); await peer.dispose(); }
}

const toolName = (name: string) => /^[a-zA-Z_][a-zA-Z0-9_]{0,62}$/.test(name) ? name : `tool_${createHash("sha256").update(name).digest("hex").slice(0,40)}`;

/** Signatures are opaque model state, committed before a tool call is exposed.
 * One private file per call keeps cold native resumes independent of a daemon. */
export function googleSignatureStore(cliHome: string): SignatureStore {
  const directory = path.join(cliHome, "native-tool-signatures");
  const file = (id: string) => path.join(directory, createHash("sha256").update(id).digest("hex") + ".json");
  return {
    put(id, value) {
      fs.mkdirSync(directory, { recursive: true, mode: 0o700 });
      if (fs.lstatSync(directory).isSymbolicLink()) throw new Error("Invalid Google signature directory.");
      const target = file(id), pending = `${target}.${randomUUID()}.tmp`;
      try { fs.writeFileSync(pending, JSON.stringify(value), { flag: "wx", mode: 0o600 }); fs.renameSync(pending, target); }
      finally { fs.rmSync(pending, { force: true }); }
    },
    get(id) {
      const target = file(id); if (!fs.existsSync(target)) return null;
      const stat = fs.lstatSync(target);
      if (!stat.isFile() || stat.isSymbolicLink() || stat.size > 256 * 1024 || (stat.mode & 0o077)) throw new Error("Invalid Google signature record.");
      return JSON.parse(fs.readFileSync(target, "utf8"));
    },
  };
}

export function buildGoogleRequest(request: NativeModelRequest, signatures: SignatureStore) {
  if (request.previous_response_id || (Array.isArray(request.input) && request.input.some(i => ["item_reference", "compaction"].includes(i.type)))) throw new Error("Google provider requires materialized native history; opaque references and remote compaction are unsupported.");
  if (request.reasoning?.effort && request.reasoning.effort !== "none") throw new Error("This Google provider uses Gemini's default thinking configuration; manual effort overrides are not yet supported.");
  const { body, toolKinds } = buildChatRequest(request, { id: request.model, capabilities: { supports: { vision: true } } }) as unknown as ChatTranslation;
  const contents: GoogleRequest["contents"] = [], instructions: string[] = [], calls = new Map<string, string>(), names = new Map<string, string>();
  const append = (role: string, parts: GooglePart[]) => {
    if (!parts.length) return;
    const last = contents.at(-1); if (last?.role === role) last.parts.push(...parts); else contents.push({ role, parts });
  };
  for (const message of body.messages) {
    if (message.role === "system") { instructions.push(message.content as string); continue; }
    if (message.role === "tool") {
      const name = calls.get(message.tool_call_id); if (!name) throw new Error("Native tool result has no corresponding Google function call.");
      append("user", [{ functionResponse: { name, id: message.tool_call_id, response: { output: message.content } } }]); continue;
    }
    const parts: GooglePart[] = [];
    for (const part of typeof message.content === "string" ? [{ type: "text", text: message.content }] : message.content ?? []) {
      if (part.type === "text") parts.push({ text: part.text });
      else if (part.type === "image_url" && "image_url" in part) {
        const { attachments } = cliInput([{ type: "image", url: part.image_url.url }], { supportsImages: true });
        parts.push({ inlineData: { data: attachments![0].data, mimeType: attachments![0].mimeType } });
      }
    }
    for (const call of message.tool_calls ?? []) {
      const name = toolName(call.function.name); names.set(name, call.function.name); calls.set(call.id, name);
      const saved = signatures.get(call.id);
      if (!saved || saved.model !== request.model || saved.name !== call.function.name) throw new Error("Google tool signature state is unavailable for this native history; no substitute session was started.");
      parts.push({ functionCall: { id: call.id, name, args: JSON.parse(call.function.arguments) },
        ...(saved.thoughtSignature ? { thoughtSignature: saved.thoughtSignature } : {}) });
    }
    append(message.role === "assistant" ? "model" : "user", parts);
  }
  const functions = (body.tools ?? []).map(tool => {
    const name = toolName(tool.function.name); names.set(name, tool.function.name);
    return { name, description: tool.function.description, parametersJsonSchema: tool.function.parameters };
  });
  const config: GoogleRequest["config"] = { ...(instructions.length ? { systemInstruction: instructions.join("\n\n") } : {}),
    ...(functions.length ? { tools: [{ functionDeclarations: functions }] } : {}),
    ...(request.max_output_tokens ? { maxOutputTokens: request.max_output_tokens } : {}) };
  if (request.tool_choice === "none") config.toolConfig = { functionCallingConfig: { mode: "NONE" } };
  else if (request.tool_choice === "required") config.toolConfig = { functionCallingConfig: { mode: "ANY" } };
  else if (body.tool_choice && typeof body.tool_choice === "object" && body.tool_choice.function?.name)
    config.toolConfig = { functionCallingConfig: { mode: "ANY", allowedFunctionNames: [toolName(body.tool_choice.function.name)] } };
  return { request: { model: request.model, contents, config }, names, toolKinds };
}

export function codexGoogleEngine(config: GoogleConfig, { operation = googleModelOperation } = {}): EngineAdapter {
  googleProviderConfig(config);
  let server: http.Server | undefined, active = 0, catalogPromise: Promise<Model[]> | null;
  const signatures = googleSignatureStore(config.cliHome);
  const catalog = () => catalogPromise ??= operation(config, "model/list").then(result => result.data)
    .catch(error => { catalogPromise = null; throw error; });
  const writeCatalog = (models: Model[]) => {
    const native = buildCatalog(models.map(m => ({ id: m.id, name: m.name, vendor: "Google", model_picker_enabled: true,
      supported_endpoints: ["/chat/completions"], capabilities: { type: "chat", supports: { vision: true, parallel_tool_calls: true } } })));
    for (const row of native.models) { row.description = "Google account · Gemini model via native Codex Agent"; delete row.copilot; }
    const file = path.join(config.cliHome, "codex-models.json"), pending = `${file}.${randomUUID()}.tmp`;
    try { fs.writeFileSync(pending, JSON.stringify(native), { flag: "wx", mode: 0o600 }); fs.renameSync(pending, file); }
    finally { fs.rmSync(pending, { force: true }); }
  };
  return {
    adapter: "codex-gemini", nativeProvider: true, providerId: googleProviderId, displayName: "Codex + Gemini（Google）",
    get activeRequests() { return active; },
    async models() { catalogPromise = null; const models = await catalog(); writeCatalog(models); return models; },
    async run() { throw new Error("Codex + Gemini must run in the native Codex app-server, not Gemini CLI Agent."); },
    async start({ token }: { token: string }) {
      const capability = Buffer.from(`Bearer ${googleProviderToken(token)}`);
      server = http.createServer(async (req, res) => {
        const supplied = Buffer.from(req.headers.authorization ?? "");
        if (supplied.length !== capability.length || !timingSafeEqual(supplied, capability) || req.headers.origin) { sendJson(res, 403, { error: { message: "Private Google provider authorization required." } }); return; }
        if (req.method === "GET" && req.url === "/health") { sendJson(res, 200, { provider: googleProviderId }); return; }
        if (req.method !== "POST" || req.url !== "/responses") { sendJson(res, 404, { error: { message: "Unknown model endpoint." } }); return; }
        active++; const controller = new AbortController(); let writer: ReturnType<typeof createResponsesWriter> | undefined;
        res.once("close", () => { if (!res.writableEnded) controller.abort(); });
        try {
          let bytes = 0; const chunks = [];
          for await (const chunk of req) { bytes += chunk.length; if (bytes > 16 * 1024 * 1024) throw new Error("Native model request exceeds 16 MiB."); chunks.push(chunk); }
          const input = JSON.parse(Buffer.concat(chunks).toString()) as NativeModelRequest;
          if (!(await catalog()).some(m => m.id === input.model)) throw new Error("Google model unavailable in this account; no fallback.");
          const mapped = buildGoogleRequest(input, signatures); let toolIndex = 0, emitted = false, finishReason: string | undefined;
          writer = createResponsesWriter(res, input, mapped.toolKinds, { streaming: input.stream !== false });
          const seen = new Set();
          await operation(config, "generate", mapped.request, { signal: controller.signal, onChunk: chunk => {
            for (const part of chunk.candidates?.[0]?.content?.parts ?? []) {
              if (part.thought) continue;
              if (part.text) { writer!.pushChunk({ choices: [{ delta: { content: part.text } }] }); emitted = true; }
              if (part.functionCall) {
                const name = mapped.names.get(part.functionCall.name);
                if (!name) throw new Error("Google returned an undeclared tool; it was not exposed to Codex.");
                const id = part.functionCall.id || `google_${randomUUID()}`;
                if (seen.has(id)) throw new Error("Google returned a duplicate tool call identity."); seen.add(id);
                signatures.put(id, { model: input.model, name, thoughtSignature: part.thoughtSignature ?? null });
                writer!.pushChunk({ choices: [{ delta: { tool_calls: [{ index: toolIndex++, id, type: "function",
                  function: { name, arguments: JSON.stringify(part.functionCall.args ?? {}) } }] } }] }); emitted = true;
              }
            }
            finishReason = chunk.candidates?.[0]?.finishReason ?? finishReason;
            if (chunk.usageMetadata) writer!.pushChunk({ usage: { prompt_tokens: chunk.usageMetadata.promptTokenCount,
              completion_tokens: chunk.usageMetadata.candidatesTokenCount, total_tokens: chunk.usageMetadata.totalTokenCount } });
          } });
          if (!emitted || finishReason !== "STOP") throw new Error(`Google model did not complete successfully (${finishReason || "missing terminal status"}).`);
          writer.finish();
        } catch (cause) { const error = cause instanceof Error ? cause : new Error(String(cause)); if (!res.destroyed) { if (writer) writer.fail(error.message); else sendJson(res, 400, { error: { message: error.message } }); } }
        finally { active--; }
      });
      await new Promise<void>((resolve, reject) => { server!.once("error", reject); server!.listen(config.bridgePort, "127.0.0.1", resolve); });
    },
    async close() { if (server?.listening) await new Promise<void>(resolve => { server!.close(() => resolve()); server!.closeAllConnections(); }); },
  };
}

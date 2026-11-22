import "../tools/typescript-runtime.mjs";
import { randomUUID } from "node:crypto";
import type { GoogleChunk } from "./sdk-contracts.mjs";
import type { SignatureStore } from "./google-contracts.mjs";
import { createResponsesWriter } from "../bridge/translate.mjs";

/** Only Google's wire dialect lives here. Tool lowering, identity restoration,
 * message phases and Responses lifecycle belong to the shared compiler. */
export function createGoogleChunkTranslator(writer: ReturnType<typeof createResponsesWriter>, names: Map<string, string>, signatures: SignatureStore, model: string) {
  let toolIndex = 0, emitted = false, finishReason: string | undefined;
  const seen = new Set<string>();
  return {
    push(chunk: GoogleChunk) {
      for (const part of chunk.candidates?.[0]?.content?.parts ?? []) {
        if (part.text) {
          writer.pushChunk({ choices: [{ delta: part.thought ? { reasoning_content: part.text } : { content: part.text } }] }); emitted = true;
        }
        if (part.functionCall) {
          const name = names.get(part.functionCall.name);
          if (!name) throw new Error("Google returned an undeclared tool; it was not exposed to Codex.");
          const id = part.functionCall.id || `google_${randomUUID()}`;
          if (seen.has(id)) throw new Error("Google returned a duplicate tool call identity."); seen.add(id);
          signatures.put(id, { model, name, thoughtSignature: part.thoughtSignature ?? null });
          writer.pushChunk({ choices: [{ delta: { tool_calls: [{ index: toolIndex++, id, type: "function",
            function: { name, arguments: JSON.stringify(part.functionCall.args ?? {}) } }] } }] }); emitted = true;
        }
      }
      finishReason = chunk.candidates?.[0]?.finishReason ?? finishReason;
      if (chunk.usageMetadata) writer.pushChunk({ usage: { prompt_tokens: chunk.usageMetadata.promptTokenCount,
        completion_tokens: chunk.usageMetadata.candidatesTokenCount, total_tokens: chunk.usageMetadata.totalTokenCount } });
    },
    finish() {
      const reason = finishReason === "MAX_TOKENS" ? "length" : ["SAFETY", "RECITATION", "PROHIBITED_CONTENT", "BLOCKLIST", "SPII"].includes(finishReason ?? "") ? "content_filter" : null;
      if (reason) writer.pushChunk({ choices: [{ delta: {}, finish_reason: reason }] });
      else if (!emitted || finishReason !== "STOP") throw new Error(`Google model did not complete successfully (${finishReason || "missing terminal status"}).`);
      return writer.finish();
    },
  };
}

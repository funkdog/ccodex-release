import type { Model } from "./contracts.mjs";
import type { GoogleRequest, GoogleChunk } from "./sdk-contracts.mjs";
export interface NativeModelRequest {
  [field: string]: unknown;
  model: string; input?: { type: string; [field: string]: unknown }[] | string;
  previous_response_id?: string; reasoning?: { effort?: string }; max_output_tokens?: number;
  tool_choice?: string | { name?: string }; stream?: boolean;
}
export interface Signature { model: string; name: string; thoughtSignature?: string | null }
export interface SignatureStore { get(id: string): Signature | null; put(id: string, value: Signature): void }
export interface GoogleOperationResult { data: Model[]; completed?: boolean }
export interface GoogleWorkerParams extends GoogleRequest { requestId?: string; chunk?: GoogleChunk }
export interface ChatTranslation {
  toolKinds: Map<string, string | { kind: string; name: string; namespace?: string; encoding?: string }>;
  body: { messages: { role: string; tool_call_id: string; content: string | ({ type: string; text: string; image_url: { url: string } })[];
    tool_calls?: { id: string; function: { name: string; arguments: string } }[] }[];
    tools?: { function: { name: string; description?: string; parameters: unknown } }[];
    tool_choice?: string | { type: string; function?: { name: string } } };
}

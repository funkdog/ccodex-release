/** Structural boundaries for the installed SDKs, deliberately scoped to the
 * methods/events consumed here. SDK imports remain runtime-path configurable. */
import type { Model, Attachment } from "./contracts.mjs";
export interface CopilotPermission { kind: string; managedApprovalRequired?: unknown }
export interface CopilotSessionOptions {
  model: string; workingDirectory: string; streaming: boolean; reasoningEffort?: string;
  onPermissionRequest(request: CopilotPermission, invocation?: { managedSettingsEnabled?: boolean; promptRequest?: { managedApprovalRequired?: boolean } }): Promise<{ kind: "reject" | "approve-once" }>;
  onUserInputRequest(request: { question: string; allowFreeform?: boolean; choices?: string[] }): Promise<{ answer: string; wasFreeform: boolean }>;
}
export interface CopilotEvent {
  type: string; id?: string; agentId?: string; data: { deltaContent: string; content?: string; toolCallId: string; toolName: string;
    arguments?: unknown; success?: boolean; result?: { content?: unknown }; error?: { message?: string }; message?: string };
}
export interface CopilotSession {
  sessionId: string; on(callback: (event: CopilotEvent) => void): () => void;
  abort(): Promise<void>; send(input: { prompt: string; attachments?: Attachment[] }): Promise<unknown>; disconnect(): Promise<void>;
}
export interface CopilotRuntime {
  start(): Promise<void>; stop(): Promise<void>; getAuthStatus(): Promise<{ isAuthenticated: boolean }>;
  listModels(): Promise<Model[]>; resumeSession(id: string, options: CopilotSessionOptions): Promise<CopilotSession>;
  createSession(options: CopilotSessionOptions & { sessionId: string }): Promise<CopilotSession>;
  rpc: { sessions: { fork(params: { sessionId: string; toEventId?: string }): Promise<{ sessionId: string }> } };
  deleteSession(id: string): Promise<void>;
}
export interface CopilotSdk {
  CopilotClient: new (options: { env?: NodeJS.ProcessEnv; workingDirectory?: string; connection: unknown; logLevel: string }) => CopilotRuntime;
  RuntimeConnection: { forStdio(options: { path?: string }): unknown };
}
export interface ClaudeQuestion { header: string; question: string; multiSelect?: boolean; options: { label: string; description: string }[] }
export interface ClaudeToolInput { questions?: ClaudeQuestion[]; [field: string]: unknown }
export interface ClaudeMessage {
  type: string; subtype?: string; session_id: string; parent_tool_use_id?: string; is_error?: boolean; errors?: string[]; result?: string;
  apiKeySource?: string;
  event?: { type: string; delta?: { type: string; text: string } };
  message?: { content?: { type: string; id: string; name: string; input: unknown; tool_use_id: string; is_error?: boolean; content?: unknown }[] };
}
export interface ClaudeQuery extends AsyncIterable<ClaudeMessage> {
  close(): void; supportedModels(): Promise<{ value: string; displayName: string; description?: string; resolvedModel?: string; supportedEffortLevels?: string[] }[]>;
  return?(): Promise<unknown>;
}
export interface ClaudeSdk {
  query(input: { prompt: string | AsyncIterable<never>; options: {
    env?: NodeJS.ProcessEnv; settingSources: string[]; permissionMode: string; pathToClaudeCodeExecutable?: string; settings?: string;
    persistSession?: boolean; model?: string; cwd?: string; abortController?: AbortController;
    includePartialMessages?: boolean; resume?: string; sessionId?: string;
    effort?: string;
    tools?: string[]; maxTurns?: number;
    canUseTool?: (name: string, input: ClaudeToolInput, options?: { signal?: AbortSignal; matchedAskRule?: unknown; defaultToNo?: boolean;
      decisionReasonType?: string; serverPolicyAskOnly?: boolean }) => Promise<{ behavior: "allow" | "deny"; message?: string; updatedInput?: ClaudeToolInput }>;
  } }): ClaudeQuery;
}
export interface GooglePart {
  text?: string; thought?: boolean; thoughtSignature?: string;
  inlineData?: { data: string; mimeType: string };
  functionCall?: { id?: string; name: string; args?: unknown };
  functionResponse?: { id: string; name: string; response: { output: unknown } };
}
export interface GoogleRequest {
  model: string; contents: { role: string; parts: GooglePart[] }[];
  config: { systemInstruction?: string; tools?: { functionDeclarations: { name: string; description?: string; parametersJsonSchema: unknown }[] }[];
    maxOutputTokens?: number; toolConfig?: { functionCallingConfig: { mode: string; allowedFunctionNames?: string[] } }; abortSignal?: AbortSignal };
}
export interface GoogleChunk {
  candidates?: { content?: { parts?: GooglePart[] }; finishReason?: string }[];
  usageMetadata?: { promptTokenCount?: number; candidatesTokenCount?: number; totalTokenCount?: number };
}
export interface GoogleCoreConfig {
  refreshAuth(type: unknown): Promise<void>; dispose(): Promise<void>;
  getGemini31LaunchedSync?(): boolean; hasLatestFlashGAAccess?(): boolean; hasLatestFlashLiteGAAccess?(): boolean;
  getHasAccessToPreviewModel(): boolean; getProModelNoAccess(): Promise<boolean>;
  getModelConfigService(): { getAvailableModelOptions(context: Record<string, boolean>): { modelId: string; name: string; description?: string }[] };
  getContentGenerator(): { generateContentStream(request: GoogleRequest, id: string, source: string): Promise<AsyncIterable<GoogleChunk>> };
}
export interface GoogleSdk {
  coreEvents: { on(event: string, callback: (event: { message: string }) => void): void };
  Config: new (options: Record<string, unknown>) => GoogleCoreConfig;
  DEFAULT_GEMINI_MODEL: string; AuthType: { LOGIN_WITH_GOOGLE: unknown };
}

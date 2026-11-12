/** Shared contracts. External JSON is decoded at the transport/SDK boundary;
 * opaque tool input stays unknown and is never executed by this layer. */
export type ApprovalMode = "ask" | "read-only" | "auto" | "deny";
export type Modality = "text" | "image";
export interface Model {
  id: string; name?: string; description?: string; inputModalities?: Modality[];
  supportedReasoningEfforts?: string[]; defaultReasoningEffort?: string;
  capabilities?: { supports?: { vision?: boolean } }; policy?: { state?: string };
}
export interface Question {
  id: string; header: string; question: string; isOther: boolean; isSecret: boolean;
  options: { label: string; description: string }[] | null;
}
export interface Answers { answers: Record<string, { answers: string[] }> }
export type Ask = (questions: Question[]) => Promise<Answers>;
export type EngineImage = { kind: "blob"; mimeType: string; data: string } | { kind: "file"; path: string };
export type ToolEvent = { phase: "start"; id: string; name: string; input: unknown }
  | { phase: "end"; id: string; success?: boolean; output?: unknown; images?: EngineImage[] };
export interface Attachment { type: "blob"; data: string; mimeType: string }
export type UserInput = { type: "text"; text: string;
  text_elements?: { byteRange: { start: number; end: number }; placeholder?: string | null }[] } | { type: "image"; url: string }
  | { type: "localImage"; path: string };
export interface RunContext {
  prompt: string; attachments?: Attachment[]; model: string; cwd: string;
  nativeSessionId?: string | null; reasoningEffort?: string | null;
  signal: AbortSignal; onSession: (id: string) => void; onText: (delta: string) => void;
  onTool?: (event: ToolEvent) => void; ask: Ask; getApprovalMode?: () => ApprovalMode;
  onImage?: (image: EngineImage) => void;
  onCheckpoint?: (eventId: string) => void;
  verification?: boolean;
}
export interface ForkContext { nativeSessionId: string; cwd: string; beforeEventId?: string }
export interface DeleteContext { nativeSessionId: string; cwd: string }
export interface EngineAdapter {
  adapter?: string; displayName?: string; supportsImages?: boolean; supportsModelSwitch?: boolean; approvalModes?: ApprovalMode[];
  initialApprovalMode?: ApprovalMode;
  nativeProvider?: boolean; providerId?: string; readonly activeRequests?: number;
  models(): Promise<Model[]>; run(context: RunContext): Promise<void>;
  start?(context: { token: string }): Promise<void>; close?(): Promise<void>;
  forkSession?(context: ForkContext): Promise<string>;
  deleteSession?(context: DeleteContext): Promise<void>;
  supportsForkBoundary?: boolean;
}
export interface ProviderConfig { bridgePort: number; bridgeHome: string }
export interface GoogleConfig { bridgePort: number; cliHome: string; sdkPath: string }
export type EngineConfig = { id: string; enabledModels?: string[] } & (
  { adapter: "antigravity-acp"; executable: string; harnessPath: string; cliHome: string } |
  { adapter: "gemini-cli"; executable: string; cliHome: string } |
  ({ adapter: "codex-gemini" } & GoogleConfig) |
  ({ adapter: "codex-copilot" } & ProviderConfig) |
  { adapter: "claude-code"; executable?: string; sdkPath?: string; cliHome?: string; initialApprovalMode?: ApprovalMode } |
  { adapter: "github-copilot"; executable?: string; sdkPath?: string }
);
export interface RpcError { code: number; message: string; data?: unknown }
export type RpcId = string | number;
export interface RpcMessage<P = AppParams, R = AppPayload> {
  id?: RpcId; method?: string; params?: P; result?: R; error?: RpcError; jsonrpc?: string;
}
export interface Collaboration { mode: string; settings: { model?: string | null; reasoning_effort?: string | null; developer_instructions?: unknown } }
/** Fields consumed by the pinned app-server seam; unhandled fields remain opaque. */
export interface AppParams {
  [field: string]: unknown;
  model?: string | null; modelProvider?: string; collaborationMode?: Collaboration | null;
  threadId?: string; conversationId?: string; parentThreadId?: string; ancestorThreadId?: string;
  attachedToThreadId?: string; sourceThreadId?: string; threadIds?: string[];
  cursor?: string | { type: string; itemId: string } | null; limit?: number;
  sortKey?: string; sortDirection?: string; modelProviders?: string[]; config?: Record<string, unknown>;
  thread?: AppRow;
}
export interface AppRow {
  [field: string]: unknown;
  id: string; model?: string | null; modelProvider?: string; createdAt?: number; updatedAt?: number; recencyAt?: number;
  nativeProvider?: string; nativeCopilot?: boolean;
}
export interface SearchHit { thread: AppRow; snippet: string }
export type AppListRow = AppRow | SearchHit | string;
export interface AppPayload {
  [field: string]: unknown;
  thread?: AppRow; model?: string; modelProvider?: string; data?: AppListRow[];
  threadId?: string; threadSettings?: AppParams; collaborationMode?: Collaboration | null;
  nextCursor?: string | null;
}
export interface Page<T> { data: T[]; nextCursor: string | null }
export interface GatewayModel extends Omit<Model, "supportedReasoningEfforts"> {
  model: string; displayName: string; hidden: boolean; isDefault: boolean;
  inputModalities: Modality[]; nativeCopilot: boolean; nativeProvider?: string; canSwitchModel?: boolean;
  supportedReasoningEfforts: { reasoningEffort: string; description: string }[];
  defaultReasoningEffort: string; cliApprovalModes: ApprovalMode[]; defaultCliApprovalMode?: ApprovalMode;
}
export interface SelectedModel {
  model: string; engineId: string; nativeModel: string; efforts: string[]; defaultEffort: string;
  approvalModes: ApprovalMode[]; inputModalities: Modality[];
}
export interface TurnError { message: string; codexErrorInfo: null; additionalDetails: null }
export interface ToolItem {
  id: string; type: "dynamicToolCall"; namespace: string; tool: string; arguments: unknown;
  status: string; contentItems: { type: "inputText"; text: string }[] | null;
  success: boolean | null; durationMs: number | null;
}
export interface ImageGenerationThreadItem { id: string; type: "imageGeneration"; status: "completed"; savedPath: string; result: string }
export type ThreadItem = { id: string; type: "userMessage"; content: UserInput[] }
  | { id: string; type: "agentMessage"; text: string; phase: string } | ToolItem | ImageGenerationThreadItem;
export interface Turn { id: string; status: string; error: TurnError | null; items: ThreadItem[]; nativeStartEventId?: string }
export interface StoredThread {
  schemaVersion: 1; id: string; engineId: string; engineAdapter: string; nativeSessionId: string | null;
  model: string; modelProvider: string; cwd: string; cliVersion: string; createdAt: number; updatedAt: number;
  ephemeral: boolean; preview: string; name: string | null; projectId: string | null; sectionId?: string | null;
  source: string; threadSource?: string; status: { type: string; activeFlags?: string[] };
  archived: boolean; turns: Turn[]; reasoningEffort?: string | null; cliApprovalMode?: ApprovalMode;
  approvalPolicy: string; sessionId?: string; daybreakEnabled?: boolean;
  forkedFromId?: string | null; section?: { id: string; name: string } | null; sectionEnteredAt?: number | null;
  sectionOrder?: number;
}
/** A deleted ID retains routing ownership, never its title, messages or tools. */
export interface ThreadTombstone {
  schemaVersion: 1; id: string; engineId: string; engineAdapter: string; deleted: true;
  deletedAt: number; cleanup: "pending" | "complete" | "unsupported";
  nativeSessionId?: string; cwd?: string;
}
export interface GatewayParams extends AppParams {
  threadId: string; turnId?: string; model?: string | null; cwd?: string;
  input: UserInput[]; effort?: string | null; reasoningEffort?: string | null; cliApprovalMode?: ApprovalMode;
  approvalPolicy?: string; approvalsReviewer?: string; permissions?: string; sandbox?: string;
  sandboxPolicy?: { type: string }; runtimeWorkspaceRoots?: string[]; multiAgentMode?: string;
  originators?: string[]; excludedThreadIds?: string[]; sourceKinds?: string[]; projectId?: string | null;
  sectionId?: string | null; searchTerm?: string; itemsView?: string; name?: string;
  disabledPluginIds?: string[];
  lastTurnId?: string | null; beforeTurnId?: string | null; excludeTurns?: boolean;
  beforeThreadId?: string | null;
}
export interface GatewayConnection {
  readonly role?: "default" | "native-trace" | "native-host";
  readonly inFlight?: number;
  initialized: boolean; send(message: unknown): void;
  request(method: string, params: unknown, signal?: AbortSignal): Promise<Answers>;
}
export interface ConnectionConfig {
  home: string; endpoint: string; token: string; generation: string; configGeneration?: string; frontend?: string; engines?: EngineConfig[];
  workbench?: boolean;
  spine?: import("./spine/contracts.mjs").SpineRuntimeOptions;
}
export interface AcpOption { id: string; category: string; type: string; currentValue?: string; options?: AcpChoice[] }
export interface AcpChoice { value: string; name: string; description?: string; options?: AcpChoice[] }
export interface AcpResult {
  protocolVersion: number; agentInfo?: { name: string; version: string };
  agentCapabilities?: { loadSession?: boolean; promptCapabilities?: { image?: boolean }; sessionCapabilities?: { resume?: boolean } };
  sessionId: string; configOptions?: AcpOption[]; stopReason?: string;
  models?: { availableModels?: { modelId: string; name: string; description?: string }[] };
}
export interface AcpParams {
  sessionId?: string; update?: { sessionUpdate: string; content?: AcpContent | AcpContent[]; toolCallId: string; title?: string; rawInput?: unknown; rawOutput?: unknown; status: string };
  options?: { name: string; kind: string; optionId: string }[];
  toolCall?: { toolCallId?: string; title?: string; content?: { type: string; content?: { type: string; text: string } }[] };
  [field: string]: unknown;
}
export interface AcpContent { type: string; text?: string; data?: string; mimeType?: string; content?: AcpContent; [field: string]: unknown }
export interface ChildOptions { executable: string; args?: string[]; env?: NodeJS.ProcessEnv; cwd?: string; stderr?: "ignore" | "inherit" }

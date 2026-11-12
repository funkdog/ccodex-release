/** DIY components consume services and DOM lifecycle only. Host-specific
 * routing/module selectors belong to the pinned adapter. All imports erase. */
import type { ApprovalMode, UserInput, Collaboration, RpcMessage, GatewayModel, Page } from "../gateway/contracts.mjs";
export interface Disposable { dispose(): void }
export interface MountedComponent extends Disposable { host: HTMLElement }
export interface HostActions {
  openThread(threadId: string): Promise<void>;
  prefillDraft(text: string): Promise<void>;
  injectText(text: string): Promise<void>;
  copyText?(text: string): Promise<void>;
}
export interface DiyServices { request(method: string, params: Record<string, unknown>): Promise<unknown>; subscribe?(receive: (event: unknown) => void): () => void }
export interface DrawerSlot {
  id: string; label: string; badge?: number | string; tone?: "neutral" | "positive" | "warning"; disabled?: boolean;
  mount(options: { document: Document; container: HTMLElement; services: DiyServices; hostActions: HostActions; signal: AbortSignal; setStatus?(message: string): void; setBadge?(badge: number | string, tone?: "neutral" | "positive" | "warning"): void }): MountedComponent | Promise<MountedComponent>;
}
export interface SessionPreferences { reasoningEffort?: string | null; cliApprovalMode?: ApprovalMode }
export type CliSettingsUpdate = SessionPreferences & { threadId: string; model?: string };
export interface UiThread extends SessionPreferences {
  executionHandoff?: boolean;
  id: string; model: string | null; cwd?: string; title?: string; updatedAt?: number; modelProvider?: string;
  nativeProvider?: string; nativeCopilot?: boolean; nativeRuntime?: boolean;
}
export interface UiModel {
  nativeDefault?: boolean; preferredSource?: boolean; sourceLabel?: string;
  id: string; label: string; engine?: string; inputModalities?: string[]; nativeCopilot?: boolean; nativeProvider?: string;
  catalogWarning?: string; efforts?: string[]; defaultEffort?: string; approvalModes?: ApprovalMode[]; canSwitchModel?: boolean;
  defaultCliApprovalMode?: ApprovalMode;
}
export interface UiServices {
  readNativeSpeed?(): { value: string | null; disabled: boolean; options: { value: string | null; label: string; description?: string }[] } | null;
  selectNativeSpeed?(value: string | null): Promise<void>;
  selectThreadModel?(params: CliSettingsUpdate & { model: string }): Promise<UiThread | null>;
  openModelSources?(): Promise<void>;
  listModels(): Promise<UiModel[]>; refreshModels?(): Promise<UiModel[]>;
  listThreads(params?: { cursor?: string | null }): Promise<Page<UiThread>>;
  updateSettings(params: CliSettingsUpdate): Promise<UiThread>;
  setApprovalDefault?(params: { model: string; cliApprovalMode: ApprovalMode }): Promise<SessionPreferences>;
  createThread(params: { model: string; cwd: string }): Promise<UiThread>;
  selectDraftModel?(model: string | null, effort: string | null): Promise<SessionPreferences & { model: string | null }>;
}
export interface UiRpcResults {
  "thread/list": Page<UiThread & { name?: string; preview?: string }>;
  "gateway/models/refresh": { warnings?: string[] };
  "model/list": Page<GatewayModel> & { warnings?: string[] };
  "thread/settings/update": { thread: UiThread };
  "gateway/approval/default/set": SessionPreferences;
  "thread/start": { thread: UiThread; model: string; cwd: string };
}
export type UiRequest = <K extends keyof UiRpcResults>(method: K, params: object) => Promise<UiRpcResults[K]>;
export interface NativeOptions {
  [field: string]: unknown;
  model?: string | null; effort?: string | null; collaborationMode?: Collaboration | null;
  cliApprovalMode?: ApprovalMode; approvalPolicy?: string; approvalsReviewer?: string;
  sandbox?: unknown; sandboxPolicy?: unknown; permissions?: string; runtimeWorkspaceRoots?: string[]; threadId?: string;
  clientUserMessageId?: string; input?: UserInput[]; sideConversation?: boolean;
  parentTurnId?: string; toolOutput?: unknown; mode?: string; threadSource?: string; ephemeral?: boolean;
  attachments?: unknown[]; commentAttachments?: unknown[]; responseItems?: unknown[];
}
export interface NativeEnvelope {
  type?: string; hostId?: string; request?: RpcMessage<NativeOptions, NativeResult>;
  message?: RpcMessage<NativeOptions, NativeResult>;
  params?: { thread?: UiThread };
}
export interface NativeResult {
  thread?: UiThread; data?: (UiThread | { thread: UiThread; snippet: string } | string)[]; model?: string;
}
export interface SessionIntent extends SessionPreferences { model: string | null; id?: string; nativeCopilot?: boolean; nativeRuntime?: boolean }
export interface SessionController extends Disposable {
  select(model: string | null): void; selection(): string | null;
  preferences(threadId?: string | null): SessionPreferences;
  configure(settings: SessionPreferences): void; remember(thread?: UiThread): void;
  setApprovalDefaults(models: Pick<UiModel, "id" | "defaultCliApprovalMode">[]): void;
  setModelSwitchPending(threadId: string, pending: boolean): void;
  thread(id?: string | null): UiThread | null;
  begin(options: NativeOptions): { options: NativeOptions; finish(): void } | null;
  outgoing(type: string, payload: NativeEnvelope): NativeEnvelope;
  observe(message: NativeEnvelope): void;
}
export interface RequestClient { getThreadPrewarmPolicy(...args: unknown[]): unknown }
export interface NativeManager {
  hostId: string; requestClient: RequestClient;
  startConversation(options: NativeOptions, ...rest: unknown[]): unknown;
  setDefaultModelConfig?(model: string, effort: string | null, ...rest: unknown[]): unknown;
}
export interface NativeBus {
  dispatchMessage(type: string, payload: NativeEnvelope): unknown;
  dispatchHostMessage(message: NativeEnvelope): unknown;
  subscribe(type: string, receive: (message: NativeEnvelope) => void): () => void;
}
export interface HostWindow extends Window {
  electronBridge?: { getSentryInitOptions?(): { appVersion?: string } };
  codexWindowType?: string; MessageEvent: typeof MessageEvent;
}
export interface NativeModules { [name: string]: unknown }

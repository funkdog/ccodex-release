/** Structural types for the small legacy host/CDP boundary consumed by the
 * helper. This does not broaden which hosts, endpoints or methods it accepts. */
export interface CdpTarget { id: string; type: string; url: string; webSocketDebuggerUrl: string }
export interface CdpEvent {
  method: string;
  params: { context: { id: number; auxData?: { isDefault?: boolean; frameId?: string } };
    executionContextId: number; name: string; payload: string };
}
export interface CdpResult {
  frameTree?: { frame: { id: string } };
  exceptionDetails?: { exception?: { description?: string }; text?: string };
  result?: { value?: unknown };
}
export interface CdpSession {
  readonly active: boolean; selectorPatch?: string;
  send(method: string, params?: object): Promise<CdpResult>;
  evaluate(expression: string): Promise<unknown>; close(): void;
}
export interface CdpSessions {
  sessions: Map<string, CdpSession>; retain(targets: CdpTarget[]): void;
  get(id: string): CdpSession | undefined; set(id: string, session: CdpSession): void; close(): void;
}

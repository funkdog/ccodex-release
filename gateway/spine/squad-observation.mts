import type { SquadLedger, LedgerDelivery } from "./squad-ledger.mjs";
export interface SquadMemberObservation {
  status: { type: string; activeFlags?: string[] };
  turn?: { turnId: string; status: string; message?: string; text?: string };
}
export interface SquadTurnDiagnostic { seq: number; turnId: string; status: string; reason: "turn_failed" | "unreported_turn"; message: string }
export const terminalTurn = (status: string) => ["completed", "failed", "interrupted"].includes(status);
/** A new dispatch or any later member entry supersedes the old obligation.
 * Never search backwards for an older 'sent' delivery when the newest is queued. */
export function currentDelivery(ledger: SquadLedger, workerId: string): LedgerDelivery | undefined {
  const delivery = ledger.deliveries.findLast(d => d.workerId === workerId);
  return delivery && !ledger.entries.some(e => e.authorThreadId === workerId && e.seq > delivery.seq) ? delivery : undefined;
}
export function unreportedTurn(ledger: SquadLedger, workerId: string, observed: SquadMemberObservation): SquadTurnDiagnostic | undefined {
  const delivery = currentDelivery(ledger, workerId), turn = observed.turn;
  if (!delivery || delivery.state !== "sent" || !delivery.turnId || turn?.turnId !== delivery.turnId || !terminalTurn(turn.status)) return;
  return { seq: delivery.seq, turnId: turn.turnId, status: turn.status, reason: turn.status === "completed" ? "unreported_turn" : "turn_failed",
    message: turn.message || (turn.status === "interrupted" ? "回合已中断，尚未写账本。" : turn.status === "failed" ? "回合执行失败，尚未写账本。" : "回合已结束，尚未写账本。") };
}

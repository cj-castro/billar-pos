import type { Ticket, TicketLineItem } from '../../../domain/types';
import type { LineStatus } from '../../../theme/tokens';
import type { NewDraftLine } from '../draft/draftStore';

/** STAGED never reaches the app (nothing creates it, matrix G24) but is rendered as SENT if it ever does. */
export const lineStatus = (l: Pick<TicketLineItem, 'status'>): LineStatus => (l.status === 'STAGED' ? 'SENT' : l.status);

export const activeLines = (t: Pick<Ticket, 'line_items'>) => (t.line_items ?? []).filter((l) => l.status !== 'VOIDED');

interface TimerSession {
  start_time?: string | null;
  end_time?: string | null;
  status?: string;
}

/** The timer session still running (`end_time` null), if any. */
export function activeTimerStart(t: Pick<Ticket, 'timer_sessions'>): string | null {
  const s = (t.timer_sessions as TimerSession[] | undefined)?.find((x) => !x.end_time && (x.status ?? 'ACTIVE') === 'ACTIVE');
  return s?.start_time ?? null;
}

export const hasTimerSessions = (t: Pick<Ticket, 'timer_sessions'>) => (t.timer_sessions?.length ?? 0) > 0;

/** "Cancelar mesa": only an empty ticket (no non-voided items, no timer sessions). Server re-checks (422). */
export function canCancelTable(t: Ticket): boolean {
  return t.status === 'OPEN' && activeLines(t).length === 0 && !hasTimerSessions(t);
}

/** "Pedir cuenta" needs something to bill (a non-voided line or table time) and an open, not-yet-requested ticket. */
export function canRequestBill(t: Ticket): boolean {
  return t.status === 'OPEN' && !t.payment_requested && (activeLines(t).length > 0 || hasTimerSessions(t));
}

export const readyLines = (t: Ticket) => (t.line_items ?? []).filter((l) => l.status === 'READY');

/** Lines sent within this window of the newest send count as one "round" (sends post line by line). */
const ROUND_WINDOW_MS = 60_000;

/** "Repetir última ronda": the newest sent batch (non-voided, same item/modifiers/qty/notes) as draft lines. */
export function lastRoundLines(t: Pick<Ticket, 'line_items'>): NewDraftLine[] {
  const sent = activeLines(t).filter((l) => l.sent_at && !Number.isNaN(Date.parse(l.sent_at)));
  if (sent.length === 0) return [];
  const newest = Math.max(...sent.map((l) => Date.parse(l.sent_at as string)));
  return sent
    .filter((l) => newest - Date.parse(l.sent_at as string) <= ROUND_WINDOW_MS)
    .map((l) => ({
      menuItemId: l.menu_item_id,
      name: l.menu_item_name,
      unitPriceCents: l.unit_price_cents,
      quantity: l.quantity,
      modifiers: l.modifiers.map((m) => ({ id: m.modifier_id, name: m.name, priceCents: m.price_cents })),
      notes: l.notes ?? '',
    }));
}

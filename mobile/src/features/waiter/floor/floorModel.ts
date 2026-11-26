import type { Ticket } from '../../../domain/types';
import { formatElapsed } from '../../../utils/time';
import type { DraftLine } from '../draft/draftStore';

/** Pool timer text "mm:ss" (h:mm:ss over an hour). Frozen (offline) shows "~" + the last value. Empty when no/invalid start. */
export function timerText(startIso: string | null | undefined, now: number, frozen = false): string {
  if (!startIso) return '';
  const start = Date.parse(startIso);
  if (Number.isNaN(start)) return '';
  return `${frozen ? '~' : ''}${formatElapsed((now - start) / 1000)}`;
}

export interface ExpressChip {
  id: string;
  /** Customer name, else null (the caller prints "Rápido #n"). */
  name: string | null;
  n: number;
}

/** Open EXPRESS tickets, oldest first, numbered 1.. (the server has no visible number). */
export function expressChips(tickets: readonly Pick<Ticket, 'id' | 'customer_name' | 'opened_at' | 'ticket_type' | 'status'>[]): ExpressChip[] {
  return tickets
    .filter((t) => t.ticket_type === 'EXPRESS' && t.status === 'OPEN')
    .sort((a, b) => (a.opened_at ?? '').localeCompare(b.opened_at ?? ''))
    .map((t, i) => ({ id: t.id, name: t.customer_name?.trim() || null, n: i + 1 }));
}

export interface UnsentSummary {
  /** Tickets with at least one line that never reached the server. */
  count: number;
  /** Most recently touched one: where the bar navigates. */
  ticketId: string;
}

/** Draft store -> "N pedido(s) sin enviar". Null when nothing is waiting. */
export function unsentSummary(byTicket: Readonly<Record<string, readonly Pick<DraftLine, 'addedAt'>[]>>): UnsentSummary | null {
  const rows = Object.entries(byTicket)
    .filter(([, lines]) => lines.length > 0)
    .map(([id, lines]) => ({ id, at: Math.max(...lines.map((l) => l.addedAt ?? 0)) }))
    .sort((a, b) => b.at - a.at);
  return rows.length ? { count: rows.length, ticketId: rows[0].id } : null;
}

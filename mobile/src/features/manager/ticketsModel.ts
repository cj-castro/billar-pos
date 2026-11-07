import type { OpenTicketRow } from '../../api/endpoints/managerTickets';
import type { Ticket } from '../../domain/types';
import { isMexicoToday } from './mexDate';

/** all = Abiertos, bills = Cuenta pedida (ids kept for the overview deep link `?filter=bills`). */
export type TicketFilter = 'all' | 'bills' | 'closed' | 'cancelled';

/** Display row shared by every filter. */
export interface TicketRow {
  id: string;
  /** Table code; null = Rapido / no table. */
  code: string | null;
  name: string | null;
  totalCents: number;
  /** Age reference: opened_at (open) or closed_at (closed/cancelled). */
  at: string | null;
  itemCount: number | null;
  bill: boolean;
  /** opened_by id when no name is known. */
  waiter: string | null;
}

/** Filter + sort of the open-all list. billIds = tickets with "cuenta solicitada" (open-all does not carry the flag). */
export function filterTickets(rows: readonly OpenTicketRow[], billIds: ReadonlySet<string>, filter: TicketFilter): OpenTicketRow[] {
  const list = filter === 'bills' ? rows.filter((r) => billIds.has(r.id)) : [...rows];
  return list.sort((a, b) => (a.opened_at ?? '').localeCompare(b.opened_at ?? ''));
}

export function openRows(rows: readonly OpenTicketRow[], billIds: ReadonlySet<string>, waiters: ReadonlyMap<string, string>, filter: 'all' | 'bills'): TicketRow[] {
  return filterTickets(rows, billIds, filter).map((r) => ({
    id: r.id,
    code: r.resource_code,
    name: r.customer_name,
    totalCents: r.total_cents,
    at: r.opened_at,
    itemCount: r.item_count,
    bill: billIds.has(r.id),
    waiter: waiters.get(r.id) ?? null,
  }));
}

/**
 * Closed today / cancelled today from `GET /tickets?status=` (server caps at 100, newest first).
 * "Today" is the Mexico date of closed_at (opened_at when a cancelled ticket has no closed_at). Newest first.
 */
export function finishedRows(tickets: readonly Ticket[], status: 'CLOSED' | 'CANCELLED', nowMs: number): TicketRow[] {
  return tickets
    .filter((t) => t.status === status && isMexicoToday(t.closed_at ?? t.opened_at, nowMs))
    .sort((a, b) => (b.closed_at ?? b.opened_at).localeCompare(a.closed_at ?? a.opened_at))
    .map((t) => ({
      id: t.id,
      code: t.resource_code,
      name: t.customer_name,
      totalCents: t.total_cents,
      at: t.closed_at ?? t.opened_at,
      itemCount: null,
      bill: false,
      waiter: t.opened_by,
    }));
}

/** Short id shown when the waiter name is unknown. */
export const shortId = (id: string | null) => (id ? id.slice(0, 6) : null);

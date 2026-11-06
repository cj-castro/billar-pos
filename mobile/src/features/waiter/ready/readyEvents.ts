import type { QueueItem, Ticket } from '../../../domain/types';

/** `kitchen:item_update` / `bar:item_update` payload (backend extension B2 adds everything after `status`; never `opened_by`, SEC-05). */
export interface ItemEvent {
  item_id?: string;
  status?: string;
  ticket_id?: string;
  resource_code?: string | null;
  menu_item_name?: string;
  quantity?: number;
}

export type ReadyDecision =
  | { action: 'ignore' }
  /** B2 absent / incomplete payload: cannot tell whose item it is, so just refetch the lists. */
  | { action: 'refetch' }
  | { action: 'notify'; ticketId: string; name: string; code: string; itemId: string };

const SEEN_MAX = 300;

/**
 * Which ready events earn a toast: status READY on a ticket in `myTicketIds` (OPEN tickets whose opened_by is me,
 * from GET /tickets?status=OPEN; events for other waiters only change the list), once per item+status (socket may
 * deliver duplicates). `myTicketIds` null = not loaded yet. `seen` is owned by the caller and mutated on notify.
 */
export function classifyReadyEvent(payload: ItemEvent | undefined, myTicketIds: ReadonlySet<string> | null, seen: Set<string>): ReadyDecision {
  if (!payload || payload.status !== 'READY' || !payload.item_id) return { action: 'ignore' };
  if (!payload.ticket_id || !payload.menu_item_name || !myTicketIds) return { action: 'refetch' };
  if (!myTicketIds.has(payload.ticket_id)) return { action: 'ignore' };
  const k = `${payload.item_id}:READY`;
  if (seen.has(k)) return { action: 'ignore' };
  seen.add(k);
  if (seen.size > SEEN_MAX) seen.delete(seen.values().next().value as string);
  return {
    action: 'notify',
    ticketId: payload.ticket_id,
    name: payload.menu_item_name,
    code: payload.resource_code ?? '',
    itemId: payload.item_id,
  };
}

// ---------------------------------------------------------------- list model
export interface ReadyGroup {
  ticketId: string;
  code: string;
  customerName: string | null;
  mine: boolean;
  items: QueueItem[];
}

export interface ReadyModel {
  mine: ReadyGroup[];
  others: ReadyGroup[];
  /** READY lines of tickets I opened: tab badge. */
  mineCount: number;
  total: number;
  /** READY lines whose ticket is not in `tickets` yet (refetch the ticket list). */
  unknownTickets: string[];
}

const sentAt = (i: QueueItem) => i.sent_at ?? '';

/** READY lines of both stations, grouped by ticket (oldest first), mine before others. */
export function buildReadyModel(items: readonly QueueItem[], tickets: readonly Ticket[], userId: string | null | undefined): ReadyModel {
  const byId = new Map(tickets.map((t) => [t.id, t]));
  const groups = new Map<string, ReadyGroup>();
  const unknown = new Set<string>();
  for (const i of items) {
    if (i.status !== 'READY') continue;
    const t = byId.get(i.ticket_id);
    if (!t) unknown.add(i.ticket_id);
    let g = groups.get(i.ticket_id);
    if (!g) {
      g = { ticketId: i.ticket_id, code: i.resource_code ?? t?.resource_code ?? '—', customerName: t?.customer_name ?? null, mine: !!t && !!userId && t.opened_by === userId, items: [] };
      groups.set(i.ticket_id, g);
    }
    g.items.push(i);
  }
  const list = [...groups.values()];
  for (const g of list) g.items.sort((a, b) => sentAt(a).localeCompare(sentAt(b)));
  const oldest = (g: ReadyGroup) => sentAt(g.items[0]);
  list.sort((a, b) => oldest(a).localeCompare(oldest(b)));
  const mine = list.filter((g) => g.mine);
  return {
    mine,
    others: list.filter((g) => !g.mine),
    mineCount: mine.reduce((n, g) => n + g.items.length, 0),
    total: list.reduce((n, g) => n + g.items.length, 0),
    unknownTickets: [...unknown],
  };
}

import type { KdsItem, KdsTicket } from '../../components/KdsTicketCard';
import type { LineItemStatus, QueueItem, Station } from '../../domain/types';

/** KITCHEN_STAFF -> KITCHEN, BAR_STAFF -> BAR. Managers/admins pick a station themselves (null). */
export function stationForRole(role: string | null | undefined): Station | null {
  if (role === 'KITCHEN_STAFF') return 'KITCHEN';
  if (role === 'BAR_STAFF') return 'BAR';
  return null;
}

export type AdvanceTarget = 'IN_PROGRESS' | 'READY';

/** Next single step for a tap on an item. READY has none: SERVED is a separate, explicit action. */
export function nextStatus(s: LineItemStatus): AdvanceTarget | null {
  if (s === 'SENT') return 'IN_PROGRESS';
  if (s === 'IN_PROGRESS') return 'READY';
  return null;
}

/** The server accepts any status; the client allows only SENT>IN_PROGRESS>READY>SERVED, one step, never backwards. */
export function canTransition(from: LineItemStatus, to: LineItemStatus): boolean {
  return (from === 'SENT' && to === 'IN_PROGRESS') || (from === 'IN_PROGRESS' && to === 'READY') || (from === 'READY' && to === 'SERVED');
}

/** "Todo listo": every non-READY item to READY; SENT items need two sequential PATCHes. */
export function allReadyPlan(items: readonly { id: string; status: LineItemStatus }[]): { id: string; steps: AdvanceTarget[] }[] {
  const plan: { id: string; steps: AdvanceTarget[] }[] = [];
  for (const i of items) {
    if (i.status === 'SENT') plan.push({ id: i.id, steps: ['IN_PROGRESS', 'READY'] });
    else if (i.status === 'IN_PROGRESS') plan.push({ id: i.id, steps: ['READY'] });
  }
  return plan;
}

export interface KdsGroup extends KdsTicket {
  ticketId: string;
}

const ACTIVE: readonly string[] = ['SENT', 'IN_PROGRESS', 'READY'];
const ts = (iso: string | null | undefined) => {
  const n = iso ? new Date(iso).getTime() : NaN;
  return Number.isNaN(n) ? Infinity : n;
};

/** Group queue lines by ticket; oldest ticket first; voided/served lines never shown. */
export function groupQueue(items: readonly QueueItem[], noTableLabel: string): KdsGroup[] {
  const byTicket = new Map<string, QueueItem[]>();
  for (const i of items) {
    if (!ACTIVE.includes(i.status)) continue;
    const list = byTicket.get(i.ticket_id);
    if (list) list.push(i);
    else byTicket.set(i.ticket_id, [i]);
  }
  const groups: KdsGroup[] = [];
  for (const [ticketId, lines] of byTicket) {
    lines.sort((a, b) => ts(a.sent_at) - ts(b.sent_at) || a.id.localeCompare(b.id));
    const pending = lines.filter((l) => l.status !== 'READY');
    const basis = pending.length ? pending : lines; // all READY: keep showing the age since the oldest send
    const oldest = Math.min(...basis.map((l) => ts(l.sent_at)));
    const kdsItems: KdsItem[] = lines.map((l) => ({
      id: l.id,
      quantity: l.quantity,
      name: l.menu_item_name,
      modifiers: (l.modifiers ?? []).map((m) => m.name),
      note: l.notes,
      status: l.status as KdsItem['status'],
    }));
    groups.push({
      ticketId,
      code: lines[0].resource_code ?? noTableLabel,
      items: kdsItems,
      oldestSentAt: Number.isFinite(oldest) ? new Date(oldest).toISOString() : '',
    });
  }
  groups.sort((a, b) => ts(a.oldestSentAt) - ts(b.oldestSentAt) || a.ticketId.localeCompare(b.ticketId));
  return groups;
}

/** Ids present in `next` but not in `prev` (new orders to highlight). */
export function newItemIds(prev: readonly { id: string }[], next: readonly { id: string }[]): string[] {
  const seen = new Set(prev.map((i) => i.id));
  return next.filter((i) => !seen.has(i.id)).map((i) => i.id);
}

export function pendingCount(items: readonly { status: LineItemStatus }[]): number {
  return items.filter((i) => i.status === 'SENT' || i.status === 'IN_PROGRESS').length;
}

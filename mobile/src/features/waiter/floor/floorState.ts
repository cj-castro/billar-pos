import type { Resource, ResourceType, Ticket } from '../../../domain/types';
import type { TableState } from '../../../theme/tokens';

export type FloorKind = 'POOL' | 'TABLE' | 'BAR';

export interface FloorCard {
  resource: Resource;
  kind: FloorKind;
  state: TableState;
  /** Ticket to open on tap (occupied / bill requested). */
  ticketId: string | null;
  customerName: string | null;
  /** Running pool timer only (stops when the bill is requested). */
  timerStart: string | null;
}

export interface FloorSection {
  kind: FloorKind;
  cards: FloorCard[];
  occupied: number;
  bills: number;
}

export interface FloorModel {
  sections: FloorSection[];
  /** Every OPEN ticket with the bill requested (pool tables are AVAILABLE again while these stay OPEN). */
  pendingBills: Ticket[];
}

const KIND: Record<ResourceType, FloorKind> = { POOL_TABLE: 'POOL', REGULAR_TABLE: 'TABLE', BAR_SEAT: 'BAR' };
export const FLOOR_ORDER: FloorKind[] = ['POOL', 'TABLE', 'BAR'];

/** Natural order: BT2 before BT10. */
const byCode = (a: Resource, b: Resource) => a.code.localeCompare(b.code, 'es', { numeric: true, sensitivity: 'base' });
export const bySortThenCode = (a: Resource, b: Resource) => (a.sort_order ?? 0) - (b.sort_order ?? 0) || byCode(a, b);

/**
 * Table state, derived (matrix section 2). A pending-payment ticket wins over the resource status because
 * request-payment frees a POOL table (status AVAILABLE) while the ticket stays OPEN (G11).
 */
export function deriveCard(r: Resource, pending: readonly Ticket[]): FloorCard {
  const bill = pending.find((t) => (!!r.id && t.resource_id === r.id) || (!!r.active_ticket_id && t.id === r.active_ticket_id));
  let state: TableState;
  if (r.status === 'INACTIVE' || r.is_active === false) state = 'INACTIVE';
  else if (bill) state = 'BILL_REQUESTED';
  else if (r.status === 'IN_USE' || r.active_ticket_id) state = 'OCCUPIED';
  else state = 'FREE';
  const ticketId = state === 'BILL_REQUESTED' ? (bill?.id ?? r.active_ticket_id ?? null) : (r.active_ticket_id ?? null);
  return {
    resource: r,
    kind: KIND[r.type] ?? 'TABLE',
    state,
    ticketId,
    customerName: bill?.customer_name ?? r.customer_name ?? null,
    // The server stops the timer on request-payment: never show a running clock for a billed-out table.
    timerStart: state === 'OCCUPIED' && r.type === 'POOL_TABLE' ? (r.timer_start ?? null) : null,
  };
}

export function deriveFloor(resources: readonly Resource[], pending: readonly Ticket[]): FloorModel {
  const cards = [...resources].sort(bySortThenCode).map((r) => deriveCard(r, pending));
  const sections = FLOOR_ORDER.map((kind): FloorSection => {
    const list = cards.filter((c) => c.kind === kind);
    return {
      kind,
      cards: list,
      occupied: list.filter((c) => c.state === 'OCCUPIED').length,
      bills: list.filter((c) => c.state === 'BILL_REQUESTED').length,
    };
  }).filter((s) => s.cards.length > 0);
  return { sections, pendingBills: [...pending].sort((a, b) => (b.payment_requested_at ?? '').localeCompare(a.payment_requested_at ?? '')) };
}

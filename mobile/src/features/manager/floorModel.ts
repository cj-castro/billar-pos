import type { Resource, Ticket } from '../../domain/types';
import type { TableState } from '../../theme/tokens';

export type FloorKind = 'POOL' | 'TABLE' | 'BAR';
export interface FloorTile {
  id: string;
  code: string;
  kind: FloorKind;
  state: TableState;
  customerName: string | null;
  timerStart: string | null;
  ticketId: string | null;
}

const KIND: Record<Resource['type'], FloorKind> = { POOL_TABLE: 'POOL', REGULAR_TABLE: 'TABLE', BAR_SEAT: 'BAR' };

/** Resource + pending-payment tickets -> read-only tiles (BILL_REQUESTED wins over OCCUPIED). Sorted by sort_order. */
export function floorTiles(resources: readonly Resource[], pending: readonly Pick<Ticket, 'id' | 'resource_id'>[]): FloorTile[] {
  const billResources = new Set(pending.map((p) => p.resource_id).filter(Boolean));
  return [...resources]
    .sort((a, b) => a.sort_order - b.sort_order || a.code.localeCompare(b.code))
    .map((r) => {
      let state: TableState;
      if (!r.is_active || r.status === 'INACTIVE') state = 'INACTIVE';
      else if (billResources.has(r.id)) state = 'BILL_REQUESTED';
      else state = r.status === 'IN_USE' ? 'OCCUPIED' : 'FREE';
      return {
        id: r.id,
        code: r.code,
        kind: KIND[r.type] ?? 'TABLE',
        state,
        customerName: r.customer_name ?? null,
        timerStart: r.timer_start ?? null,
        ticketId: r.active_ticket_id ?? null,
      };
    });
}

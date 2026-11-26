import type { QueueItem } from '../../domain/types';

let n = 0;
/** Queue line as returned by GET /queue/kitchen|bar. */
export function qi(over: Partial<QueueItem> & { id: string }): QueueItem {
  n += 1;
  return {
    ticket_id: 't1',
    menu_item_id: `m${n}`,
    menu_item_name: 'Nachos',
    quantity: 1,
    unit_price_cents: 10000,
    promo_discount_cents: 0,
    net_cents: 10000,
    promotions: [],
    status: 'SENT',
    routing_dest: 'KITCHEN',
    sent_at: '2026-11-05T20:00:00+00:00',
    served_at: null,
    voided_at: null,
    void_reason: null,
    notes: null,
    needs_reprint: false,
    modifiers: [],
    resource_code: 'M1',
    ...over,
  };
}

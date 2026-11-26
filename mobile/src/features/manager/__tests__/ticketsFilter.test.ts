import type { OpenTicketRow } from '../../../api/endpoints/managerTickets';
import type { Ticket } from '../../../domain/types';
import { isMexicoToday, mexicoDay } from '../mexDate';
import { finishedRows, openRows } from '../ticketsModel';

// 2026-11-06 03:00 UTC = 2026-11-05 21:00 in Mexico City (UTC-6)
const NOW = Date.parse('2026-11-06T03:00:00Z');

const t = (over: Partial<Ticket>): Ticket =>
  ({ id: 'x', ticket_type: 'TABLE', resource_id: 'r', resource_code: 'M1', status: 'CLOSED', opened_by: 'user-1234567', opened_at: '2026-11-05T20:00:00Z', closed_at: '2026-11-06T01:00:00Z', total_cents: 5000, customer_name: null, ...over }) as Ticket;

describe('Mexico day', () => {
  it('uses the venue calendar day, not UTC', () => {
    expect(mexicoDay(NOW)).toBe('2026-11-05');
    expect(isMexicoToday('2026-11-06T01:00:00Z', NOW)).toBe(true); // 19:00 Mexico, still the 5th
    expect(isMexicoToday('2026-11-06T05:59:00Z', NOW)).toBe(true); // 23:59 Mexico
    expect(isMexicoToday('2026-11-06T06:00:00Z', NOW)).toBe(false); // 00:00 on the 6th
    expect(isMexicoToday('2026-11-05T05:59:00Z', NOW)).toBe(false); // 23:59 on the 4th
    expect(isMexicoToday(null, NOW)).toBe(false);
  });
});

describe('finishedRows', () => {
  it('closed today: only CLOSED with closed_at on the Mexico date, newest first, waiter = opened_by', () => {
    const rows = finishedRows(
      [
        t({ id: 'old', closed_at: '2026-11-05T05:00:00Z' }), // 4th in Mexico
        t({ id: 'a', closed_at: '2026-11-06T00:00:00Z' }),
        t({ id: 'b', closed_at: '2026-11-06T02:00:00Z' }),
        t({ id: 'c', status: 'CANCELLED', closed_at: '2026-11-06T02:00:00Z' }),
      ],
      'CLOSED',
      NOW,
    );
    expect(rows.map((r) => r.id)).toEqual(['b', 'a']);
    expect(rows[0]).toMatchObject({ code: 'M1', totalCents: 5000, waiter: 'user-1234567', bill: false });
  });

  it('cancelled falls back to opened_at when closed_at is missing; express has no code', () => {
    const rows = finishedRows([t({ id: 'k', status: 'CANCELLED', closed_at: null, opened_at: '2026-11-06T01:30:00Z', resource_code: null, ticket_type: 'EXPRESS' })], 'CANCELLED', NOW);
    expect(rows).toHaveLength(1);
    expect(rows[0].code).toBeNull();
  });
});

describe('openRows', () => {
  const open = (id: string, at: string): OpenTicketRow => ({ id, resource_code: id.toUpperCase(), resource_status: 'IN_USE', customer_name: null, opened_at: at, item_count: 1, total_cents: 100 });
  it('bills filter keeps only requested bills; waiter comes from the opened_by map', () => {
    const rows = [open('a', '2026-11-05T20:00:00Z'), open('b', '2026-11-05T19:00:00Z')];
    const waiters = new Map([['a', 'u-9']]);
    expect(openRows(rows, new Set(['a']), waiters, 'bills').map((r) => [r.id, r.bill, r.waiter])).toEqual([['a', true, 'u-9']]);
    expect(openRows(rows, new Set(['a']), waiters, 'all').map((r) => r.id)).toEqual(['b', 'a']);
    expect(openRows(rows, new Set(), waiters, 'all')[0].waiter).toBeNull();
  });
});
